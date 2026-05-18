import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  buildQueryResultCacheKey,
  InMemoryAsyncQueryJobManager,
  InMemoryQueryResultCache,
  paginateReadOnlyQueryResult,
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

  it("builds stable cache keys without exposing raw sql", () => {
    const first = buildQueryResultCacheKey([
      "sql.query",
      "analyst",
      "select id from Tenant limit 20"
    ]);
    const second = buildQueryResultCacheKey([
      "sql.query",
      "analyst",
      "select id from Tenant limit 20"
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^query:[a-f0-9]{64}$/);
    expect(first).not.toContain("select id");
  });

  it("stores query results in an in-memory cache with ttl eviction", () => {
    let now = Date.parse("2026-05-18T08:00:00.000Z");
    const cache = new InMemoryQueryResultCache<{ readonly rowCount: number }>({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now
    });

    const stored = cache.set("query:a", {
      rowCount: 2
    });

    expect(stored.hitCount).toBe(0);
    expect(cache.get("query:a")).toMatchObject({
      key: "query:a",
      value: {
        rowCount: 2
      },
      hitCount: 1
    });

    now += 1_100;

    expect(cache.get("query:a")).toBeUndefined();
  });

  it("evicts the oldest cached results when the cache reaches capacity", () => {
    const cache = new InMemoryQueryResultCache<{ readonly rowCount: number }>({
      ttlMs: 5_000,
      maxEntries: 2,
      now: () => Date.parse("2026-05-18T08:00:00.000Z")
    });

    cache.set("query:a", {
      rowCount: 1
    });
    cache.set("query:b", {
      rowCount: 2
    });
    cache.set("query:c", {
      rowCount: 3
    });

    expect(cache.get("query:a")).toBeUndefined();
    expect(cache.get("query:b")?.value.rowCount).toBe(2);
    expect(cache.get("query:c")?.value.rowCount).toBe(3);
  });

  it("tracks async query jobs through completion and failure", async () => {
    const jobManager = new InMemoryAsyncQueryJobManager<{ readonly rowCount: number }>({
      ttlMs: 5_000,
      maxEntries: 4,
      generateId: (() => {
        let index = 0;

        return () => `job-${++index}`;
      })()
    });

    const completedJob = jobManager.start(async () => ({ rowCount: 2 }), {
      cacheKey: "query:a"
    });
    jobManager.start(async () => {
      throw new Error("query failed");
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(completedJob).toMatchObject({
      jobId: "job-1",
      status: "running",
      cacheKey: "query:a"
    });
    expect(jobManager.get("job-1")).toMatchObject({
      jobId: "job-1",
      status: "completed",
      result: {
        rowCount: 2
      }
    });
    expect(jobManager.get("job-2")).toMatchObject({
      jobId: "job-2",
      status: "failed",
      error: {
        message: "query failed"
      }
    });
  });

  it("creates completed async query jobs directly from cached results", () => {
    const jobManager = new InMemoryAsyncQueryJobManager<{ readonly rowCount: number }>({
      ttlMs: 5_000,
      maxEntries: 4,
      generateId: () => "job-cache"
    });

    const job = jobManager.createCompleted(
      {
        rowCount: 3
      },
      {
        cacheKey: "query:cached"
      }
    );

    expect(job).toMatchObject({
      jobId: "job-cache",
      status: "completed",
      cacheKey: "query:cached",
      result: {
        rowCount: 3
      }
    });
  });

  it("paginates read-only query results without mutating the source result", () => {
    const result = paginateReadOnlyQueryResult(
      {
        columns: ["id"],
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
        durationMs: 12
      },
      {
        offset: 1,
        limit: 1
      }
    );

    expect(result.rows).toEqual([{ id: 2 }]);
    expect(result.page).toEqual({
      offset: 1,
      limit: 1,
      returnedRows: 1,
      hasMore: true
    });
    expect(result.rowCount).toBe(3);
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
