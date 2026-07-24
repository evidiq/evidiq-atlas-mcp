import { z } from "zod";

export const XLAYER_NETWORK = "eip155:196" as const;
export const XLAYER_USDT0 =
  "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;
export const XLAYER_RPC_URL = "https://rpc.xlayer.tech";
export const DEFAULT_FACILITATOR_URL = "https://web3.okx.com";
export const DEFAULT_PUBLIC_BASE_URL = "https://mcp.evidiq.dev/atlas";

// Same chain-slug resolution the sibling EVIDIQ MCPs use, so X402_CHAIN and
// X402_NETWORK are interchangeable and accept either a slug or a CAIP-2 value.
const CHAIN_SLUGS: Record<string, string> = {
  "x-layer": "eip155:196",
  xlayer: "eip155:196",
  "x-layer-mainnet": "eip155:196",
  "x-layer-testnet": "eip155:1952",
  "xlayer-testnet": "eip155:1952",
};

function resolveNetwork(): string | undefined {
  const raw = (process.env.X402_NETWORK ?? process.env.X402_CHAIN)?.trim();
  if (!raw) return undefined;
  if (/^eip155:\d+$/.test(raw)) return raw;
  return CHAIN_SLUGS[raw.toLowerCase()];
}

/** Prices are fixed atomic USD₮0 units and cannot be overridden by env. */
export const TOOL_PRICES = Object.freeze({
  profile_dataset: 5_000n,
  query_dataset: 10_000n,
  visualize_dataset: 15_000n,
  compare_datasets: 20_000n,
  research_dataset: 30_000n,
} as const);

export type PaidToolName = keyof typeof TOOL_PRICES;

export const PAID_TOOL_NAMES = Object.freeze([
  "profile_dataset",
  "query_dataset",
  "visualize_dataset",
  "compare_datasets",
  "research_dataset",
] as const satisfies readonly PaidToolName[]);

export const FREE_TOOL_NAMES = Object.freeze([
  "atlas_capabilities",
  "validate_dataset_source",
  "estimate_cost",
  "verify_atlas_report",
  "get_artifact",
] as const);

export type FreeToolName = (typeof FREE_TOOL_NAMES)[number];

export const PAID_TOOLS: ReadonlySet<string> = new Set(PAID_TOOL_NAMES);
export const FREE_TOOLS: ReadonlySet<string> = new Set(FREE_TOOL_NAMES);

const AtlasConfigSchema = z.object({
  network: z
    .string()
    .regex(/^eip155:\d+$/, "network must resolve to CAIP-2, e.g. eip155:196"),
  asset: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "X402_ASSET must be a 0x... token address"),
  payTo: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "X402_PAY_TO must be a 0x... address"),
  domainName: z.string().min(1),
  domainVersion: z.string().min(1),
  facilitatorUrl: z.string().url(),
  rpcUrl: z.string().url(),
  publicBaseUrl: z.string().url(),
  settleKey: z
    .string()
    .regex(
      /^0x[0-9a-fA-F]{64}$/,
      "X402_SETTLE_KEY must be a 0x... 32-byte private key"
    )
    .optional(),
  useFacilitator: z.boolean(),
});

export type AtlasConfig = {
  network: string;
  chainId: number;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  domainName: string;
  domainVersion: string;
  facilitatorUrl: string;
  rpcUrl: string;
  publicBaseUrl: string;
  settleKey?: `0x${string}`;
  useFacilitator: boolean;
};

/** Return the immutable price for a paid Atlas tool, or undefined otherwise. */
export function priceForTool(toolName: string): bigint | undefined {
  if (!PAID_TOOLS.has(toolName)) return undefined;
  return TOOL_PRICES[toolName as PaidToolName];
}

/**
 * Load Atlas x402 configuration, matching the sibling EVIDIQ MCPs. Leaving
 * X402_PAY_TO unset disables the gate and runs every tool free; once a payee is
 * configured the remaining values fall back to the X Layer / USD₮0 defaults.
 */
export function getAtlasConfig(): AtlasConfig | null {
  const payTo = process.env.X402_PAY_TO?.trim();
  if (!payTo) return null;

  const parsed = AtlasConfigSchema.safeParse({
    network: resolveNetwork() ?? XLAYER_NETWORK,
    asset: process.env.X402_ASSET?.trim() || XLAYER_USDT0,
    payTo,
    domainName: process.env.X402_DOMAIN_NAME?.trim() || "USD₮0",
    domainVersion: process.env.X402_DOMAIN_VERSION?.trim() || "1",
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL,
    rpcUrl:
      process.env.X402_RPC?.trim() ||
      process.env.X402_RPC_URL?.trim() ||
      XLAYER_RPC_URL,
    publicBaseUrl:
      process.env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL,
    settleKey: process.env.X402_SETTLE_KEY?.trim() || undefined,
    useFacilitator: process.env.X402_USE_FACILITATOR?.trim() === "1",
  });

  if (!parsed.success) {
    throw new Error(`Invalid Atlas x402 config: ${parsed.error.message}`);
  }

  return {
    ...parsed.data,
    asset: parsed.data.asset as `0x${string}`,
    payTo: parsed.data.payTo as `0x${string}`,
    settleKey: parsed.data.settleKey as `0x${string}` | undefined,
    chainId: Number(parsed.data.network.split(":")[1]),
  };
}
