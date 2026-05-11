import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AppShell } from "../src/App.js";

describe("web app", () => {
  it("renders the main panels", () => {
    const html = renderToString(
      <AppShell
        overview={{
          ok: true,
          manifest: {
            projectName: "ClusterDataAgent",
            currentGoal: "Initialize the monorepo foundation",
            nextPriority: "monorepo",
            rules: ["small commits"],
            summary: "ClusterDataAgent: Initialize the monorepo foundation"
          },
          metadata: {
            tableCount: 2,
            columnCount: 3,
            relationCount: 1
          },
          tools: [{ name: "validate-sql", description: "Validate SQL" }],
          security: { allowed: true }
        }}
        sqlResult={{
          allowed: true,
          normalizedSql: "select * from orders"
        }}
        seriesResult={{
          summary: {
            count: 5,
            minimum: 1,
            maximum: 8,
            average: 3.6,
            trend: "rising"
          }
        }}
        errorMessage={null}
      />
    );

    expect(html).toContain("Monorepo control surface");
    expect(html).toContain("SQL Guard");
    expect(html).toContain("Series Summary");
  });
});

