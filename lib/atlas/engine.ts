import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, version as duckdbVersion, type DuckDBConnection } from "@duckdb/node-api";
import { getAtlasLimits } from "./schemas.js";
import type { MaterializedDataset } from "./ingest.js";

export type DatasetColumn = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
}>;

export type QueryResult = Readonly<{
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  deterministic: boolean;
}>;

const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function extensionFor(format: MaterializedDataset["format"]): string {
  return format === "ndjson" ? "jsonl" : format;
}

type SqlToken = Readonly<{
  kind: "word" | "quotedIdentifier" | "symbol";
  value: string;
}>;

function stripSqlTrivia(sql: string): { normalized: string; semicolons: number } {
  let output = "";
  let semicolons = 0;
  let index = 0;
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "normal") {
      if (char === "'") { state = "single"; output += " "; }
      else if (char === '"') { state = "double"; output += char; }
      else if (char === "-" && next === "-") { state = "line"; output += "  "; index += 1; }
      else if (char === "/" && next === "*") { state = "block"; output += "  "; index += 1; }
      else { if (char === ";") semicolons += 1; output += char; }
    } else if (state === "single") {
      output += char === "\n" ? "\n" : " ";
      if (char === "'" && next === "'") { output += " "; index += 1; }
      else if (char === "'") state = "normal";
    } else if (state === "double") {
      output += char;
      if (char === '"' && next === '"') { output += next; index += 1; }
      else if (char === '"') state = "normal";
    } else if (state === "line") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "normal";
    } else {
      output += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") { output += " "; index += 1; state = "normal"; }
    }
    index += 1;
  }
  if (state === "single" || state === "double" || state === "block") throw new Error("SQL contains an unterminated literal, identifier, or comment");
  return { normalized: output, semicolons };
}

function tokenizeSql(normalized: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < normalized.length) {
        const quoted = normalized[index]!;
        if (quoted === '"' && normalized[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        if (quoted === '"') { index += 1; break; }
        value += quoted;
        index += 1;
      }
      tokens.push({ kind: "quotedIdentifier", value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < normalized.length && /[A-Za-z0-9_$]/.test(normalized[index]!)) index += 1;
      tokens.push({ kind: "word", value: normalized.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "symbol", value: char });
    index += 1;
  }
  return tokens;
}

function identifierName(token: SqlToken | undefined): string | undefined {
  if (!token || (token.kind !== "word" && token.kind !== "quotedIdentifier")) return undefined;
  return token.value.toLowerCase();
}

function isBareKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === "word" && token.value.toLowerCase() === keyword;
}

function isSymbol(token: SqlToken | undefined, symbol: string): boolean {
  return token?.kind === "symbol" && token.value === symbol;
}

const FORBIDDEN_SQL_KEYWORDS = new Set([
  "alter", "attach", "call", "checkpoint", "copy", "create", "delete", "describe", "detach",
  "drop", "execute", "export", "force", "import", "insert", "install", "into", "load", "pragma",
  "prepare", "reset", "secret", "set", "show", "summarize", "truncate", "update", "use", "vacuum",
]);

const FORBIDDEN_SCHEMAS = new Set(["information_schema", "pg_catalog", "system"]);

const FORBIDDEN_FUNCTIONS = new Set([
  "current_catalog", "current_database", "current_query", "current_schema", "current_schemas",
  "current_setting", "extension_versions", "getenv", "getvariable", "glob", "install_extension",
  "json_execute_serialized_sql", "last_profiling_output", "last_query_id", "load_extension", "platform",
  "query", "query_table", "shell", "sniff_csv", "stats", "setvariable", "version", "which_secret", "write_log",
]);

const NON_REPRODUCIBLE_FUNCTIONS = new Set([
  "clock_timestamp", "current_connection_id", "current_date", "current_localtimestamp", "current_query_id",
  "current_role", "current_time", "current_timestamp", "current_transaction_id", "current_user", "currval",
  "gen_random_uuid", "get_current_time", "get_current_timestamp", "lastval", "localtime", "localtimestamp",
  "nextval", "now", "random", "random_normal", "session_user", "setseed", "sleep", "sleep_ms",
  "statement_timestamp", "timeofday", "today", "transaction_timestamp", "txid_current", "uuid", "uuidv4", "uuidv7",
]);

const NON_REPRODUCIBLE_KEYWORDS = new Set([
  "current_catalog", "current_date", "current_role", "current_schema", "current_time", "current_timestamp",
  "current_user", "localtime", "localtimestamp", "session_user", "tablesample",
]);

function isForbiddenExternalOrIntrospectionFunction(name: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(name)
    || name.startsWith("duckdb_")
    || name.startsWith("pragma_")
    || name.startsWith("pg_")
    || name.startsWith("read_")
    || name.endsWith("_scan")
    || /^(?:delta|iceberg|jdbc|mysql|odbc|parquet|postgres|sqlite)_/.test(name)
    || /^http_(?:get|post|put|delete|patch|head)$/.test(name);
}

function relationStartsWithFunction(tokens: readonly SqlToken[], start: number): boolean {
  let cursor = start;
  while (isBareKeyword(tokens[cursor], "lateral") || isSymbol(tokens[cursor], "(")) cursor += 1;
  if (identifierName(tokens[cursor]) === undefined) return false;
  cursor += 1;
  while (isSymbol(tokens[cursor], ".") && identifierName(tokens[cursor + 1]) !== undefined) cursor += 2;
  return isSymbol(tokens[cursor], "(");
}

function tokenDepths(tokens: readonly SqlToken[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    depths.push(depth);
    if (isSymbol(token, "(")) depth += 1;
    else if (isSymbol(token, ")")) depth = Math.max(0, depth - 1);
  }
  return depths;
}

function commaIsInFromClause(tokens: readonly SqlToken[], depths: readonly number[], commaIndex: number): boolean {
  const depth = depths[commaIndex];
  for (let index = commaIndex - 1; index >= 0; index -= 1) {
    if (depths[index] !== depth || tokens[index]?.kind !== "word") continue;
    const keyword = tokens[index]!.value.toLowerCase();
    if (keyword === "from" || keyword === "join") return true;
    if (["except", "group", "having", "intersect", "limit", "offset", "order", "qualify", "select", "union", "where", "window", "with"].includes(keyword)) return false;
  }
  return false;
}

function hasEffectiveOrderBy(tokens: readonly SqlToken[]): boolean {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isSymbol(token, "(")) { depth += 1; continue; }
    if (isSymbol(token, ")")) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && isBareKeyword(token, "order") && isBareKeyword(tokens[index + 1], "by")) return true;
  }
  return false;
}

function validateSecurityTokens(tokens: readonly SqlToken[]): void {
  const first = tokens[0];
  if (!isBareKeyword(first, "select") && !isBareKeyword(first, "with")) throw new Error("Only SELECT or WITH queries are allowed");

  const depths = tokenDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const name = identifierName(token);
    if (token.kind === "word") {
      const keyword = token.value.toLowerCase();
      if (FORBIDDEN_SQL_KEYWORDS.has(keyword)) throw new Error("SQL contains a forbidden statement or keyword");
      if (NON_REPRODUCIBLE_KEYWORDS.has(keyword) || keyword === "sample") throw new Error("SQL contains a volatile or non-reproducible expression");
      if (keyword === "current" && tokens[index + 1]?.kind === "word" && ["date", "time", "timestamp"].includes(tokens[index + 1]!.value.toLowerCase())) {
        throw new Error("SQL contains a volatile or non-reproducible expression");
      }
    }
    if (name && FORBIDDEN_SCHEMAS.has(name) && isSymbol(tokens[index + 1], ".")) {
      throw new Error("SQL may not reference system or catalog schemas");
    }
    if (name && isSymbol(tokens[index + 1], "(")) {
      if (isForbiddenExternalOrIntrospectionFunction(name)) throw new Error("SQL contains a forbidden external or introspection function");
      if (NON_REPRODUCIBLE_FUNCTIONS.has(name)) throw new Error("SQL contains a volatile or non-reproducible function");
    }
    if ((isBareKeyword(token, "from") || isBareKeyword(token, "join")) && relationStartsWithFunction(tokens, index + 1)) {
      throw new Error("SQL may not invoke table functions in FROM or JOIN clauses");
    }
    if (isSymbol(token, ",") && commaIsInFromClause(tokens, depths, index) && relationStartsWithFunction(tokens, index + 1)) {
      throw new Error("SQL may not invoke table functions in FROM or JOIN clauses");
    }
  }
}

export function validateReadOnlySql(sqlInput: string): string {
  const sql = sqlInput.trim();
  if (!sql) throw new Error("SQL query is empty");
  if (sql.length > 20_000) throw new Error("SQL query exceeds 20,000 characters");
  if (sql.includes("\u0000")) throw new Error("SQL query contains a NUL byte");
  const withoutTrailing = sql.replace(/;\s*$/, "").trim();
  const { normalized, semicolons } = stripSqlTrivia(sql);
  const allowedSemicolons = /;\s*$/.test(sql) ? 1 : 0;
  if (semicolons !== allowedSemicolons) throw new Error("Only one SQL statement is allowed");
  const normalizedWithoutTrailing = normalized.replace(/;\s*$/, "").trim();
  validateSecurityTokens(tokenizeSql(normalizedWithoutTrailing));
  return withoutTrailing;
}

function isDeterministicallyOrdered(sql: string): boolean {
  return hasEffectiveOrderBy(tokenizeSql(stripSqlTrivia(sql).normalized));
}

function rowsFrom(reader: Awaited<ReturnType<DuckDBConnection["runAndReadAll"]>>): Record<string, unknown>[] {
  return reader.getRowObjectsJson() as Record<string, unknown>[];
}

export class AtlasEngine {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly directory: string,
    readonly tables: ReadonlySet<string>
  ) {}

  static version(): string { return duckdbVersion(); }

  static async create(datasets: Readonly<Record<string, MaterializedDataset>>): Promise<AtlasEngine> {
    const entries = Object.entries(datasets);
    if (entries.length === 0) throw new Error("At least one dataset is required");
    for (const [table] of entries) if (!TABLE_PATTERN.test(table)) throw new Error(`Unsafe internal table name: ${table}`);
    const directory = await mkdtemp(join(tmpdir(), "evidiq-atlas-"));
    let instance: DuckDBInstance | undefined;
    let connection: DuckDBConnection | undefined;
    try {
      instance = await DuckDBInstance.create(":memory:", {
        threads: "2",
        memory_limit: "512MB",
        allow_unsigned_extensions: "false",
        autoload_known_extensions: "false",
        autoinstall_known_extensions: "false",
      });
      connection = await instance.connect();
      for (const [table, dataset] of entries) {
        const filePath = join(directory, `${table}.${extensionFor(dataset.format)}`);
        await writeFile(filePath, dataset.bytes, { mode: 0o600 });
        const reader = dataset.format === "csv"
          ? "read_csv_auto($path, header=true, sample_size=-1, all_varchar=false)"
          : dataset.format === "json"
            ? "read_json_auto($path, format='auto', maximum_object_size=33554432)"
            : dataset.format === "ndjson"
              ? "read_json_auto($path, format='newline_delimited', maximum_object_size=33554432)"
              : "read_parquet($path)";
        await connection.run(`CREATE TABLE ${quoteIdentifier(table)} AS SELECT * FROM ${reader}`, { path: filePath });
      }
      await connection.run("SET enable_external_access = false");
      await rm(directory, { recursive: true, force: true });
      return new AtlasEngine(instance, connection, directory, new Set(entries.map(([table]) => table)));
    } catch (error) {
      connection?.closeSync();
      instance?.closeSync();
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.connection.closeSync();
    this.instance.closeSync();
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs = getAtlasLimits().queryTimeoutMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            this.connection.interrupt();
            reject(new Error(`DuckDB query exceeded ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async runInternal(sql: string, values?: Record<string, string | number | bigint | boolean | null>): Promise<Record<string, unknown>[]> {
    const reader = await this.withTimeout(this.connection.runAndReadAll(sql, values));
    return rowsFrom(reader);
  }

  async describe(table: string): Promise<DatasetColumn[]> {
    this.assertTable(table);
    const rows = await this.runInternal(`DESCRIBE ${quoteIdentifier(table)}`);
    return rows.map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
      nullable: String(row.null).toUpperCase() !== "NO",
    }));
  }

  async count(table: string): Promise<number> {
    this.assertTable(table);
    const [row] = await this.runInternal(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`);
    return Number(row?.count ?? 0);
  }

  async query(sqlInput: string, requestedLimit?: number): Promise<QueryResult> {
    const sql = validateReadOnlySql(sqlInput);
    const deterministic = isDeterministicallyOrdered(sql);
    const extracted = await this.connection.extractStatements(sql);
    if (extracted.count !== 1) throw new Error("Only one SQL statement is allowed");
    const referenced = this.connection.getTableNames(sql, false);
    for (const table of referenced) {
      if (!this.tables.has(table)) throw new Error(`Query may reference only loaded Atlas tables; rejected ${table}`);
    }
    const configuredMax = getAtlasLimits().maxQueryRows;
    const limit = Math.min(requestedLimit ?? configuredMax, configuredMax);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("row limit must be a positive integer");
    const reader = await this.withTimeout(
      this.connection.runAndReadAll(`SELECT * FROM (${sql}) AS atlas_result LIMIT ${limit + 1}`)
    );
    const allRows = rowsFrom(reader);
    const truncated = allRows.length > limit;
    const rows = truncated ? allRows.slice(0, limit) : allRows;
    const columns = reader.columnNames().map(String);
    const encodedBytes = Buffer.byteLength(JSON.stringify(rows));
    if (encodedBytes > 5 * 1024 * 1024) throw new Error("Query result exceeds the 5 MiB response limit; aggregate or select fewer columns");
    return { columns, rows, rowCount: rows.length, truncated, deterministic };
  }

  private assertTable(table: string): void {
    if (!this.tables.has(table)) throw new Error(`Unknown Atlas table: ${table}`);
  }
}
