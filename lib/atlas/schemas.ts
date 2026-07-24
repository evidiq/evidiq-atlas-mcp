import { z } from "zod";

const MEBIBYTE = 1024 * 1024;
const MAX_SUPPORTED_INLINE_BYTES = 50 * MEBIBYTE;
const MAX_SUPPORTED_REQUEST_BYTES = 128 * MEBIBYTE;
const REQUEST_ENVELOPE_BYTES = 2 * MEBIBYTE;

export const datasetFormatSchema = z.enum(["csv", "json", "ndjson", "parquet"]);
export type DatasetFormat = z.infer<typeof datasetFormatSchema>;

const datasetNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}_. -]+$/u, "name contains unsupported characters")
  .optional();

export const inlineDatasetSourceSchema = z.object({
  kind: z.literal("inline"),
  format: z.enum(["csv", "json", "ndjson"]),
  // This character ceiling supports the largest configurable byte limit;
  // ingestion remains authoritative because UTF-8 characters can use >1 byte.
  data: z.string().min(1).max(MAX_SUPPORTED_INLINE_BYTES),
  name: datasetNameSchema,
});

export const remoteDatasetSourceSchema = z.object({
  kind: z.literal("url"),
  format: datasetFormatSchema,
  url: z
    .string()
    .url()
    .max(2_048)
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    }, "url must use HTTP or HTTPS"),
  name: datasetNameSchema,
});

export const datasetSourceSchema = z.discriminatedUnion("kind", [
  inlineDatasetSourceSchema,
  remoteDatasetSourceSchema,
]);

export type InlineDatasetSource = z.infer<typeof inlineDatasetSourceSchema>;
export type RemoteDatasetSource = z.infer<typeof remoteDatasetSourceSchema>;
export type DatasetSource = z.infer<typeof datasetSourceSchema>;

export const columnNameSchema = z.string().trim().min(1).max(256);
export const chartTypeSchema = z.enum([
  "auto",
  "bar",
  "line",
  "scatter",
  "histogram",
  "box",
]);
export type ChartType = z.infer<typeof chartTypeSchema>;

export const aggregationSchema = z.enum(["count", "sum", "avg", "min", "max"]);
export type Aggregation = z.infer<typeof aggregationSchema>;

export const chartRequestSchema = z.object({
  type: chartTypeSchema.default("auto"),
  x: columnNameSchema,
  y: columnNameSchema.optional(),
  color: columnNameSchema.optional(),
  aggregation: aggregationSchema.optional(),
  title: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(5_000).default(500),
});
export type ChartRequest = z.infer<typeof chartRequestSchema>;

function positiveEnvInt(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

export type AtlasLimits = Readonly<{
  maxInlineBytes: number;
  maxRequestBytes: number;
  maxRemoteBytes: number;
  maxQueryRows: number;
  queryTimeoutMs: number;
  maxRedirects: number;
}>;

export function getAtlasLimits(): AtlasLimits {
  const maxInlineBytes = positiveEnvInt(
    "ATLAS_MAX_INLINE_BYTES",
    5 * MEBIBYTE,
    MAX_SUPPORTED_INLINE_BYTES,
  );
  const minimumRequestBytes = 2 * maxInlineBytes + REQUEST_ENVELOPE_BYTES;
  const maxRequestBytes = positiveEnvInt(
    "ATLAS_MAX_REQUEST_BYTES",
    minimumRequestBytes,
    MAX_SUPPORTED_REQUEST_BYTES,
  );
  if (maxRequestBytes < minimumRequestBytes) {
    throw new Error(
      `ATLAS_MAX_REQUEST_BYTES must be at least ${minimumRequestBytes} bytes (2 * ATLAS_MAX_INLINE_BYTES + 2 MiB)`,
    );
  }

  return Object.freeze({
    maxInlineBytes,
    maxRequestBytes,
    maxRemoteBytes: positiveEnvInt("ATLAS_MAX_REMOTE_BYTES", 25 * MEBIBYTE, 250 * MEBIBYTE),
    maxQueryRows: positiveEnvInt("ATLAS_MAX_QUERY_ROWS", 1_000, 10_000),
    queryTimeoutMs: positiveEnvInt("ATLAS_QUERY_TIMEOUT_MS", 30_000, 300_000),
    maxRedirects: positiveEnvInt("ATLAS_MAX_REDIRECTS", 3, 10),
  });
}
