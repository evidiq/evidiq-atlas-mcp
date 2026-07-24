import { AtlasEngine, quoteIdentifier, type DatasetColumn } from "./engine.js";

export type ColumnProfile = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  nullCount?: number;
  nullRate?: number;
  approximateDistinct?: number;
  minimum?: unknown;
  maximum?: unknown;
  mean?: number;
  standardDeviation?: number;
  median?: number;
  firstQuartile?: number;
  thirdQuartile?: number;
  topValues?: readonly Readonly<{ value: string | null; count: number }>[];
  warning?: string;
}>;

export type DatasetProfile = Readonly<{
  rowCount: number;
  columnCount: number;
  columns: readonly ColumnProfile[];
  sampleRows: readonly Record<string, unknown>[];
  warnings: readonly string[];
}>;

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : undefined;
}

function isNumeric(type: string): boolean {
  return /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)/i.test(type);
}

function isTemporal(type: string): boolean {
  return /^(DATE|TIME|TIMESTAMP|INTERVAL)/i.test(type);
}

function supportsGrouping(type: string): boolean {
  return !/^(BLOB|LIST|MAP|STRUCT|UNION|ARRAY)/i.test(type);
}

async function profileColumn(engine: AtlasEngine, table: string, column: DatasetColumn, rowCount: number): Promise<ColumnProfile> {
  const tableId = quoteIdentifier(table);
  const columnId = quoteIdentifier(column.name);
  try {
    const [base] = await engine.runInternal(
      `SELECT count(*) FILTER (WHERE ${columnId} IS NULL) AS null_count, approx_count_distinct(${columnId}) AS distinct_count FROM ${tableId}`
    );
    const nullCount = numberValue(base?.null_count) ?? 0;
    const profile: Record<string, unknown> = {
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      nullCount,
      nullRate: rowCount === 0 ? 0 : Number((nullCount / rowCount).toFixed(6)),
      approximateDistinct: numberValue(base?.distinct_count),
    };
    if (isNumeric(column.type)) {
      const [stats] = await engine.runInternal(
        `SELECT min(${columnId}) AS minimum, max(${columnId}) AS maximum, avg(${columnId}) AS mean, stddev_pop(${columnId}) AS standard_deviation, quantile_cont(${columnId}, 0.25) AS q1, quantile_cont(${columnId}, 0.5) AS median, quantile_cont(${columnId}, 0.75) AS q3 FROM ${tableId}`
      );
      Object.assign(profile, {
        minimum: stats?.minimum,
        maximum: stats?.maximum,
        mean: numberValue(stats?.mean),
        standardDeviation: numberValue(stats?.standard_deviation),
        firstQuartile: numberValue(stats?.q1),
        median: numberValue(stats?.median),
        thirdQuartile: numberValue(stats?.q3),
      });
    } else if (isTemporal(column.type)) {
      const [stats] = await engine.runInternal(`SELECT min(${columnId}) AS minimum, max(${columnId}) AS maximum FROM ${tableId}`);
      Object.assign(profile, { minimum: stats?.minimum, maximum: stats?.maximum });
    }
    if (supportsGrouping(column.type)) {
      const top = await engine.runInternal(
        `SELECT CASE WHEN ${columnId} IS NULL THEN NULL ELSE CAST(${columnId} AS VARCHAR) END AS value, count(*) AS count FROM ${tableId} GROUP BY ${columnId} ORDER BY count DESC, value ASC NULLS LAST LIMIT 10`
      );
      profile.topValues = top.map((row) => ({ value: row.value === null ? null : String(row.value), count: numberValue(row.count) ?? 0 }));
    }
    return profile as ColumnProfile;
  } catch (error) {
    return {
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function profileDataset(engine: AtlasEngine, table = "dataset"): Promise<DatasetProfile> {
  const [rowCount, schema] = await Promise.all([engine.count(table), engine.describe(table)]);
  const warnings: string[] = [];
  const analyzed = schema.slice(0, 100);
  if (schema.length > analyzed.length) warnings.push(`Column statistics limited to the first ${analyzed.length} of ${schema.length} columns.`);
  const columns: ColumnProfile[] = [];
  for (const column of analyzed) columns.push(await profileColumn(engine, table, column, rowCount));
  const sampleHash = schema.length > 0
    ? `hash(${schema.map((column) => quoteIdentifier(column.name)).join(", ")})`
    : "0";
  const sampleRows = await engine.runInternal(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${sampleHash} ASC LIMIT 20`);
  return { rowCount, columnCount: schema.length, columns, sampleRows, warnings };
}

export type DatasetComparison = Readonly<{
  rows: Readonly<{ left: number; right: number; difference: number; percentChange: number | null }>;
  schema: Readonly<{
    shared: readonly string[];
    leftOnly: readonly string[];
    rightOnly: readonly string[];
    typeChanges: readonly Readonly<{ column: string; leftType: string; rightType: string }>[];
  }>;
  columnDrift: readonly Readonly<{
    column: string;
    leftNullRate?: number;
    rightNullRate?: number;
    nullRateDelta?: number;
    leftApproximateDistinct?: number;
    rightApproximateDistinct?: number;
  }>[];
  keyOverlap?: Readonly<{ keys: readonly string[]; leftDistinct: number; rightDistinct: number; intersection: number }>;
  warnings: readonly string[];
}>;

function profileMap(profile: DatasetProfile): Map<string, ColumnProfile> {
  return new Map(profile.columns.map((column) => [column.name, column]));
}

export async function compareDatasets(engine: AtlasEngine, keyColumns: readonly string[] = []): Promise<DatasetComparison> {
  const [left, right, leftSchema, rightSchema] = await Promise.all([
    profileDataset(engine, "left_dataset"), profileDataset(engine, "right_dataset"),
    engine.describe("left_dataset"), engine.describe("right_dataset"),
  ]);
  const leftTypes = new Map(leftSchema.map((column) => [column.name, column.type]));
  const rightTypes = new Map(rightSchema.map((column) => [column.name, column.type]));
  const shared = [...leftTypes.keys()].filter((name) => rightTypes.has(name)).sort();
  const leftOnly = [...leftTypes.keys()].filter((name) => !rightTypes.has(name)).sort();
  const rightOnly = [...rightTypes.keys()].filter((name) => !leftTypes.has(name)).sort();
  const typeChanges = shared
    .filter((column) => leftTypes.get(column) !== rightTypes.get(column))
    .map((column) => ({ column, leftType: leftTypes.get(column)!, rightType: rightTypes.get(column)! }));
  const leftProfiles = profileMap(left);
  const rightProfiles = profileMap(right);
  const columnDrift = shared.map((column) => {
    const l = leftProfiles.get(column);
    const r = rightProfiles.get(column);
    const delta = l?.nullRate !== undefined && r?.nullRate !== undefined ? Number((r.nullRate - l.nullRate).toFixed(6)) : undefined;
    return {
      column,
      leftNullRate: l?.nullRate,
      rightNullRate: r?.nullRate,
      nullRateDelta: delta,
      leftApproximateDistinct: l?.approximateDistinct,
      rightApproximateDistinct: r?.approximateDistinct,
    };
  });
  const warnings = [...left.warnings.map((warning) => `left: ${warning}`), ...right.warnings.map((warning) => `right: ${warning}`)];
  let keyOverlap: DatasetComparison["keyOverlap"];
  if (keyColumns.length > 0) {
    const uniqueKeys = [...new Set(keyColumns)];
    for (const key of uniqueKeys) if (!shared.includes(key)) throw new Error(`Comparison key ${key} is not present in both datasets`);
    const select = uniqueKeys.map(quoteIdentifier).join(", ");
    const join = uniqueKeys.map((key) => `l.${quoteIdentifier(key)} IS NOT DISTINCT FROM r.${quoteIdentifier(key)}`).join(" AND ");
    const [counts] = await engine.runInternal(
      `WITH l AS (SELECT DISTINCT ${select} FROM "left_dataset"), r AS (SELECT DISTINCT ${select} FROM "right_dataset") SELECT (SELECT count(*) FROM l) AS left_distinct, (SELECT count(*) FROM r) AS right_distinct, (SELECT count(*) FROM l INNER JOIN r ON ${join}) AS intersection`
    );
    keyOverlap = {
      keys: uniqueKeys,
      leftDistinct: numberValue(counts?.left_distinct) ?? 0,
      rightDistinct: numberValue(counts?.right_distinct) ?? 0,
      intersection: numberValue(counts?.intersection) ?? 0,
    };
  }
  return {
    rows: {
      left: left.rowCount,
      right: right.rowCount,
      difference: right.rowCount - left.rowCount,
      percentChange: left.rowCount === 0 ? null : Number((((right.rowCount - left.rowCount) / left.rowCount) * 100).toFixed(4)),
    },
    schema: { shared, leftOnly, rightOnly, typeChanges },
    columnDrift,
    keyOverlap,
    warnings,
  };
}

export type DatasetResearch = Readonly<{
  objective: string;
  profile: DatasetProfile;
  duplicateEstimate?: number;
  correlations: readonly Readonly<{ left: string; right: string; correlation: number | null }>[];
  outliers: readonly Readonly<{ column: string; lowerFence: number; upperFence: number; count: number }>[];
  trend?: readonly Record<string, unknown>[];
  findings: readonly string[];
  warnings: readonly string[];
}>;

export async function researchDataset(
  engine: AtlasEngine,
  objective: string,
  options: Readonly<{ dateColumn?: string; metricColumn?: string }> = {}
): Promise<DatasetResearch> {
  const profile = await profileDataset(engine);
  const numeric = profile.columns.filter((column) => isNumeric(column.type)).slice(0, 12);
  const correlations: Array<{ left: string; right: string; correlation: number | null }> = [];
  for (let left = 0; left < numeric.length; left += 1) {
    for (let right = left + 1; right < numeric.length && correlations.length < 40; right += 1) {
      const a = numeric[left]!;
      const b = numeric[right]!;
      const [row] = await engine.runInternal(
        `SELECT corr(${quoteIdentifier(a.name)}, ${quoteIdentifier(b.name)}) AS correlation FROM "dataset"`
      );
      correlations.push({ left: a.name, right: b.name, correlation: numberValue(row?.correlation) ?? null });
    }
  }
  const outliers: Array<{ column: string; lowerFence: number; upperFence: number; count: number }> = [];
  for (const column of numeric) {
    const id = quoteIdentifier(column.name);
    const [row] = await engine.runInternal(
      `WITH q AS (SELECT quantile_cont(${id}, 0.25) AS q1, quantile_cont(${id}, 0.75) AS q3 FROM "dataset") SELECT q1 - 1.5 * (q3 - q1) AS lower_fence, q3 + 1.5 * (q3 - q1) AS upper_fence, count(*) FILTER (WHERE ${id} < q1 - 1.5 * (q3 - q1) OR ${id} > q3 + 1.5 * (q3 - q1)) AS outlier_count FROM "dataset", q GROUP BY q1, q3`
    );
    const lowerFence = numberValue(row?.lower_fence);
    const upperFence = numberValue(row?.upper_fence);
    if (lowerFence !== undefined && upperFence !== undefined) outliers.push({ column: column.name, lowerFence, upperFence, count: numberValue(row?.outlier_count) ?? 0 });
  }
  let duplicateEstimate: number | undefined;
  try {
    const [row] = await engine.runInternal(`SELECT count(*) - count(DISTINCT hash(*)) AS duplicate_estimate FROM "dataset"`);
    duplicateEstimate = numberValue(row?.duplicate_estimate);
  } catch {
    // Some nested schemas cannot be row-hashed; omit rather than fail research.
  }
  let trend: Record<string, unknown>[] | undefined;
  if (options.dateColumn) {
    const date = profile.columns.find((column) => column.name === options.dateColumn);
    if (!date) throw new Error(`Unknown date column: ${options.dateColumn}`);
    const dateId = quoteIdentifier(date.name);
    if (options.metricColumn) {
      const metric = profile.columns.find((column) => column.name === options.metricColumn);
      if (!metric || !isNumeric(metric.type)) throw new Error("metricColumn must name a numeric column");
      trend = await engine.runInternal(
        `SELECT date_trunc('month', TRY_CAST(${dateId} AS TIMESTAMP)) AS period, avg(${quoteIdentifier(metric.name)}) AS average, sum(${quoteIdentifier(metric.name)}) AS total, count(*) AS rows FROM "dataset" WHERE TRY_CAST(${dateId} AS TIMESTAMP) IS NOT NULL GROUP BY period ORDER BY period LIMIT 240`
      );
    } else {
      trend = await engine.runInternal(
        `SELECT date_trunc('month', TRY_CAST(${dateId} AS TIMESTAMP)) AS period, count(*) AS rows FROM "dataset" WHERE TRY_CAST(${dateId} AS TIMESTAMP) IS NOT NULL GROUP BY period ORDER BY period LIMIT 240`
      );
    }
  }
  const findings: string[] = [];
  if (profile.rowCount === 0) findings.push("The dataset has no rows.");
  const highMissing = profile.columns.filter((column) => (column.nullRate ?? 0) >= 0.2);
  if (highMissing.length) findings.push(`${highMissing.length} columns have at least 20% missing values: ${highMissing.map((column) => column.name).join(", ")}.`);
  if ((duplicateEstimate ?? 0) > 0) findings.push(`Approximately ${duplicateEstimate} rows share a complete-row hash with another row.`);
  const strong = correlations.filter((item) => item.correlation !== null && Math.abs(item.correlation) >= 0.8);
  if (strong.length) findings.push(`${strong.length} numeric column pairs have |Pearson correlation| >= 0.8.`);
  const outlierTotal = outliers.reduce((sum, item) => sum + item.count, 0);
  if (outlierTotal) findings.push(`${outlierTotal} IQR outlier observations were detected across ${outliers.filter((item) => item.count > 0).length} numeric columns.`);
  if (!findings.length) findings.push("No high-severity data-quality pattern was detected by the deterministic checks.");
  return {
    objective,
    profile,
    duplicateEstimate,
    correlations,
    outliers,
    trend,
    findings,
    warnings: [...profile.warnings, "Findings are deterministic descriptive statistics, not causal conclusions."],
  };
}
