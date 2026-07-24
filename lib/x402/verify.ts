import { recoverTypedDataAddress } from "viem";
import { z } from "zod";
import type { AtlasConfig } from "./config.js";
import type {
  AcceptedPaymentRequirements,
  Hex,
  PaymentPayload,
  PaymentRequirements,
  VerifyResult,
} from "./types.js";

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as Hex);
const uintSchema = z.string().regex(/^\d+$/);
const nonceSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const signatureSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/)
  .transform((value) => value as Hex);

const paymentEnvelopeSchema = z
  .object({
    x402Version: z.literal(2),
    accepted: z
      .object({
        scheme: z.literal("exact"),
        network: z.string(),
        asset: addressSchema,
        amount: uintSchema,
        payTo: addressSchema,
        maxTimeoutSeconds: z.number().int().nonnegative(),
        extra: z.object({
          name: z.string().min(1),
          version: z.string().min(1),
        }),
      })
      .passthrough(),
    payload: z
      .object({
        signature: signatureSchema,
        authorization: z.object({
          from: addressSchema,
          to: addressSchema,
          value: uintSchema,
          validAfter: uintSchema,
          validBefore: uintSchema,
          nonce: nonceSchema,
        }),
      })
      .passthrough(),
  })
  .passthrough();

/** Decode a base64 JSON x402 v2 exact PAYMENT-SIGNATURE envelope. */
export function decodePaymentHeader(req: Request): PaymentPayload | null {
  const raw = req.headers.get("payment-signature")?.trim();
  if (!raw) return null;

  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const json: unknown = JSON.parse(decoded);
    const parsed = paymentEnvelopeSchema.safeParse(json);
    if (!parsed.success) return null;

    const accepted = parsed.data.accepted as AcceptedPaymentRequirements;
    return {
      x402Version: 2,
      accepted,
      scheme: accepted.scheme,
      network: accepted.network,
      payload: parsed.data.payload,
    };
  } catch {
    return null;
  }
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const CLOCK_SKEW_SECONDS = 6n;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Verify the complete challenge and EIP-3009 typed-data signature locally. */
export async function verifyPaymentLocal(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  cfg: AtlasConfig
): Promise<VerifyResult> {
  if (payment.x402Version !== 2) {
    return { valid: false, reason: "unsupported x402 version (expected 2)" };
  }

  const accepted = payment.accepted;
  if (payment.scheme !== accepted.scheme || payment.network !== accepted.network) {
    return { valid: false, reason: "normalized payment fields do not match accepted" };
  }
  if (accepted.scheme !== requirements.scheme) {
    return { valid: false, reason: "accepted scheme does not match challenge" };
  }
  if (
    accepted.network !== requirements.network ||
    requirements.network !== cfg.network
  ) {
    return {
      valid: false,
      reason: `network mismatch: got ${accepted.network}, expected ${cfg.network}`,
    };
  }
  if (!sameAddress(requirements.asset, cfg.asset)) {
    return { valid: false, reason: "payment requirements asset mismatch" };
  }
  if (!sameAddress(requirements.payTo, cfg.payTo)) {
    return { valid: false, reason: "payment requirements payTo mismatch" };
  }
  if (!sameAddress(accepted.asset, requirements.asset)) {
    return { valid: false, reason: "accepted asset does not match challenge" };
  }
  if (accepted.amount !== requirements.amount) {
    return { valid: false, reason: "accepted amount does not match challenge" };
  }
  if (!sameAddress(accepted.payTo, requirements.payTo)) {
    return { valid: false, reason: "accepted payTo does not match challenge" };
  }
  if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    return { valid: false, reason: "accepted timeout does not match challenge" };
  }
  if (
    accepted.extra.name !== requirements.extra.name ||
    accepted.extra.version !== requirements.extra.version
  ) {
    return { valid: false, reason: "accepted token domain does not match challenge" };
  }

  const authorization = payment.payload.authorization;
  if (!sameAddress(authorization.to, requirements.payTo)) {
    return {
      valid: false,
      reason: `payTo mismatch: got ${authorization.to}, expected ${requirements.payTo}`,
    };
  }

  let value: bigint;
  let required: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(authorization.value);
    required = BigInt(requirements.amount);
    validAfter = BigInt(authorization.validAfter);
    validBefore = BigInt(authorization.validBefore);
  } catch {
    return { valid: false, reason: "authorization contains an invalid integer" };
  }

  if (value !== required) {
    return {
      valid: false,
      reason: `value ${authorization.value} does not exactly match required ${requirements.amount}`,
    };
  }
  if (validBefore <= validAfter) {
    return { valid: false, reason: "authorization validity window is invalid" };
  }

  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (validAfter > now + CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "authorization not yet valid (validAfter)" };
  }
  if (validBefore <= now - CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "authorization expired (validBefore)" };
  }
  const maximumLifetime = BigInt(requirements.maxTimeoutSeconds);
  if (validBefore - validAfter > maximumLifetime) {
    return {
      valid: false,
      reason: "authorization lifetime exceeds challenge maxTimeoutSeconds",
    };
  }
  const latestValidBefore = now + maximumLifetime + CLOCK_SKEW_SECONDS;
  if (validBefore > latestValidBefore) {
    return {
      valid: false,
      reason: "authorization validBefore exceeds challenge maxTimeoutSeconds",
    };
  }

  let recovered: Hex;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: cfg.domainName,
        version: cfg.domainVersion,
        chainId: cfg.chainId,
        verifyingContract: cfg.asset,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce,
      },
      signature: payment.payload.signature,
    });
  } catch {
    return { valid: false, reason: "signature recovery failed" };
  }

  if (!sameAddress(recovered, authorization.from)) {
    return {
      valid: false,
      reason: `signer ${recovered} does not match authorization.from ${authorization.from}`,
    };
  }

  return { valid: true, payer: authorization.from };
}
