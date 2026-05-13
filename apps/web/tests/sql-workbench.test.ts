import { describe, expect, it } from "vitest";
import {
  buildSqlExportFileName,
  buildSqlPreview,
  convertSqlResultToCsv,
  createSqlHistoryEntry,
  parseSqlHistory,
  serializeSqlHistory,
  upsertSqlHistory
} from "../src/sql-workbench.js";

describe("sql workbench helpers", () => {
  it("deduplicates history entries by sql and keeps the newest entry first", () => {
    const first = createSqlHistoryEntry("select id from Tenant limit 10", {
      columns: ["id"],
      rows: [{ id: "tenant-a" }],
      rowCount: 1,
      durationMs: 8,
      validation: {
        allowed: true,
        normalizedSql: "select id from Tenant limit 10",
        referencedTables: ["Tenant"],
        referencedColumns: ["id"],
        limit: 10
      }
    }, {
      id: "first",
      executedAt: "2026-05-12T10:00:00.000Z"
    });
    const second = createSqlHistoryEntry(" SELECT  id  FROM tenant LIMIT 10 ", {
      columns: ["id"],
      rows: [{ id: "tenant-b" }],
      rowCount: 1,
      durationMs: 4,
      validation: {
        allowed: true,
        normalizedSql: "select id from Tenant limit 10",
        referencedTables: ["Tenant"],
        referencedColumns: ["id"],
        limit: 10
      }
    }, {
      id: "second",
      executedAt: "2026-05-12T11:00:00.000Z"
    });

    const history = upsertSqlHistory([first], second, 6);

    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe("second");
    expect(history[0]?.result.rows[0]).toEqual({ id: "tenant-b" });
  });

  it("serializes and parses history payloads", () => {
    const entry = createSqlHistoryEntry("select id from Tenant limit 1", {
      columns: ["id"],
      rows: [{ id: "tenant-a" }],
      rowCount: 1,
      durationMs: 5,
      validation: {
        allowed: true,
        normalizedSql: "select id from Tenant limit 1",
        referencedTables: ["Tenant"],
        referencedColumns: ["id"],
        limit: 1
      }
    }, {
      id: "history-1",
      executedAt: "2026-05-12T12:00:00.000Z"
    });

    expect(parseSqlHistory(serializeSqlHistory([entry]))).toEqual([entry]);
  });

  it("rejects invalid history payloads", () => {
    expect(() => parseSqlHistory("{bad json")).toThrow("SQL history is not valid JSON");
    expect(() => parseSqlHistory(JSON.stringify({ version: 1, entries: [{ sql: 1 }] }))).toThrow(
      "SQL history payload is invalid"
    );
  });

  it("formats sql previews and export file names", () => {
    expect(buildSqlPreview("select   id  from Tenant limit 20")).toBe(
      "select id from Tenant limit 20"
    );
    expect(buildSqlExportFileName("2026-05-12T14:03:04.987Z")).toBe(
      "clusterdata-query-2026-05-12T14-03-04-987Z.csv"
    );
  });

  it("exports query results to escaped csv", () => {
    const csv = convertSqlResultToCsv({
      columns: ["id", "name", "notes", "meta"],
      rows: [
        {
          id: "tenant-a",
          name: "Tenant, A",
          notes: 'said "hello"',
          meta: { active: true }
        },
        {
          id: "tenant-b",
          name: "Tenant B",
          notes: null,
          meta: ["north", "south"]
        }
      ],
      rowCount: 2,
      durationMs: 9,
      validation: {
        allowed: true,
        normalizedSql: "select id, name from Tenant limit 2",
        referencedTables: ["Tenant"],
        referencedColumns: ["id", "name"],
        limit: 2
      }
    });

    expect(csv).toBe(
      [
        "id,name,notes,meta",
        'tenant-a,"Tenant, A","said ""hello""","{""active"":true}"',
        'tenant-b,Tenant B,,"[""north"",""south""]"',
        ""
      ].join("\n")
    );
  });
});
