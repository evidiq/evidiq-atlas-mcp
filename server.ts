import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { AtlasEngine } from "./lib/atlas/engine.js";
import { materializeDataset, validateDatasetSource, type MaterializedDataset } from "./lib/atlas/ingest.js";
import { profileDataset, compareDatasets, researchDataset } from "./lib/atlas/analyze.js";
import { visualizeDataset } from "./lib/atlas/visualize.js";
import {
  aggregationSchema,
  chartTypeSchema,
  columnNameSchema,
  datasetSourceSchema,
  getAtlasLimits,
} from "./lib/atlas/schemas.js";
import {
  canonicalStringify,
  createAtlasReport,
  getAtlasSignerStatus,
  verifyAtlasReport,
  type AtlasReport,
  type JsonValue,
} from "./lib/atlas/report.js";
import { getArtifact, putJsonArtifact, type ArtifactKind, type ArtifactRecord } from "./lib/atlas/artifacts.js";
import { anchorBestEffort } from "./lib/og/storage.js";
import { getOgConfig } from "./lib/og/config.js";
import { sandboxStatuses } from "./lib/sandbox/e2b.js";
import { FREE_TOOL_NAMES, PAID_TOOL_NAMES, TOOL_PRICES } from "./lib/x402/config.js";

const ATLAS_INSTRUCTIONS = `EVIDIQ Atlas — deterministic dataset research, analysis, comparison, and visualization.

Use validate_dataset_source before paying. Paid tools accept inline CSV/JSON/NDJSON or safely fetched HTTP(S) CSV/JSON/NDJSON/Parquet. DuckDB executes in a fresh in-memory database with external access disabled after ingestion. query_dataset accepts only one read-only SELECT/CTE statement. Atlas never exposes arbitrary Python, JavaScript, shell, extension installation, database attachment, or generic code execution.

Five free tools: atlas_capabilities, validate_dataset_source, estimate_cost, verify_atlas_report, get_artifact.
Five x402-paid tools: profile_dataset (0.005 USDT0), query_dataset (0.01), visualize_dataset (0.015), compare_datasets (0.02), research_dataset (0.03). Payment allocates the analysis attempt and settles before work begins; validate inputs first.`;

const paidToolSchema = z.enum(PAID_TOOL_NAMES);
const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expectedSigner must be a 20-byte EVM address");
const artifactIdSchema = z
  .string()
  .regex(
    /^atlas_(?:report|chart|query|research|comparison|profile)_[0-9a-f]{64}$/,
    "artifactId must be an exact Atlas content ID",
  );
const reportArtifactIdSchema = z
  .string()
  .regex(/^atlas_report_[0-9a-f]{64}$/, "artifactId must be an Atlas report content ID");

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalStringify(value)) as JsonValue;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function artifactReference(artifact: ArtifactRecord) {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    digest: artifact.digest,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
  };
}

async function withEngine<T>(datasets: Readonly<Record<string, MaterializedDataset>>, callback: (engine: AtlasEngine) => Promise<T>): Promise<T> {
  const engine = await AtlasEngine.create(datasets);
  try { return await callback(engine); } finally { await engine.close(); }
}

async function buildReport(
  tool: string,
  datasets: readonly MaterializedDataset[],
  request: unknown,
  result: unknown,
  options: Readonly<{
    methods: readonly string[];
    assumptions?: readonly string[];
    warnings?: readonly string[];
    sql?: string;
    rowLimit?: number;
    deterministic?: boolean;
  }>
): Promise<AtlasReport> {
  return createAtlasReport({
    tool,
    engine: { name: "DuckDB", version: AtlasEngine.version() },
    datasets: datasets.map((dataset) => dataset.reference),
    request: asJson(request),
    result: asJson(result),
    methods: options.methods,
    assumptions: options.assumptions ?? [],
    warnings: options.warnings ?? [],
    reproducibility: {
      deterministic: options.deterministic ?? true,
      sourceDigests: datasets.map((dataset) => dataset.reference.digest),
      sql: options.sql,
      rowLimit: options.rowLimit,
      sandboxProvider: "local-duckdb",
    },
  });
}

async function finalizePaid(
  kind: ArtifactKind,
  result: unknown,
  report: AtlasReport,
  additionalArtifacts: readonly ArtifactRecord[] = []
): Promise<Record<string, unknown>> {
  const resultArtifact = await putJsonArtifact(kind, result);
  const reportArtifact = await putJsonArtifact("report", report);
  const artifacts = [resultArtifact, reportArtifact, ...additionalArtifacts];
  const anchorPayload = {
    schemaVersion: "evidiq.atlas.anchor.v1",
    reportId: report.reportId,
    integrity: {
      algorithm: report.integrity.algorithm,
      canonicalization: report.integrity.canonicalization,
      digest: report.integrity.digest,
    },
    datasets: report.body.datasets.map(({ format, digest, bytes }) => ({ format, digest, bytes })),
  };
  const anchor = await anchorBestEffort(anchorPayload, `${report.reportId}.json`);
  return {
    result,
    report,
    artifacts: artifacts.map(artifactReference),
    storage: anchor,
  };
}

export const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "atlas_capabilities",
      {
        title: "Atlas capabilities, safety limits, and pricing",
        description: "Inspect supported formats, deterministic runtime, security boundaries, optional providers, and all tool prices. Free.",
        inputSchema: {},
      },
      async () => textResult({
        service: "EVIDIQ Atlas",
        version: "0.1.0",
        purpose: "Isolated dataset research, analysis, comparison, and Plotly-compatible visualization",
        formats: { inline: ["csv", "json", "ndjson"], remote: ["csv", "json", "ndjson", "parquet"] },
        tables: { singleDataset: "dataset", comparison: ["left_dataset", "right_dataset"] },
        tools: [
          ...PAID_TOOL_NAMES.map((name) => ({ name, paid: true, amountAtomic: TOOL_PRICES[name].toString(), usdt0: Number(TOOL_PRICES[name]) / 1_000_000 })),
          ...FREE_TOOL_NAMES.map((name) => ({ name, paid: false, amountAtomic: "0", usdt0: 0 })),
        ],
        payment: { protocol: "x402 v2", scheme: "exact", network: "eip155:196", asset: "USDT0", decimals: 6 },
        limits: getAtlasLimits(),
        sandboxProviders: sandboxStatuses(),
        storage: (() => {
          const configured = getOgConfig() !== null;
          return {
            provider: "0G Storage",
            configured,
            configurationValidated: true,
            status: configured ? "configured" : "not_configured",
            mode: "optional best-effort privacy-minimized report/dataset integrity anchor",
          };
        })(),
        reportSigning: (() => {
          const status = getAtlasSignerStatus();
          if (!status.valid) throw new Error(status.error || "Invalid Atlas signer configuration");
          return {
            algorithm: "EIP-191",
            digest: "SHA-256 over complete canonical report body",
            configured: status.configured,
            signing: {
              enabled: status.signingEnabled,
              privateKeyConfigured: status.privateKeyConfigured,
              ...(status.signer ? { signer: status.signer } : {}),
            },
            verification: {
              enabled: status.verificationEnabled,
              addressConfigured: status.addressConfigured,
              ...(status.trustedSigner ? { trustedSigner: status.trustedSigner } : {}),
            },
          };
        })(),
        prohibited: ["arbitrary code", "shell commands", "DuckDB extension install/load", "database attach", "write/export SQL", "private or metadata URLs"],
      })
    );

    server.registerTool(
      "validate_dataset_source",
      {
        title: "Validate a dataset source before payment",
        description: "Validate schema, inline size/content, or remote URL DNS/SSRF safety without downloading remote data. Free.",
        inputSchema: { source: datasetSourceSchema },
      },
      async ({ source }) => textResult(await validateDatasetSource(source))
    );

    server.registerTool(
      "estimate_cost",
      {
        title: "Quote an Atlas paid tool",
        description: "Return the immutable x402 price and workload notes for one paid tool. Free.",
        inputSchema: { tool: paidToolSchema },
      },
      async ({ tool }) => {
        const amount = TOOL_PRICES[tool];
        return textResult({
          tool,
          amountAtomic: amount.toString(),
          amountUSDT0: Number(amount) / 1_000_000,
          asset: "USDT0",
          network: "eip155:196",
          settlement: "Payment settles before allocated analysis work begins.",
          recommendation: "Call validate_dataset_source first. Remote content is fetched only inside the paid call.",
        });
      }
    );

    server.registerTool(
      "verify_atlas_report",
      {
        title: "Verify a canonical Atlas report",
        description: "Recompute report integrity and verify trusted authenticity. integrityValid can be true for an unsigned report; valid/authentic require a valid signature from expectedSigner or the configured trusted signer. Free.",
        inputSchema: {
          report: z.record(z.unknown()).optional(),
          artifactId: reportArtifactIdSchema.optional(),
          expectedSigner: evmAddressSchema.optional(),
        },
      },
      async ({ report, artifactId, expectedSigner }) => {
        const hasReport = report !== undefined;
        const hasArtifactId = artifactId !== undefined;
        if (hasReport === hasArtifactId) {
          return textResult({ valid: false, error: "Provide exactly one of report or artifactId" });
        }

        const candidate = hasReport ? report : (await getArtifact(artifactId!))?.content;
        if (candidate === undefined) {
          return textResult({ valid: false, error: `Report artifact not found: ${artifactId}` });
        }
        return textResult(await verifyAtlasReport(
          candidate,
          expectedSigner === undefined ? undefined : { expectedSigner },
        ));
      }
    );

    server.registerTool(
      "get_artifact",
      {
        title: "Retrieve an Atlas artifact by content ID",
        description: "Fetch a content-addressed JSON report, chart, query, profile, comparison, or research artifact. Free; an artifact ID is not an access-control token.",
        inputSchema: { artifactId: artifactIdSchema },
      },
      async ({ artifactId }) => {
        const artifact = await getArtifact(artifactId);
        return textResult(artifact ? { found: true, ...artifact } : { found: false, artifactId });
      }
    );

    server.registerTool(
      "profile_dataset",
      {
        title: "Profile dataset quality and distributions",
        description: "Infer schema, count rows/nulls/distincts, calculate numeric summaries/top values, and return samples. Cost: 0.005 USDT0.",
        inputSchema: { source: datasetSourceSchema },
      },
      async ({ source }) => {
        const dataset = await materializeDataset(source);
        const result = await withEngine({ dataset }, (engine) => profileDataset(engine));
        const report = await buildReport("profile_dataset", [dataset], { operation: "profile" }, result, {
          methods: ["DuckDB schema inference", "null and approximate-distinct counts", "descriptive statistics", "top-frequency values", "20-row sample"],
          warnings: result.warnings,
        });
        return textResult(await finalizePaid("profile", result, report));
      }
    );

    server.registerTool(
      "query_dataset",
      {
        title: "Run read-only DuckDB SQL",
        description: "Execute one SELECT/CTE against table dataset. External readers, writes, extensions, attachment, and multiple statements are rejected. Cost: 0.01 USDT0.",
        inputSchema: {
          source: datasetSourceSchema,
          sql: z.string().min(1).max(20_000),
          rowLimit: z.number().int().min(1).max(10_000).optional(),
        },
      },
      async ({ source, sql, rowLimit }) => {
        const dataset = await materializeDataset(source);
        const result = await withEngine({ dataset }, (engine) => engine.query(sql, rowLimit));
        const report = await buildReport("query_dataset", [dataset], { sql, rowLimit }, result, {
          methods: ["single-statement SQL parsing", "read-only keyword/function allow policy", "DuckDB execution with external access disabled", "bounded result materialization"],
          sql,
          rowLimit: rowLimit ?? getAtlasLimits().maxQueryRows,
          deterministic: result.deterministic,
          warnings: result.truncated ? ["Result was truncated at the configured row limit."] : [],
        });
        return textResult(await finalizePaid("query", result, report));
      }
    );

    server.registerTool(
      "visualize_dataset",
      {
        title: "Generate a deterministic Plotly-compatible chart",
        description: "Build bar, line, scatter, histogram, or box chart JSON from validated columns. Cost: 0.015 USDT0.",
        inputSchema: {
          source: datasetSourceSchema,
          chart: z.object({
            type: chartTypeSchema.optional(),
            x: columnNameSchema,
            y: columnNameSchema.optional(),
            color: columnNameSchema.optional(),
            aggregation: aggregationSchema.optional(),
            title: z.string().max(200).optional(),
            limit: z.number().int().min(1).max(5_000).optional(),
          }),
        },
      },
      async ({ source, chart }) => {
        const dataset = await materializeDataset(source);
        const normalizedChart = { type: chart.type ?? "auto", limit: chart.limit ?? 500, ...chart };
        const result = await withEngine({ dataset }, (engine) => visualizeDataset(engine, normalizedChart));
        const chartArtifact = await putJsonArtifact("chart", result.spec);
        const report = await buildReport("visualize_dataset", [dataset], { chart: normalizedChart }, result, {
          methods: ["validated column projection", "bounded DuckDB aggregation", "deterministic Plotly-compatible JSON generation"],
          assumptions: ["The returned chart is a specification; rendering occurs in the caller."],
        });
        return textResult(await finalizePaid("chart", result, report, [chartArtifact]));
      }
    );

    server.registerTool(
      "compare_datasets",
      {
        title: "Compare two datasets",
        description: "Measure row/schema/null/distinct drift and optional distinct-key overlap between two datasets. Cost: 0.02 USDT0.",
        inputSchema: {
          left: datasetSourceSchema,
          right: datasetSourceSchema,
          keyColumns: z.array(columnNameSchema).max(8).optional(),
        },
      },
      async ({ left, right, keyColumns }) => {
        const [leftDataset, rightDataset] = await Promise.all([materializeDataset(left), materializeDataset(right)]);
        const result = await withEngine(
          { left_dataset: leftDataset, right_dataset: rightDataset },
          (engine) => compareDatasets(engine, keyColumns ?? [])
        );
        const report = await buildReport("compare_datasets", [leftDataset, rightDataset], { keyColumns: keyColumns ?? [] }, result, {
          methods: ["schema set comparison", "row-count delta", "column null/distinct drift", "null-safe distinct-key overlap when requested"],
          warnings: result.warnings,
        });
        return textResult(await finalizePaid("comparison", result, report));
      }
    );

    server.registerTool(
      "research_dataset",
      {
        title: "Run a comprehensive deterministic dataset research pass",
        description: "Combine profiling, duplicate estimation, correlations, IQR outliers, findings, and optional monthly trends. Cost: 0.03 USDT0.",
        inputSchema: {
          source: datasetSourceSchema,
          objective: z.string().trim().min(3).max(1_000),
          dateColumn: columnNameSchema.optional(),
          metricColumn: columnNameSchema.optional(),
        },
      },
      async ({ source, objective, dateColumn, metricColumn }) => {
        const dataset = await materializeDataset(source);
        const result = await withEngine({ dataset }, (engine) => researchDataset(engine, objective, { dateColumn, metricColumn }));
        const report = await buildReport("research_dataset", [dataset], { objective, dateColumn, metricColumn }, result, {
          methods: ["full dataset profile", "complete-row hash duplicate estimate", "Pearson correlations", "1.5×IQR outlier scan", "optional monthly trend aggregation"],
          assumptions: ["The objective labels the research question; deterministic checks do not infer causality or domain intent."],
          warnings: result.warnings,
        });
        return textResult(await finalizePaid("research", result, report));
      }
    );
  },
  {
    instructions: ATLAS_INSTRUCTIONS,
    capabilities: { tools: {} },
  },
  {
    basePath: "",
    maxDuration: 300,
    verboseLogs: false,
  }
);
