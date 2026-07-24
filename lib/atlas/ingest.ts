import { createHash } from "node:crypto";
import { datasetSourceSchema, getAtlasLimits, type DatasetSource } from "./schemas.js";
import { inspectSafeUrl, safeFetchDataset } from "../network/safe-fetch.js";
import type { AtlasDatasetReference } from "./report.js";

export type MaterializedDataset = Readonly<{
  name: string;
  format: DatasetSource["format"];
  bytes: Buffer;
  reference: AtlasDatasetReference;
  contentType: string;
}>;

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function defaultName(source: DatasetSource): string {
  if (source.name) return source.name;
  if (source.kind === "inline") return `inline.${source.format === "ndjson" ? "jsonl" : source.format}`;
  const pathname = new URL(source.url).pathname;
  return pathname.split("/").filter(Boolean).pop() || `dataset.${source.format}`;
}

function validatePayload(bytes: Buffer, format: DatasetSource["format"]): void {
  if (bytes.length === 0) throw new Error("Dataset is empty");
  if (format === "parquet") {
    if (bytes.length < 8 || bytes.subarray(0, 4).toString("ascii") !== "PAR1" || bytes.subarray(-4).toString("ascii") !== "PAR1") {
      throw new Error("Parquet payload is missing the PAR1 header/footer");
    }
    return;
  }
  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) throw new Error("Text dataset contains NUL bytes");
  if (format === "json") {
    JSON.parse(text);
  } else if (format === "ndjson") {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) throw new Error("NDJSON dataset contains no records");
    for (const [index, line] of lines.entries()) {
      try { JSON.parse(line); } catch { throw new Error(`NDJSON line ${index + 1} is invalid JSON`); }
    }
  } else if (!text.trim()) {
    throw new Error("CSV dataset contains no data");
  }
}

function safeSourceUrl(raw: string): { sourceUrl: string; sourceQueryRedacted: boolean } {
  const url = new URL(raw);
  const redacted = Boolean(url.search);
  url.search = "";
  url.hash = "";
  return { sourceUrl: url.toString(), sourceQueryRedacted: redacted };
}

export async function validateDatasetSource(sourceInput: unknown): Promise<Record<string, unknown>> {
  const parsed = datasetSourceSchema.safeParse(sourceInput);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  }
  const source = parsed.data;
  const limits = getAtlasLimits();
  try {
    if (source.kind === "inline") {
      const bytes = Buffer.from(source.data, "utf8");
      if (bytes.length > limits.maxInlineBytes) throw new Error(`Inline dataset exceeds ${limits.maxInlineBytes} bytes`);
      validatePayload(bytes, source.format);
      return { valid: true, kind: source.kind, format: source.format, bytes: bytes.length, digest: digest(bytes), fetchPerformed: false };
    }
    const inspection = await inspectSafeUrl(source.url);
    return {
      valid: true,
      kind: source.kind,
      format: source.format,
      normalizedUrl: safeSourceUrl(inspection.normalizedUrl).sourceUrl,
      resolvedAddresses: inspection.addresses.map(({ family }) => `IPv${family} public address`),
      fetchPerformed: false,
      note: "DNS and URL safety passed. The paid tool will still re-resolve, pin, fetch, size-check, and validate content.",
    };
  } catch (error) {
    return { valid: false, kind: source.kind, format: source.format, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function materializeDataset(sourceInput: unknown): Promise<MaterializedDataset> {
  const source = datasetSourceSchema.parse(sourceInput);
  const limits = getAtlasLimits();
  if (source.kind === "inline") {
    const bytes = Buffer.from(source.data, "utf8");
    if (bytes.length > limits.maxInlineBytes) throw new Error(`Inline dataset exceeds ${limits.maxInlineBytes} bytes`);
    validatePayload(bytes, source.format);
    return {
      name: defaultName(source),
      format: source.format,
      bytes,
      contentType: source.format === "csv" ? "text/csv" : "application/json",
      reference: { name: defaultName(source), format: source.format, digest: digest(bytes), bytes: bytes.length, sourceKind: "inline" },
    };
  }
  const fetched = await safeFetchDataset(source.url, source.format, {
    maxBytes: limits.maxRemoteBytes,
    timeoutMs: limits.queryTimeoutMs,
    maxRedirects: limits.maxRedirects,
  });
  validatePayload(fetched.bytes, source.format);
  const safeUrl = safeSourceUrl(fetched.finalUrl);
  return {
    name: defaultName(source),
    format: source.format,
    bytes: fetched.bytes,
    contentType: fetched.contentType,
    reference: {
      name: defaultName(source), format: source.format, digest: digest(fetched.bytes), bytes: fetched.bytes.length,
      sourceKind: "url", sourceUrl: safeUrl.sourceUrl, sourceQueryRedacted: safeUrl.sourceQueryRedacted,
    },
  };
}
