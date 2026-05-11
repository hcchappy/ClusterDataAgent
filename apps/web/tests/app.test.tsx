import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AppShell } from "../src/App.js";

describe("web app", () => {
  it("renders the chat workspace and tool activity", () => {
    const html = renderToString(
      <AppShell
        overview={{
          ok: true,
          manifest: {
            projectName: "ClusterDataAgent",
            currentGoal: "Implement the phase 2 agent execution loop",
            nextPriority: "tool-system",
            rules: ["small commits"],
            summary: "ClusterDataAgent: Implement the phase 2 agent execution loop"
          },
          metadata: {
            tableCount: 2,
            columnCount: 3,
            relationCount: 1
          },
          tools: [{ name: "validate-sql", description: "Validate SQL" }],
          toolMetrics: {
            "validate-sql": {
              calls: 4,
              successes: 4,
              failures: 0,
              averageDurationMs: 12,
              lastDurationMs: 10
            }
          },
          agent: {
            configured: true,
            endpoint: "https://api.openai.com/v1",
            defaultModel: "gpt-4.1-mini",
            memoryLimit: 20,
            maxToolCalls: 6,
            streaming: true
          },
          requestSecurity: {
            maxChatMessageChars: 8000,
            maxSqlChars: 20000,
            maxDatasetRows: 1000,
            maxChartDataPoints: 5000
          },
          security: { allowed: true }
        }}
        messages={[
          {
            id: "welcome",
            role: "assistant",
            content: "Agent core is online.",
            status: "complete"
          },
          {
            id: "user-1",
            role: "user",
            content: "Validate select * from orders",
            status: "complete"
          }
        ]}
        toolActivity={[
          {
            id: "call_1",
            toolName: "validate-sql",
            status: "complete",
            arguments: { sql: "select * from orders" },
            output: { allowed: true }
          }
        ]}
        composerValue="Summarize the series 1,2,3"
        isStreaming={false}
        errorMessage={null}
        statusText="connected to agent api"
        onComposerChange={() => {}}
        onSend={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlResult={{
          allowed: true,
          normalizedSql: "select id from Tenant limit 20",
          referencedTables: ["Tenant"],
          referencedColumns: ["id"],
          limit: 20
        }}
        isValidatingSql={false}
        onSqlChange={() => {}}
        onValidateSql={() => {}}
        datasetValue="[]"
        datasetProfile={{
          rowCount: 1,
          fieldCount: 1,
          fields: [
            {
              name: "revenue",
              kind: "number",
              count: 1,
              missingCount: 0,
              missingRatio: 0,
              distinctCount: 1,
              examples: [10],
              average: 10
            }
          ],
          quality: {
            emptyFieldCount: 0,
            highMissingFieldCount: 0,
            mixedFieldCount: 0,
            duplicateRowCount: 0,
            warnings: []
          }
        }}
        chartRecommendations={[
          {
            kind: "bar",
            title: "revenue by region",
            dimensions: ["region"],
            metrics: ["revenue"],
            score: 0.88,
            reason: "Low-cardinality categories are good for comparison charts"
          }
        ]}
        isProfilingDataset={false}
        isRecommendingCharts={false}
        securityCheck={{
          role: "viewer",
          tenantId: "tenant-a",
          resourceTenantId: "tenant-a",
          action: "write"
        }}
        securityDecision={{
          allowed: false,
          reason: "Viewer role is read-only",
          code: "VIEWER_READ_ONLY"
        }}
        isCheckingAccess={false}
        onDatasetChange={() => {}}
        onProfileDataset={() => {}}
        onRecommendCharts={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
      />
    );

    expect(html).toContain("ChatBI Workbench");
    expect(html).toContain("Conversation");
    expect(html).toContain("Tool Activity");
    expect(html).toContain("SQL Guardrail");
    expect(html).toContain("Dataset Profile");
    expect(html).toContain("Chart Recommendations");
    expect(html).toContain("Access Check");
    expect(html).toContain("Viewer role is read-only");
    expect(html).toContain("validate-sql");
    expect(html).toContain("revenue by region");
    expect(html).toContain("Input Limit");
    expect(html).toContain("1000");
    expect(html).toContain("Send");
  });
});
