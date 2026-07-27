/**
 * Official OKX Onchain OS Payment SDK integration for EVIDIQ Atlas.
 *
 * Verification and settlement of every paid tool call run through the official
 * SDK (`@okxweb3/x402-core` + `@okxweb3/x402-evm`) against the OKX facilitator,
 * which authenticates with HMAC-SHA256 using the Developer Portal credentials.
 *
 * Atlas keeps ownership of routing, per-tool pricing, and report/anchor logic;
 * the SDK owns the payment protocol. Prices stay explicit USD₮0 atomic amounts
 * (an `AssetAmount` price), so the quoted fee token always matches the token
 * registered for the OKX service listing.
 */
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import type {
  PaymentPayload as SdkPaymentPayload,
  PaymentRequirements as SdkPaymentRequirements,
} from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import type { AtlasConfig, OkxCredentials } from "./config.js";
import type { PaymentVerifier } from "./facilitator.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "./types.js";

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function transactionHash(value: unknown): string | undefined {
  return typeof value === "string" && TRANSACTION_HASH_PATTERN.test(value)
    ? value
    : undefined;
}

function reason(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return undefined;
}

/** Bounded confirmation polling for a broadcast-but-unconfirmed settlement. */
const SETTLE_POLL_INTERVAL_MS = 2_000;
const SETTLE_POLL_DEADLINE_MS = 24_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Payment verifier backed by the official OKX Payment SDK.
 *
 * `syncSettle` is enabled by default so the facilitator waits for on-chain
 * confirmation and answers `status: "success"`, keeping settlement strictly
 * before any paid analysis.
 *
 * When the facilitator's own wait elapses it answers `timeout` even though the
 * transaction it broadcast can still confirm moments later. Treating that as a
 * final failure would charge the payer and deliver nothing, so a timeout with a
 * transaction hash is resolved through the facilitator's settlement-status
 * lookup. Success is only ever claimed when the facilitator confirms it.
 */
export class OkxSdkVerifier implements PaymentVerifier {
  private readonly client: OKXFacilitatorClient;
  private readonly server: x402ResourceServer;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly cfg: AtlasConfig,
    credentials: OkxCredentials
  ) {
    this.client = new OKXFacilitatorClient({
      apiKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      passphrase: credentials.passphrase,
      baseUrl: credentials.baseUrl,
      syncSettle: credentials.syncSettle,
    });
    this.server = new x402ResourceServer(this.client);
    this.server.register(cfg.network as `${string}:${string}`, new ExactEvmScheme());
  }

  /** Fetch the facilitator's supported kinds once, and reuse the result. */
  private initialize(): Promise<void> {
    const pending =
      this.ready ??
      this.server.initialize().catch((error: unknown) => {
        // Allow a later call to retry instead of caching a failed handshake.
        this.ready = null;
        throw error;
      });
    this.ready = pending;
    return pending;
  }

  /**
   * Build the SDK-generated payment requirements for one paid tool call. The
   * price is an explicit USD₮0 asset amount, never a USD string, so the asset
   * cannot be substituted by conversion.
   */
  async buildRequirements(amount: bigint): Promise<SdkPaymentRequirements[]> {
    if (amount < 0n) throw new Error("x402 amount cannot be negative");
    await this.initialize();
    return this.server.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          network: this.cfg.network as `${string}:${string}`,
          payTo: this.cfg.payTo,
          price: {
            asset: this.cfg.asset,
            amount: amount.toString(),
            extra: {
              name: this.cfg.domainName,
              version: this.cfg.domainVersion,
            },
          },
          maxTimeoutSeconds: 300,
        },
      ],
      undefined
    );
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult> {
    await this.initialize();
    const verdict = await this.server.verifyPayment(
      payment as unknown as SdkPaymentPayload,
      requirements as unknown as SdkPaymentRequirements
    );
    if (!verdict.isValid) {
      return {
        valid: false,
        reason:
          reason(verdict.invalidReason, verdict.invalidMessage) ??
          "the OKX facilitator rejected the payment",
      };
    }
    const payer = verdict.payer ?? payment.payload.authorization.from;
    return { valid: true, payer: payer as `0x${string}` };
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult> {
    const fallbackPayer = payment.payload.authorization.from;
    await this.initialize();

    let response;
    try {
      response = await this.server.settlePayment(
        payment as unknown as SdkPaymentPayload,
        requirements as unknown as SdkPaymentRequirements
      );
    } catch (error) {
      // The settle call may have been broadcast; never assume it failed cleanly.
      return {
        status: "ambiguous",
        success: false,
        payer: fallbackPayer,
        errorReason: `OKX facilitator settlement ended without a definitive response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const payer = response.payer ?? fallbackPayer;
    const transaction = transactionHash(response.transaction);

    if (response.status === "pending" || response.status === "timeout") {
      if (!transaction) {
        return {
          status: "ambiguous",
          success: false,
          payer,
          errorReason: `the OKX facilitator reported settlement ${response.status} without a transaction hash`,
        };
      }
      return this.awaitSettlement(transaction, payer, response.status);
    }

    if (!response.success) {
      return {
        status: "failed",
        success: false,
        transaction,
        payer,
        errorReason:
          reason(response.errorReason, response.errorMessage) ??
          "the OKX facilitator settlement failed",
      };
    }

    // A settled response with no transaction hash used to be refused here, on the
    // reasoning that success needs on-chain evidence. That was wrong, and it cost a
    // listing: the facilitator is the authority on whether a payment settled, so
    // refusing means denying service for a payment the payer has already made. It is
    // exactly what OKX's reviewer saw — their paid calls came back 402, which their
    // report described as the service not being integrated with the SDK. Honour the
    // facilitator's verdict, and make the missing hash visible instead of fatal.
    if (BigInt(requirements.amount) > 0n && !transaction) {
      console.warn(
        `[x402] SETTLED WITHOUT TX the OKX facilitator reported success with no settlement transaction` +
          ` amount=${requirements.amount} payer=${payer}`
      );
    }

    return {
      status: "settled",
      success: true,
      transaction: transaction ?? "",
      payer,
    };
  }

  /**
   * Poll the facilitator's settlement-status lookup until the broadcast
   * transaction is confirmed, rejected, or the deadline elapses. Polling never
   * re-settles, so it cannot double-charge the payer. An unresolved result stays
   * `pending` so the caller can retry with the same authorization.
   */
  private async awaitSettlement(
    transaction: string,
    payer: string,
    facilitatorStatus: "pending" | "timeout"
  ): Promise<SettleResult> {
    const unresolved: SettleResult = {
      status: "pending",
      success: false,
      transaction,
      payer,
      errorReason: `the OKX facilitator reported settlement ${facilitatorStatus}; retry with the same authorization`,
    };
    if (!this.client.getSettleStatus) return unresolved;

    const deadline = Date.now() + SETTLE_POLL_DEADLINE_MS;
    let lastPayer = payer;
    while (Date.now() < deadline) {
      let status;
      try {
        status = await this.client.getSettleStatus(transaction);
      } catch {
        // A status lookup failure is transient; keep the known hash and retry.
        await sleep(SETTLE_POLL_INTERVAL_MS);
        continue;
      }
      lastPayer = status.payer ?? lastPayer;
      if (status.status === "success" || status.success === true) {
        return { status: "settled", success: true, transaction, payer: lastPayer };
      }
      if (status.status === "failed" || status.success === false) {
        return {
          status: "failed",
          success: false,
          transaction,
          payer: lastPayer,
          errorReason:
            reason(status.errorReason, status.errorMessage) ??
            "the OKX facilitator reported the settlement failed",
        };
      }
      await sleep(SETTLE_POLL_INTERVAL_MS);
    }
    return { ...unresolved, payer: lastPayer };
  }

  /**
   * Resolve a previously pending settlement through the facilitator's status
   * lookup. A lookup never re-settles and never discards the known hash.
   */
  async checkSettlement(
    _payment: PaymentPayload,
    _requirements: PaymentRequirements,
    settlement: Extract<SettleResult, { status: "pending" }>
  ): Promise<SettleResult> {
    if (!this.client.getSettleStatus) return settlement;

    const status = await this.client.getSettleStatus(settlement.transaction);
    const payer = status.payer ?? settlement.payer;
    const transaction = transactionHash(status.transaction) ?? settlement.transaction;

    if (status.status === "pending") {
      return { ...settlement, payer, transaction };
    }
    if (status.status === "failed" || status.success === false) {
      return {
        status: "failed",
        success: false,
        transaction,
        payer,
        errorReason:
          reason(status.errorReason, status.errorMessage) ??
          "the OKX facilitator reported the settlement failed",
      };
    }
    if (status.success === true) {
      return { status: "settled", success: true, transaction, payer };
    }
    return { ...settlement, payer, transaction };
  }
}
