import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  type DatabaseQueryRow,
  PostgresReadOnlyQueryExecutor,
  summarizeDatabaseConfig,
  type PostgresClient
} from "../src/index.js";

describe("database", () => {
  it("keeps the PostgreSQL test fixture at 80 orders over 20 daily buckets", () => {
    const fixtureSql = readFileSync(
      new URL("../prisma/postgres-test-schema.sql", import.meta.url),
      "utf8"
    );

    expect(fixtureSql).toContain("generate_series(0, 19)");
    expect(fixtureSql).toContain("generate_series(1, 4)");
    expect(fixtureSql).toContain("order_count <> 80");
    expect(fixtureSql).toContain("having count(*) <> 4");
    expect(fixtureSql).toContain("Seeded % cda_orders rows across 20 days");
    expect(fixtureSql).toContain("'Acme Co'");
    expect(fixtureSql).toContain("'Wayne Wholesale'");
    expect(fixtureSql).toContain("'review_required'");
    expect(fixtureSql).toContain("'refunded'");
  });

  it("summarizes database configuration", () => {
    const summary = summarizeDatabaseConfig({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/clusterdata"
    });

    expect(summary.configured).toBe(true);
    expect(summary.dialect).toBe("postgresql");
  });

  it("executes read-only SQL queries inside a read-only transaction", async () => {
    const queries: string[] = [];
    const executor = new PostgresReadOnlyQueryExecutor({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/clusterdata",
      statementTimeoutMs: 5_000,
      clientFactory: () =>
        createFakeClient((sql) => {
          queries.push(sql);

          if (sql === "select id, name from tenants limit 2") {
            return {
              rows: [
                { id: "tenant-a", name: "Tenant A" },
                { id: "tenant-b", name: "Tenant B" }
              ],
              rowCount: 2,
              fields: [{ name: "id" }, { name: "name" }]
            };
          }

          return {
            rows: [],
            rowCount: 0,
            fields: []
          };
        })
    });

    const result = await executor.executeReadOnlyQuery(
      "select id, name from tenants limit 2"
    );

    expect(result).toEqual({
      columns: ["id", "name"],
      rows: [
        { id: "tenant-a", name: "Tenant A" },
        { id: "tenant-b", name: "Tenant B" }
      ],
      rowCount: 2,
      durationMs: expect.any(Number)
    });
    expect(queries).toEqual([
      "begin read only",
      "set local statement_timeout = 5000",
      "select id, name from tenants limit 2",
      "commit"
    ]);
  });

  it("rolls back failed read-only queries", async () => {
    const queries: string[] = [];
    const executor = new PostgresReadOnlyQueryExecutor({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/clusterdata",
      clientFactory: () =>
        createFakeClient((sql) => {
          queries.push(sql);

          if (sql === "select * from broken limit 1") {
            throw new Error("relation does not exist");
          }

          return {
            rows: [],
            rowCount: 0,
            fields: []
          };
        })
    });

    await expect(
      executor.executeReadOnlyQuery("select * from broken limit 1")
    ).rejects.toMatchObject({
      code: "DATABASE_QUERY_FAILED"
    });
    expect(queries).toEqual([
      "begin read only",
      "set local statement_timeout = 10000",
      "select * from broken limit 1",
      "rollback"
    ]);
  });
});

function createFakeClient(
  queryHandler: (
    sql: string
  ) => {
    readonly rows: readonly DatabaseQueryRow[];
    readonly rowCount?: number | null;
    readonly fields?: readonly { readonly name: string }[];
  }
): PostgresClient {
  return {
    async connect() {},
    async end() {},
    async query<T extends DatabaseQueryRow = DatabaseQueryRow>(sql: string) {
      const result = queryHandler(sql);

      return result as {
        readonly rows: readonly T[];
        readonly rowCount?: number | null;
        readonly fields?: readonly { readonly name: string }[];
      };
    }
  };
}
