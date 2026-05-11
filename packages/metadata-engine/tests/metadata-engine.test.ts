import { describe, expect, it } from "vitest";
import { buildRelationGraph, summarizeMetadata } from "../src/index.js";

describe("metadata-engine", () => {
  it("builds relation edges from id-like columns", () => {
    const relations = buildRelationGraph([
      {
        name: "orders",
        columns: [{ name: "customer_id", dataType: "uuid" }]
      },
      {
        name: "customer",
        columns: [{ name: "id", dataType: "uuid" }]
      }
    ]);

    expect(relations).toEqual([
      {
        fromTable: "orders",
        fromColumn: "customer_id",
        toTable: "customer",
        toColumn: "id"
      }
    ]);
  });

  it("summarizes schema shape", () => {
    const summary = summarizeMetadata([
      { name: "orders", columns: [{ name: "id", dataType: "uuid" }] },
      { name: "customer", columns: [{ name: "id", dataType: "uuid" }] }
    ]);

    expect(summary.tableCount).toBe(2);
    expect(summary.columnCount).toBe(2);
    expect(summary.relationCount).toBe(0);
  });
});

