---
name: EVIDIQ Atlas
version: 1.0.0
description: Secure dataset profiling, read-only SQL, comparison, research, and Plotly-compatible visualization with canonical, optionally signed reports and x402 pricing.
category: Data & Intelligence
provider: EVIDIQ
provider_url: https://evidiq.dev
license: MIT
---

# EVIDIQ Atlas MCP

**Turn CSV, JSON, NDJSON, or Parquet into reproducible evidence—not arbitrary code execution.**

EVIDIQ Atlas lets an agent validate a dataset source for free, then profile, query, visualize, compare, or research it inside a fresh in-memory DuckDB runtime. Every paid result includes a complete canonical report digest, an optional EIP-191 signature, and content-addressed local artifacts an agent can verify offline.

**Launch status: preparing launch.** The standalone service and skill are implemented locally; the public endpoint and marketplace listing remain reserved until deployment and credentials are explicitly approved. Nothing in this document claims a live deployment.

Reserved documentation URL: `https://evidiq.dev/docs/atlas`

## Route to Atlas when

Use Atlas for:

- Dataset schema and quality profiling.
- Read-only SQL over supplied data.
- Deterministic chart specifications.
- Dataset-version or cohort comparison.
- Longer descriptive research: missingness, duplicates, correlations, IQR outliers, and time trends.
- Re-verifying an Atlas report or retrieving a known artifact.

Do **not** route generic coding, shell execution, app generation, browser automation, or vibe-coding tasks to Atlas. Atlas never accepts user-authored Python, JavaScript, shell, DuckDB extensions, attached databases, or write/export SQL.

## Dataset source contract

Inline CSV, JSON, or NDJSON:

```json
{
  "kind": "inline",
  "format": "csv",
  "name": "sales.csv",
  "data": "month,revenue\n2026-01,1200\n2026-02,1450"
}
```

Remote CSV, JSON, NDJSON, or Parquet:

```json
{
  "kind": "url",
  "format": "parquet",
  "name": "events.parquet",
  "url": "https://data.example.org/events.parquet"
}
```

Remote fetches are HTTP(S)-only and revalidate DNS on every redirect. Atlas rejects credentials in URLs, non-default ports, private/loopback/link-local/CGNAT/multicast/reserved/cloud-metadata addresses, oversized/decompression-bomb responses, excess redirects, and mismatched content types. The checked public IP is pinned for the connection.

## Free tools

| Tool | Purpose |
|---|---|
| `atlas_capabilities` | Formats, limits, runtime/provider status, security boundaries, and full pricing |
| `validate_dataset_source` | Validate inline content or remote URL/DNS safety before payment; remote content is not downloaded |
| `estimate_cost` | Quote one immutable paid-tool price |
| `verify_atlas_report` | Recompute structural/report-ID/digest integrity and verify trusted EIP-191 authenticity against `expectedSigner` or the configured Atlas signer |
| `get_artifact` | Retrieve a content-addressed JSON artifact by exact ID |

## Paid tools

| Tool | Atomic USDT0 | Cost | Purpose |
|---|---:|---:|---|
| `profile_dataset` | `5000` | 0.005 USDT0 | Schema, rows, nulls, distincts, numeric summaries, top values, and sample |
| `query_dataset` | `10000` | 0.01 USDT0 | One bounded read-only `SELECT`/CTE against table `dataset` |
| `visualize_dataset` | `15000` | 0.015 USDT0 | Deterministic bar/line/scatter/histogram/box Plotly-compatible JSON |
| `compare_datasets` | `20000` | 0.02 USDT0 | Row/schema/null/distinct drift and optional key overlap |
| `research_dataset` | `30000` | 0.03 USDT0 | Profile + duplicate estimate + correlations + IQR outliers + optional trends |

Prices are immutable in service code. Asset: USDT0 with 6 decimals on X Layer (`eip155:196`), contract `0x779ded0c9e1022225f8e0630b35a9b54be713736`.

## Recommended agent workflow

1. Call `atlas_capabilities` to inspect current limits.
2. Call `validate_dataset_source` with the exact source object.
3. Call `estimate_cost` for the intended paid tool.
4. Submit one paid tool call per HTTP request. Multiple paid calls in a JSON-RPC batch are rejected to prevent undercharging.
5. Preserve the returned `report`, report artifact ID, dataset digest, and optional `storageRoot`/`storageTx`.
6. Call `verify_atlas_report` before relying on a report received from another party.

Payment settles before analysis begins and covers the allocated analysis attempt, including safe fetch and bounded computation. Validation is free specifically so agents can catch malformed or unsafe inputs before paying.

## Tool examples

### Profile

```json
{
  "source": {
    "kind": "inline",
    "format": "csv",
    "data": "region,revenue\nAPAC,10\nEMEA,20\nAPAC,15"
  }
}
```

### Read-only SQL

The loaded table is always named `dataset`:

```json
{
  "source": { "kind": "url", "format": "parquet", "url": "https://data.example.org/sales.parquet" },
  "sql": "SELECT region, sum(revenue) AS revenue FROM dataset GROUP BY region ORDER BY revenue DESC",
  "rowLimit": 500
}
```

Only one `SELECT` or `WITH` statement is accepted. External readers such as `read_csv`, `read_json`, `read_parquet`, `glob`, extension install/load, `ATTACH`, `COPY`, DDL, DML, system catalogs, settings/introspection functions, table functions, and volatile expressions such as `random()`, `uuid()`, or current-time functions are rejected. Results are capped by row and encoded-size limits. An ad-hoc query report is marked deterministic only when the outer query has an effective `ORDER BY`; otherwise its report explicitly records `deterministic: false`.

### Visualize

```json
{
  "source": { "kind": "inline", "format": "csv", "data": "month,revenue\n2026-01,1200\n2026-02,1450" },
  "chart": { "type": "line", "x": "month", "y": "revenue", "title": "Monthly revenue" }
}
```

### Compare

```json
{
  "left": { "kind": "url", "format": "csv", "url": "https://data.example.org/v1.csv" },
  "right": { "kind": "url", "format": "csv", "url": "https://data.example.org/v2.csv" },
  "keyColumns": ["id"]
}
```

### Research

```json
{
  "source": { "kind": "url", "format": "parquet", "url": "https://data.example.org/events.parquet" },
  "objective": "Find data-quality risks and changes in monthly transaction value",
  "dateColumn": "created_at",
  "metricColumn": "transaction_value"
}
```

The objective is recorded in the report; Atlas v1 findings remain deterministic descriptive statistics and do not claim causality.

## Report and artifact integrity

A paid response contains:

- `result`: structured tool output.
- `report`: the complete result, request parameters, dataset digests, methods, assumptions, warnings, engine version, and reproducibility metadata.
- `report.integrity.digest`: SHA-256 over the complete canonical report body; `reportId` is independently derived from the same body digest.
- `report.integrity.signature` and `signer` when `ATLAS_SIGNER_PRIVATE_KEY` is configured.
- Content-addressed result/report/chart artifact references.
- `storageRoot`/`storageTx` when optional 0G Storage anchoring succeeds, otherwise a transparent `storageNote`.

`verify_atlas_report` separates integrity from authenticity. A structurally valid unsigned report can return `integrityValid: true`, but `valid`/`authentic` are true only when the signature is valid and the signer matches an explicit `expectedSigner` or trusted `ATLAS_SIGNER_ADDRESS` (or the address derived from the configured signing key).

The public 0G anchor is deliberately privacy-minimized: it contains only the report ID, fixed integrity labels and report-body digest, plus each dataset's format, digest, and byte count. It excludes artifact IDs, artifact digests, artifact kinds, dataset names, source URLs, raw datasets, results, samples, query rows, signatures, and signer addresses. The anchor is public metadata, not an access-control system or anonymity guarantee.

Local artifacts are integrity-checked but are not an authorization system: callers must protect sensitive artifact IDs and avoid submitting confidential data unless deployment policy permits it.

## Isolation providers

- **Local DuckDB (active):** fresh in-memory database and private temporary directory per call; external access is disabled after controlled ingestion.
- **E2B (optional adapter):** dependency and provider boundary are available for future service-controlled workloads. Atlas v1 does not claim E2B execution and never exposes its generic code runtime to callers.
- **0G Storage (optional):** best-effort sanitized integrity anchor; core analysis works without it.

## x402 v2 flow

1. Call a paid tool without `PAYMENT-SIGNATURE` to receive HTTP 402 plus `PAYMENT-REQUIRED`.
2. Sign the requested EIP-3009 `transferWithAuthorization` for the exact tool amount.
3. Retry with the base64 x402 v2 envelope in `PAYMENT-SIGNATURE`.
4. Atlas verifies and settles, executes the bounded operation, then returns `PAYMENT-RESPONSE`.

If an on-chain settlement was broadcast but is not yet confirmed, Atlas returns HTTP `202` with `status: "pending"` and the transaction hash. Retry with the **same authorization** so Atlas can check confirmation without broadcasting or charging again; do not create a new payment. A facilitator response with ambiguous settlement state returns a service error rather than a fresh 402 challenge.

**Deployment note:** Atlas gates and settles x402 payments the same way as the sibling EVIDIQ MCPs. Settlement replay-protection is tracked in an in-process cache, so run a single instance per payee; scaling to multiple replicas would require a shared settlement store. Leaving `X402_PAY_TO` unset runs every tool ungated for local development.

## Public endpoints

- Docs: `https://evidiq.dev/docs/atlas`
- Health: `GET https://mcp.evidiq.dev/atlas/health`
- Skill: `GET https://mcp.evidiq.dev/atlas/skill.md`
- Pricing: `GET https://mcp.evidiq.dev/atlas/x402`
- MCP: `POST https://mcp.evidiq.dev/atlas/mcp`

## Version

`v1.0.0` — original EVIDIQ wrapper/product code licensed MIT. Third-party components retain their own notices in `THIRD_PARTY_NOTICES.md` and package distributions.
