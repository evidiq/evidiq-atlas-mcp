import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OgConfig } from "./config.js";

export type StorageResult =
  | Readonly<{ ok: true; root: string; tx: string }>
  | Readonly<{ ok: false; error: string }>;

const UPLOAD_TIMEOUT_MS = 30_000;

function candidates(cfg: OgConfig): string[] {
  const values = cfg.chainId === 16661
    ? [cfg.storageIndexer, "https://indexer-storage-turbo.0g.ai"]
    : [cfg.storageIndexer, "https://indexer-storage-testnet-turbo.0g.ai", "https://indexer-storage-testnet-standard.0g.ai"];
  return values.filter((value, index) => values.indexOf(value) === index);
}

function extract(result: unknown): { root: string; tx: string } | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  const root = typeof value.rootHash === "string" ? value.rootHash
    : Array.isArray(value.rootHashes) && typeof value.rootHashes[0] === "string" ? value.rootHashes[0] : "";
  const tx = typeof value.txHash === "string" ? value.txHash
    : Array.isArray(value.txHashes) && typeof value.txHashes[0] === "string" ? value.txHashes[0] : "";
  return root && tx ? { root, tx } : null;
}

export async function uploadJson(cfg: OgConfig, data: unknown, filename: string): Promise<StorageResult> {
  const operation = upload(cfg, data, filename);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<StorageResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `0G upload timed out after ${UPLOAD_TIMEOUT_MS}ms; the SDK operation may still finish remotely` }), UPLOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function upload(cfg: OgConfig, data: unknown, filename: string): Promise<StorageResult> {
  const [{ Indexer, ZgFile }, { ethers }] = await Promise.all([
    import("@0gfoundation/0g-storage-ts-sdk"),
    import("ethers"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "evidiq-atlas-og-"));
  const filePath = join(directory, filename.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  try {
    await writeFile(filePath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    const file = await ZgFile.fromFilePath(filePath);
    try {
      const provider = new ethers.JsonRpcProvider(cfg.storageRpc);
      const signer = new ethers.Wallet(cfg.privateKey, provider);
      let lastError = "0G upload failed across configured indexers";
      for (const endpoint of candidates(cfg)) {
        try {
          const indexer = new Indexer(endpoint);
          type UploadSigner = Parameters<typeof indexer.upload>[2];
          const [result, error] = await indexer.upload(
            file,
            cfg.storageRpc,
            signer as unknown as UploadSigner
          );
          if (error) { lastError = error.message; continue; }
          const parsed = extract(result);
          if (parsed) return { ok: true, ...parsed };
          lastError = "0G upload returned no complete root/transaction pair";
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      return { ok: false, error: lastError };
    } finally {
      await file.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function anchorBestEffort(data: unknown, filename: string): Promise<{ storageRoot?: string; storageTx?: string; storageNote?: string }> {
  try {
    const { getOgConfig } = await import("./config.js");
    const config = getOgConfig();
    if (!config) return { storageNote: "0G Storage not configured; local content-addressed artifact remains verifiable" };
    const result = await uploadJson(config, data, filename);
    return result.ok ? { storageRoot: result.root, storageTx: result.tx } : { storageNote: result.error };
  } catch (error) {
    return { storageNote: error instanceof Error ? error.message : String(error) };
  }
}
