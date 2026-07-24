import {
  FREE_TOOL_NAMES,
  PAID_TOOL_NAMES,
  TOOL_PRICES,
  type AtlasConfig,
} from "./config.js";
import type {
  PaymentRequirements,
  PaymentResponseHeader,
  X402Challenge,
  X402Resource,
} from "./types.js";

const FREE_VALIDATION_ADVICE =
  "Before paying, call the free validate_dataset_source tool first; atlas_capabilities and estimate_cost are also free.";

const RESOURCE_DESCRIPTION =
  "EVIDIQ Atlas — x402-gated dataset profiling, querying, visualization, comparison, and research. Validate a dataset source for free before purchasing analysis.";

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Resource URLs are deliberately sourced only from PUBLIC_BASE_URL config. */
export function buildResource(cfg: AtlasConfig): X402Resource {
  return {
    url: `${cfg.publicBaseUrl.replace(/\/+$/, "")}/mcp`,
    description: RESOURCE_DESCRIPTION,
    mimeType: "application/json",
  };
}

export function buildAccepts(
  cfg: AtlasConfig,
  amountOverride: bigint = TOOL_PRICES.profile_dataset
): PaymentRequirements[] {
  if (amountOverride < 0n) throw new Error("x402 amount cannot be negative");
  return [
    {
      scheme: "exact",
      network: cfg.network,
      asset: cfg.asset,
      amount: amountOverride.toString(),
      payTo: cfg.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: cfg.domainName, version: cfg.domainVersion },
    },
  ];
}

export function buildChallenge(
  cfg: AtlasConfig,
  amountOverride?: bigint
): X402Challenge {
  return {
    x402Version: 2,
    resource: buildResource(cfg),
    accepts: buildAccepts(cfg, amountOverride),
  };
}

function paymentRequiredHeader(
  cfg: AtlasConfig,
  amountOverride?: bigint
): string {
  return encodeBase64Json(buildChallenge(cfg, amountOverride));
}

/**
 * The resourceUrl parameter is retained for sibling-module compatibility but
 * intentionally ignored: forwarded request URLs must never shape a challenge.
 */
export function build402Response(
  cfg: AtlasConfig,
  _resourceUrl: string = cfg.publicBaseUrl,
  error?: string,
  amountOverride?: bigint
): Response {
  const message = error
    ? `${error} ${FREE_VALIDATION_ADVICE}`
    : `Payment required. Sign the x402 v2 exact challenge from the PAYMENT-REQUIRED header and retry with a base64 PAYMENT-SIGNATURE envelope. ${FREE_VALIDATION_ADVICE}`;
  return new Response(
    JSON.stringify({
      ...buildChallenge(cfg, amountOverride),
      error: message,
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "payment-required": paymentRequiredHeader(cfg, amountOverride),
      },
    }
  );
}

/** Discovery exposes all five paid and all five free tool prices. */
export function buildDiscoveryResponse(
  cfg: AtlasConfig,
  _resourceUrl: string = cfg.publicBaseUrl
): Response {
  const paidPricing = PAID_TOOL_NAMES.map((tool) => {
    const amount = TOOL_PRICES[tool];
    return {
      tool,
      amount: amount.toString(),
      usd: Number(amount) / 1_000_000,
    };
  });
  const freePricing = FREE_TOOL_NAMES.map((tool) => ({
    tool,
    amount: "0",
    usd: 0,
    free: true,
  }));

  const discovery = {
    ...buildChallenge(cfg),
    pricing: [...paidPricing, ...freePricing],
    guidance: FREE_VALIDATION_ADVICE,
  };

  return new Response(JSON.stringify(discovery, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "payment-required": paymentRequiredHeader(cfg),
    },
  });
}

export function encodePaymentResponseHeader(
  response: PaymentResponseHeader
): string {
  return encodeBase64Json(response);
}
