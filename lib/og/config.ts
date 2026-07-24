import { privateKeyToAccount } from "viem/accounts";

export type OgConfig = Readonly<{
  privateKey: `0x${string}`;
  storageRpc: string;
  storageIndexer: string;
  chainId: number;
}>;

function validUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must be HTTPS`);
  return url.toString().replace(/\/$/, "");
}

export function getOgConfig(): OgConfig | null {
  const raw = process.env.OG_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("OG_PRIVATE_KEY must be a 32-byte EVM private key");
  try {
    privateKeyToAccount(privateKey);
  } catch {
    throw new Error("OG_PRIVATE_KEY must be a valid secp256k1 private key");
  }
  const chainId = Number(process.env.OG_CHAIN_ID || "16661");
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("OG_CHAIN_ID must be a positive integer");
  return {
    privateKey,
    chainId,
    storageRpc: validUrl("OG_STORAGE_RPC", "https://evmrpc.0g.ai"),
    storageIndexer: validUrl("OG_STORAGE_INDEXER", "https://indexer-storage-turbo.0g.ai"),
  };
}
