export type SandboxProvider = "local-duckdb" | "e2b";

export type SandboxStatus = Readonly<{
  provider: SandboxProvider;
  configured: boolean;
  activeForDatasetTools: boolean;
  isolation: string;
  note: string;
}>;

export interface ResearchSandboxAdapter {
  readonly provider: SandboxProvider;
  status(): SandboxStatus;
}
