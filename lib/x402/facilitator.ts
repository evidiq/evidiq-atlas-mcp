import type { AtlasConfig } from "./config.js";
import { OnchainSettler } from "./settle.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "./types.js";
import { verifyPaymentLocal } from "./verify.js";

export interface PaymentVerifier {
  verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult>;
  settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult>;
  checkSettlement?(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
    settlement: Extract<SettleResult, { status: "pending" }>
  ): Promise<SettleResult>;
}

export class LocalVerifier implements PaymentVerifier {
  constructor(private readonly cfg: AtlasConfig) {}

  verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult> {
    return verifyPaymentLocal(payment, requirements, this.cfg);
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult> {
    const payer = payment.payload.authorization.from;
    if (BigInt(requirements.amount) === 0n) {
      return { status: "settled", success: true, transaction: "", payer };
    }
    return {
      status: "failed",
      success: false,
      payer,
      errorReason:
        "settlement is not configured; set X402_USE_FACILITATOR=1 or provide X402_SETTLE_KEY",
    };
  }
}

const FACILITATOR_PATHS = {
  verify: "/verify",
  settle: "/settle",
} as const;

type FacilitatorJson = Record<string, unknown>;
type FacilitatorPostResult =
  | {
      kind: "response";
      ok: boolean;
      status: number;
      json: FacilitatorJson | null;
    }
  | { kind: "ambiguous"; reason: string };

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function transactionHash(value: unknown): string | undefined {
  return typeof value === "string" && TRANSACTION_HASH_PATTERN.test(value)
    ? value
    : undefined;
}

function responseReason(
  json: FacilitatorJson | null,
  fallback: string
): string {
  if (!json) return fallback;
  return String(
    json.errorReason ?? json.invalidReason ?? json.reason ?? fallback
  );
}

export class FacilitatorClient implements PaymentVerifier {
  private readonly local: LocalVerifier;

  constructor(private readonly cfg: AtlasConfig) {
    this.local = new LocalVerifier(cfg);
  }

  private async post(
    path: string,
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<FacilitatorPostResult> {
    const base = this.cfg.facilitatorUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payment,
          paymentRequirements: requirements,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      let json: FacilitatorJson | null = null;
      try {
        const value: unknown = await response.json();
        if (value && typeof value === "object") {
          json = value as FacilitatorJson;
        }
      } catch {
        // Settlement treats an unparseable response as ambiguous below.
      }
      return {
        kind: "response",
        ok: response.ok,
        status: response.status,
        json,
      };
    } catch (error) {
      return {
        kind: "ambiguous",
        reason: `facilitator request ended without a definitive response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult> {
    const localVerdict = await this.local.verify(payment, requirements);
    if (!localVerdict.valid) return localVerdict;

    const result = await this.post(
      FACILITATOR_PATHS.verify,
      payment,
      requirements
    );
    if (result.kind === "ambiguous" || !result.ok || !result.json) {
      return localVerdict;
    }

    const valid =
      typeof result.json.isValid === "boolean"
        ? result.json.isValid
        : typeof result.json.valid === "boolean"
          ? result.json.valid
          : undefined;
    if (valid === undefined) return localVerdict;
    return valid
      ? localVerdict
      : {
          valid: false,
          reason: responseReason(result.json, "facilitator rejected payment"),
        };
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult> {
    const payer = payment.payload.authorization.from;
    const localVerdict = await this.local.verify(payment, requirements);
    if (!localVerdict.valid) {
      return {
        status: "failed",
        success: false,
        payer,
        errorReason: localVerdict.reason,
      };
    }

    const result = await this.post(
      FACILITATOR_PATHS.settle,
      payment,
      requirements
    );
    if (result.kind === "ambiguous") {
      return {
        status: "ambiguous",
        success: false,
        payer,
        errorReason: result.reason,
      };
    }

    const json = result.json;
    if (!result.ok) {
      if (
        result.status < 500 &&
        json &&
        typeof json.success === "boolean" &&
        !json.success
      ) {
        return {
          status: "failed",
          success: false,
          payer,
          errorReason: responseReason(json, "facilitator settlement failed"),
        };
      }
      return {
        status: "ambiguous",
        success: false,
        payer,
        errorReason: responseReason(
          json,
          `facilitator settle endpoint returned HTTP ${result.status}`
        ),
      };
    }
    if (!json) {
      return {
        status: "ambiguous",
        success: false,
        payer,
        errorReason: "facilitator settlement response was empty or invalid",
      };
    }

    const transaction = transactionHash(json.transaction ?? json.txHash);
    const wireStatus =
      typeof json.status === "string" ? json.status.toLowerCase() : undefined;

    if (result.status === 202) {
      return wireStatus === "pending" && transaction
        ? {
            status: "pending",
            success: false,
            transaction,
            payer,
            errorReason: "facilitator reported settlement pending",
          }
        : {
            status: "ambiguous",
            success: false,
            transaction,
            payer,
            errorReason:
              "facilitator returned HTTP 202 without a definitive pending transaction",
          };
    }
    if (result.status !== 200 && result.status !== 201) {
      return {
        status: "ambiguous",
        success: false,
        transaction,
        payer,
        errorReason: `facilitator returned unexpected HTTP ${result.status}`,
      };
    }
    if (wireStatus === "pending") {
      return transaction
        ? {
            status: "pending",
            success: false,
            transaction,
            payer,
            errorReason: "facilitator reported settlement pending",
          }
        : {
            status: "ambiguous",
            success: false,
            payer,
            errorReason:
              "facilitator reported settlement pending without a valid transaction hash",
          };
    }
    if (
      wireStatus !== undefined &&
      wireStatus !== "settled" &&
      wireStatus !== "success" &&
      wireStatus !== "failed"
    ) {
      return {
        status: "ambiguous",
        success: false,
        transaction,
        payer,
        errorReason: `facilitator returned unknown settlement status "${wireStatus}"`,
      };
    }
    if (typeof json.success !== "boolean") {
      return {
        status: "ambiguous",
        success: false,
        transaction,
        payer,
        errorReason: "facilitator settlement response was ambiguous",
      };
    }
    if (!json.success) {
      if (wireStatus === "settled" || wireStatus === "success") {
        return {
          status: "ambiguous",
          success: false,
          transaction,
          payer,
          errorReason: "facilitator settlement response was contradictory",
        };
      }
      return {
        status: "failed",
        success: false,
        transaction,
        payer,
        errorReason: responseReason(json, "facilitator settlement failed"),
      };
    }
    if (wireStatus === "failed") {
      return {
        status: "ambiguous",
        success: false,
        transaction,
        payer,
        errorReason: "facilitator settlement response was contradictory",
      };
    }
    if (BigInt(requirements.amount) > 0n && !transaction) {
      return {
        status: "ambiguous",
        success: false,
        payer,
        errorReason:
          "facilitator reported success without a valid settlement transaction",
      };
    }
    return {
      status: "settled",
      success: true,
      transaction: transaction ?? "",
      payer,
    };
  }
}

export function getVerifier(cfg: AtlasConfig): PaymentVerifier {
  if (cfg.useFacilitator) return new FacilitatorClient(cfg);
  if (cfg.settleKey) return new OnchainSettler(cfg);
  return new LocalVerifier(cfg);
}
