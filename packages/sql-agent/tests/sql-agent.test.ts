import { describe, expect, it } from "vitest";
import { buildSafeLimitClause, validateSqlStatement } from "../src/index.js";

describe("sql-agent", () => {
  it("accepts safe select statements", () => {
    const result = validateSqlStatement("select * from orders");

    expect(result.allowed).toBe(true);
    expect(result.normalizedSql).toBe("select * from orders");
  });

  it("rejects destructive statements", () => {
    const result = validateSqlStatement("drop table orders");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT");
  });

  it("builds a bounded limit clause", () => {
    expect(buildSafeLimitClause(25)).toBe("limit 25");
  });
});
