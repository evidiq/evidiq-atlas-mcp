import { afterEach, describe, expect, it } from "vitest";
import { materializeDataset } from "../lib/atlas/ingest.js";
import { AtlasEngine, validateReadOnlySql } from "../lib/atlas/engine.js";
import { compareDatasets, profileDataset, researchDataset } from "../lib/atlas/analyze.js";
import { visualizeDataset } from "../lib/atlas/visualize.js";

const engines: AtlasEngine[] = [];
afterEach(async () => {
  while (engines.length) await engines.pop()!.close();
});

async function engineFor(csv: string, table = "dataset"): Promise<AtlasEngine> {
  const dataset = await materializeDataset({ kind: "inline", format: "csv", data: csv });
  const engine = await AtlasEngine.create({ [table]: dataset });
  engines.push(engine);
  return engine;
}

describe("Atlas DuckDB engine", () => {
  it("profiles, queries, visualizes, and researches deterministically", async () => {
    const engine = await engineFor(
      "id,region,revenue,date\n1,APAC,10,2026-01-01\n2,EMEA,20,2026-02-01\n3,APAC,30,2026-03-01"
    );
    const profile = await profileDataset(engine);
    expect(profile.rowCount).toBe(3);
    expect(profile.columns.map((column) => column.name)).toEqual(["id", "region", "revenue", "date"]);

    const query = await engine.query(
      "SELECT region, sum(revenue) AS total FROM dataset GROUP BY region ORDER BY total DESC",
      10
    );
    expect(query.rows).toEqual([
      { region: "APAC", total: "40" },
      { region: "EMEA", total: "20" },
    ]);
    expect(query.deterministic).toBe(true);

    const firstChart = await visualizeDataset(engine, {
      type: "bar", x: "region", y: "revenue", aggregation: "sum", limit: 100,
    });
    const secondChart = await visualizeDataset(engine, {
      type: "bar", x: "region", y: "revenue", aggregation: "sum", limit: 100,
    });
    expect(firstChart).toEqual(secondChart);
    expect(firstChart.spec.data).toHaveLength(1);

    const limitedCharts = await Promise.all([
      visualizeDataset(engine, { type: "line", x: "date", y: "revenue", limit: 2 }),
      visualizeDataset(engine, { type: "scatter", x: "id", y: "revenue", limit: 2 }),
      visualizeDataset(engine, { type: "histogram", x: "revenue", limit: 2 }),
      visualizeDataset(engine, { type: "box", x: "revenue", limit: 2 }),
    ]);
    expect(limitedCharts.map((chart) => chart.rowsUsed)).toEqual([2, 2, 2, 2]);

    const research = await researchDataset(engine, "Find quality and trends", {
      dateColumn: "date",
      metricColumn: "revenue",
    });
    expect(research.profile.rowCount).toBe(3);
    expect(research.trend).toHaveLength(3);
  });

  it("rejects writes, external readers, introspection, system schemas, and table functions", async () => {
    const engine = await engineFor("id,value\n1,10\n2,20");
    const rejected = [
      "DELETE FROM dataset",
      "SELECT * FROM read_csv('/etc/passwd')",
      "SELECT * FROM \"read_csv\"('/etc/passwd')",
      "SELECT * FROM dataset; SELECT * FROM dataset",
      "PRAGMA version",
      "SELECT * FROM duckdb_settings()",
      "SELECT * FROM \"duckdb_settings\"()",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM \"information_schema\".\"tables\"",
      "SELECT * FROM pg_catalog.pg_tables",
      "SELECT * FROM system.main.dataset",
      "SELECT * FROM range(2)",
      "SELECT * FROM (range(2))",
      "SELECT * FROM dataset JOIN \"range\"(2) AS generated(i) ON true",
      "SELECT * FROM dataset, unnest([1, 2]) AS generated(i)",
      "SELECT query('SELECT 1')",
      "SELECT * FROM \"query_table\"('dataset')",
      "SELECT write_log('blocked')",
      "SELECT current_setting('threads')",
      "SELECT * FROM pragma_table_info('dataset')",
      "SELECT * FROM parquet_metadata('/tmp/data.parquet')",
      "ATTACH '/tmp/other.db' AS other",
      "COPY dataset TO '/tmp/out.csv'",
    ];
    for (const sql of rejected) {
      expect(() => validateReadOnlySql(sql), sql).toThrow();
      await expect(engine.query(sql), sql).rejects.toThrow();
    }
    expect(validateReadOnlySql("WITH totals AS (SELECT sum(value) value FROM dataset) SELECT * FROM totals"))
      .toContain("WITH totals");
  });

  it("rejects volatile SQL while allowing ordinary quoted columns", async () => {
    const engine = await engineFor(
      "random,uuid,now,current_timestamp,duckdb_settings,query\n1,a,2,3,4,5\n2,b,3,4,5,6"
    );
    const rejected = [
      "SELECT random()",
      "SELECT \"random\"()",
      "SELECT random_normal(0, 1)",
      "SELECT uuid()",
      "SELECT \"uuid\"()",
      "SELECT uuidv4()",
      "SELECT uuidv7()",
      "SELECT now()",
      "SELECT \"now\"()",
      "SELECT today()",
      "SELECT transaction_timestamp()",
      "SELECT CURRENT_TIMESTAMP",
      "SELECT current_timestamp()",
      "SELECT \"current_timestamp\"()",
      "SELECT CURRENT_DATE",
      "SELECT \"current_date\"()",
      "SELECT CURRENT_TIME",
      "SELECT LOCALTIMESTAMP",
      "SELECT LOCALTIME",
      "SELECT current timestamp",
      "SELECT * FROM dataset USING SAMPLE 1 ROWS",
    ];
    for (const sql of rejected) {
      expect(() => validateReadOnlySql(sql), sql).toThrow();
      await expect(engine.query(sql), sql).rejects.toThrow();
    }

    const quoted = await engine.query(
      "SELECT \"random\", \"uuid\", \"now\", \"current_timestamp\", \"duckdb_settings\", \"query\" FROM dataset ORDER BY \"random\""
    );
    expect(quoted.rowCount).toBe(2);
    expect(quoted.deterministic).toBe(true);
  });

  it("rejects DuckDB volatile, introspection, and resource functions before execution", async () => {
    const engine = await engineFor("id,value\n1,10\n2,20");
    const volatileOrResource = [
      "SELECT current_query_id() AS result ORDER BY result",
      "SELECT \"current_query_id\"() AS result ORDER BY result",
      "SELECT current_transaction_id() AS result ORDER BY result",
      "SELECT \"current_transaction_id\"() AS result ORDER BY result",
      "SELECT txid_current() AS result ORDER BY result",
      "SELECT \"txid_current\"() AS result ORDER BY result",
      "SELECT sleep(0) AS result ORDER BY result",
      "SELECT \"sleep\"(0) AS result ORDER BY result",
      "SELECT sleep_ms(0) AS result ORDER BY result",
      "SELECT \"sleep_ms\"(0) AS result ORDER BY result",
    ];
    for (const sql of volatileOrResource) {
      expect(() => validateReadOnlySql(sql), sql).toThrow("SQL contains a volatile or non-reproducible function");
      await expect(engine.query(sql), sql).rejects.toThrow("SQL contains a volatile or non-reproducible function");
    }

    const introspection = [
      "SELECT stats(value) AS result FROM dataset ORDER BY result",
      "SELECT \"stats\"(value) AS result FROM dataset ORDER BY result",
    ];
    for (const sql of introspection) {
      expect(() => validateReadOnlySql(sql), sql).toThrow("SQL contains a forbidden external or introspection function");
      await expect(engine.query(sql), sql).rejects.toThrow("SQL contains a forbidden external or introspection function");
    }
  });

  it("uses color as a stable final tie-breaker for limited bar charts", async () => {
    const engine = await engineFor(
      "category,series,value\nA,zeta,10\nA,,10\nA,beta,10\nA,alpha,10\nB,aaa,10"
    );
    const request = {
      type: "bar", x: "category", y: "value", color: "series", aggregation: "sum", limit: 3,
    } as const;

    const charts = [];
    for (let run = 0; run < 5; run += 1) charts.push(await visualizeDataset(engine, request));

    for (const chart of charts.slice(1)) expect(chart).toEqual(charts[0]);
    expect(charts[0]!.rowsUsed).toBe(3);
    expect(charts[0]!.spec.data.map((trace) => trace.name)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("marks only queries with an effective outer ORDER BY as deterministic", async () => {
    const engine = await engineFor("id,value\n2,20\n1,10\n3,30");

    const unordered = await engine.query("SELECT id, value FROM dataset");
    const ordered = await engine.query("SELECT id, value FROM dataset ORDER BY id");
    const cteOrderOnly = await engine.query(
      "WITH ordered_rows AS (SELECT id, value FROM dataset ORDER BY id) SELECT * FROM ordered_rows"
    );
    const windowOrderOnly = await engine.query(
      "SELECT id, row_number() OVER (ORDER BY id) AS position FROM dataset"
    );
    const orderedCte = await engine.query(
      "WITH rows AS (SELECT id, value FROM dataset) SELECT * FROM rows ORDER BY id"
    );

    expect(unordered.deterministic).toBe(false);
    expect(ordered.deterministic).toBe(true);
    expect(cteOrderOnly.deterministic).toBe(false);
    expect(windowOrderOnly.deterministic).toBe(false);
    expect(orderedCte.deterministic).toBe(true);
  });

  it("enforces result row limits", async () => {
    const engine = await engineFor("id\n1\n2\n3\n4");
    const result = await engine.query("SELECT * FROM dataset ORDER BY id", 2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.deterministic).toBe(true);
  });

  it("compares schemas and distinct keys", async () => {
    const left = await materializeDataset({ kind: "inline", format: "csv", data: "id,value\n1,10\n2,20" });
    const right = await materializeDataset({ kind: "inline", format: "csv", data: "id,value,extra\n2,25,x\n3,30,y" });
    const engine = await AtlasEngine.create({ left_dataset: left, right_dataset: right });
    engines.push(engine);
    const result = await compareDatasets(engine, ["id"]);
    expect(result.schema.rightOnly).toEqual(["extra"]);
    expect(result.keyOverlap).toMatchObject({ leftDistinct: 2, rightDistinct: 2, intersection: 1 });
  });
});
