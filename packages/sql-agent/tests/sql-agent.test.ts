import { describe, expect, it } from "vitest";
import {
  buildMetadataAwareSelectQuery,
  buildSafeLimitClause,
  validateSqlStatement
} from "../src/index.js";

const metadataContext = {
  tables: [
    {
      name: "Tenant",
      columns: [
        { name: "id", dataType: "String" },
        { name: "name", dataType: "String" },
        { name: "createdAt", dataType: "DateTime" }
      ]
    },
    {
      name: "AuditLog",
      columns: [
        { name: "id", dataType: "String" },
        { name: "tenantId", dataType: "String" },
        { name: "action", dataType: "String" },
        { name: "createdAt", dataType: "DateTime" }
      ]
    }
  ],
  maxLimit: 250
} as const;

const postgresMetadataContext = {
  tables: [
    {
      name: "cda_customers",
      columns: [
        { name: "id", dataType: "integer" },
        { name: "name", dataType: "text" },
        { name: "region", dataType: "text" }
      ]
    },
    {
      name: "cda_orders",
      columns: [
        { name: "id", dataType: "integer" },
        { name: "customer_id", dataType: "integer" },
        { name: "amount", dataType: "numeric" },
        { name: "status", dataType: "text" }
      ]
    }
  ],
  maxLimit: 500
} as const;

describe("sql-agent", () => {
  it("accepts safe select statements with a limit", () => {
    const result = validateSqlStatement("select id, name from Tenant limit 20", metadataContext);

    expect(result.allowed).toBe(true);
    expect(result.normalizedSql).toBe("select id, name from Tenant limit 20");
    expect(result.referencedTables).toEqual(["Tenant"]);
    expect(result.referencedColumns).toEqual(["id", "name"]);
    expect(result.limit).toBe(20);
  });

  it("accepts safe join statements with aliases", () => {
    const result = validateSqlStatement(
      "select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id where o.amount > 10 limit 20",
      postgresMetadataContext
    );

    expect(result.allowed).toBe(true);
    expect(result.referencedTables).toEqual(["cda_orders", "cda_customers"]);
    expect(result.referencedColumns).toEqual([
      "o.id",
      "c.name",
      "o.amount",
      "o.customer_id",
      "c.id"
    ]);
  });

  it("accepts CTE statements that project known columns", () => {
    const result = validateSqlStatement(
      "with recent as (select id, customer_id from cda_orders limit 25) select r.id from recent r limit 10",
      postgresMetadataContext
    );

    expect(result.allowed).toBe(true);
    expect(result.referencedTables).toEqual(["cda_orders", "recent"]);
    expect(result.referencedColumns).toEqual(["id", "customer_id", "r.id"]);
  });

  it("rejects destructive statements", () => {
    const result = validateSqlStatement("drop table orders");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT");
  });

  it("rejects restricted patterns inside otherwise selectable SQL", () => {
    const result = validateSqlStatement("select * from Tenant; drop table Tenant");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("restricted pattern");
  });

  it("rejects unknown table references when metadata is provided", () => {
    const result = validateSqlStatement("select id from Orders limit 20", metadataContext);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unknown table references");
  });

  it("rejects unknown selected columns when metadata is provided", () => {
    const result = validateSqlStatement(
      "select o.missing_column from cda_orders o limit 20",
      postgresMetadataContext
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unknown column");
  });

  it("rejects unknown join columns when metadata is provided", () => {
    const result = validateSqlStatement(
      "select o.id from cda_orders o join cda_customers c on o.missing_id = c.id limit 20",
      postgresMetadataContext
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unknown column");
  });

  it("rejects ambiguous unqualified columns", () => {
    const result = validateSqlStatement(
      "select id from cda_orders o join cda_customers c on o.customer_id = c.id limit 20",
      postgresMetadataContext
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Ambiguous column");
  });

  it("requires a limit when metadata-backed validation is used", () => {
    const result = validateSqlStatement("select id from Tenant", metadataContext);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("must include a LIMIT");
  });

  it("can disable the default limit requirement", () => {
    const result = validateSqlStatement("select id from Tenant", {
      ...metadataContext,
      requireLimit: false
    });

    expect(result.allowed).toBe(true);
  });

  it("enforces the configured metadata limit", () => {
    const result = validateSqlStatement("select id from Tenant limit 500", metadataContext);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("configured maximum");
  });

  it("rejects SELECT INTO because it can create data", () => {
    const result = validateSqlStatement(
      "select id into archived_tenants from Tenant limit 20",
      metadataContext
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT INTO");
  });

  it("builds a bounded limit clause", () => {
    expect(buildSafeLimitClause(25)).toBe("limit 25");
  });

  it("builds metadata-aware select queries", () => {
    expect(
      buildMetadataAwareSelectQuery(
        {
          tableName: "Tenant",
          columns: ["id", "name"],
          limit: 25
        },
        metadataContext
      )
    ).toBe("select id, name from Tenant limit 25");
  });
});
