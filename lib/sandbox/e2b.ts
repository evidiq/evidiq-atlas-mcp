import type { ResearchSandboxAdapter, SandboxStatus } from "./types.js";

class LocalDuckDbAdapter implements ResearchSandboxAdapter {
  readonly provider = "local-duckdb" as const;
  status(): SandboxStatus {
    return {
      provider: this.provider,
      configured: true,
      activeForDatasetTools: true,
      isolation: "A fresh in-memory DuckDB instance and temporary directory are created per call; external access is disabled after ingestion.",
      note: "No arbitrary user code, shell, extension installation, or database attachment is exposed.",
    };
  }
}

class E2BAdapter implements ResearchSandboxAdapter {
  readonly provider = "e2b" as const;
  status(): SandboxStatus {
    const configured = Boolean(process.env.E2B_API_KEY?.trim());
    return {
      provider: this.provider,
      configured,
      activeForDatasetTools: false,
      isolation: "Optional E2B Code Interpreter provider package is installed behind an adapter boundary.",
      note: configured
        ? "E2B credentials are available, but Atlas v0.1 keeps deterministic analysis on DuckDB and does not expose generic code execution."
        : "Set E2B_API_KEY only when a future service-controlled research workload requires cloud sandbox isolation.",
    };
  }
}

export function sandboxStatuses(): SandboxStatus[] {
  return [new LocalDuckDbAdapter().status(), new E2BAdapter().status()];
}
