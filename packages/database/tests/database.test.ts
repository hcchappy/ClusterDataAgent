import { describe, expect, it } from "vitest";
import { summarizeDatabaseConfig } from "../src/index.js";

describe("database", () => {
  it("summarizes database configuration", () => {
    const summary = summarizeDatabaseConfig({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/clusterdata"
    });

    expect(summary.configured).toBe(true);
    expect(summary.dialect).toBe("postgresql");
  });
});

