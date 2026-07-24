import { AtlasEngine, quoteIdentifier, type DatasetColumn } from "./engine.js";
import type { Aggregation, ChartRequest, ChartType } from "./schemas.js";

export type PlotlyCompatibleSpec = Readonly<{
  data: readonly Record<string, unknown>[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
  meta: Record<string, unknown>;
}>;

function numeric(column: DatasetColumn): boolean {
  return /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)/i.test(column.type);
}

function temporal(column: DatasetColumn): boolean {
  return /^(DATE|TIMESTAMP|TIME)/i.test(column.type);
}

function chooseType(requested: ChartType, x: DatasetColumn, y?: DatasetColumn): Exclude<ChartType, "auto"> {
  if (requested !== "auto") return requested;
  if (y && temporal(x) && numeric(y)) return "line";
  if (y && numeric(x) && numeric(y)) return "scatter";
  return "bar";
}

function requireColumn(schema: readonly DatasetColumn[], name: string): DatasetColumn {
  const column = schema.find((item) => item.name === name);
  if (!column) throw new Error(`Unknown chart column: ${name}`);
  return column;
}

function groupRows(rows: readonly Record<string, unknown>[], color: string | undefined): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = color ? String(row.color ?? "(null)") : "dataset";
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return groups;
}

function aggregateExpression(aggregation: Aggregation, y?: string): string {
  if (aggregation === "count") return "count(*)";
  if (!y) throw new Error(`${aggregation} aggregation requires a y column`);
  return `${aggregation}(${quoteIdentifier(y)})`;
}

function stableRowHash(schema: readonly DatasetColumn[]): string {
  return `hash(${schema.map((column) => quoteIdentifier(column.name)).join(", ")})`;
}

export async function visualizeDataset(engine: AtlasEngine, request: ChartRequest): Promise<{ chartType: string; spec: PlotlyCompatibleSpec; rowsUsed: number }> {
  const schema = await engine.describe("dataset");
  const stableHash = stableRowHash(schema);
  const x = requireColumn(schema, request.x);
  const y = request.y ? requireColumn(schema, request.y) : undefined;
  if (request.color) requireColumn(schema, request.color);
  const chartType = chooseType(request.type, x, y);
  const xId = quoteIdentifier(x.name);
  const yId = y ? quoteIdentifier(y.name) : undefined;
  const colorSelect = request.color ? `, ${quoteIdentifier(request.color)} AS color` : "";
  let rows: Record<string, unknown>[];
  let data: Record<string, unknown>[];

  if (chartType === "bar") {
    const aggregation = request.aggregation ?? (y ? "sum" : "count");
    const expression = aggregateExpression(aggregation, y?.name);
    const groupColor = request.color ? `, ${quoteIdentifier(request.color)}` : "";
    const colorOrder = request.color ? ", color ASC NULLS LAST" : "";
    rows = await engine.runInternal(
      `SELECT ${xId} AS x${colorSelect}, ${expression} AS y FROM "dataset" WHERE ${xId} IS NOT NULL${yId && aggregation !== "count" ? ` AND ${yId} IS NOT NULL` : ""} GROUP BY ${xId}${groupColor} ORDER BY y DESC, x ASC${colorOrder} LIMIT ${request.limit}`
    );
    data = [...groupRows(rows, request.color).entries()].map(([name, items]) => ({
      type: "bar", name, x: items.map((row) => row.x), y: items.map((row) => row.y),
    }));
  } else if (chartType === "line" || chartType === "scatter") {
    if (!yId) throw new Error(`${chartType} chart requires a y column`);
    rows = await engine.runInternal(
      `SELECT ${xId} AS x, ${yId} AS y${colorSelect} FROM "dataset" WHERE ${xId} IS NOT NULL AND ${yId} IS NOT NULL ORDER BY ${xId} ASC, ${stableHash} ASC LIMIT ${request.limit}`
    );
    data = [...groupRows(rows, request.color).entries()].map(([name, items]) => ({
      type: "scatter", mode: chartType === "line" ? "lines+markers" : "markers", name,
      x: items.map((row) => row.x), y: items.map((row) => row.y),
    }));
  } else if (chartType === "histogram") {
    rows = await engine.runInternal(`SELECT ${xId} AS x${colorSelect} FROM "dataset" WHERE ${xId} IS NOT NULL ORDER BY ${stableHash} ASC LIMIT ${request.limit}`);
    data = [...groupRows(rows, request.color).entries()].map(([name, items]) => ({
      type: "histogram", name, x: items.map((row) => row.x), nbinsx: Math.min(100, Math.max(10, Math.round(Math.sqrt(items.length)))),
    }));
  } else {
    const value = y ?? x;
    const valueId = quoteIdentifier(value.name);
    rows = await engine.runInternal(`SELECT ${valueId} AS y${colorSelect} FROM "dataset" WHERE ${valueId} IS NOT NULL ORDER BY ${stableHash} ASC LIMIT ${request.limit}`);
    data = [...groupRows(rows, request.color).entries()].map(([name, items]) => ({
      type: "box", name, y: items.map((row) => row.y), boxpoints: "outliers",
    }));
  }

  const title = request.title || `${chartType[0]!.toUpperCase()}${chartType.slice(1)} of ${request.x}${request.y ? ` vs ${request.y}` : ""}`;
  return {
    chartType,
    rowsUsed: rows.length,
    spec: {
      data,
      layout: {
        title: { text: title },
        xaxis: { title: { text: request.x } },
        yaxis: { title: { text: request.y || request.aggregation || "count" } },
        template: "plotly_white",
        showlegend: Boolean(request.color),
      },
      config: { responsive: true, displaylogo: false, staticPlot: false },
      meta: {
        schema: "plotly-compatible-v1",
        generatedBy: "EVIDIQ Atlas",
        deterministic: true,
        sourceTable: "dataset",
        rowLimit: request.limit,
      },
    },
  };
}
