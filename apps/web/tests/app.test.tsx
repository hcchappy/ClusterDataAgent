import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import App, { AppShell } from "../src/App.js";

describe("web app", () => {
  it("defaults to the Chinese workbench", () => {
    const html = renderToString(<App />);

    expect(html).toContain("ChatBI 工作台");
    expect(html).toContain("工作台");
    expect(html).toContain("文档");
    expect(html).toContain("语言");
  });

  it("renders the chat workspace and tool activity", () => {
    const html = renderToString(
      <AppShell
        language="en"
        activeView="workbench"
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
            content: "## Agent core is online.\n\n- Ready for SQL\n- Ready for charts",
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
        sqlQueryResult={{
          columns: ["id", "name"],
          rows: [{ id: "tenant-a", name: "Tenant A" }],
          rowCount: 1,
          durationMs: 8,
          validation: {
            allowed: true,
            normalizedSql: "select id from Tenant limit 20",
            referencedTables: ["Tenant"],
            referencedColumns: ["id"],
            limit: 20
          }
        }}
        sqlHistory={[
          {
            id: "sql-history-1",
            sql: "select id, name from Tenant limit 20",
            executedAt: "2026-05-12T14:00:00.000Z",
            result: {
              columns: ["id", "name"],
              rows: [{ id: "tenant-a", name: "Tenant A" }],
              rowCount: 1,
              durationMs: 8,
              validation: {
                allowed: true,
                normalizedSql: "select id, name from Tenant limit 20",
                referencedTables: ["Tenant"],
                referencedColumns: ["id", "name"],
                limit: 20
              }
            }
          }
        ]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[
          { region: "north", revenue: 10 },
          { region: "south", revenue: 20 }
        ]}
        datasetProfile={{
          rowCount: 1,
          fieldCount: 2,
          fields: [
            {
              name: "revenue",
              kind: "number",
              count: 1,
              missingCount: 0,
              missingRatio: 0,
              distinctCount: 1,
              examples: [10],
              average: 10,
              minimum: 10,
              maximum: 10,
              median: 10,
              standardDeviation: 0,
              outliers: []
            },
            {
              name: "region",
              kind: "string",
              count: 1,
              missingCount: 0,
              missingRatio: 0,
              distinctCount: 1,
              examples: ["north"],
              topValues: [{ value: "north", count: 1 }]
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
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("ChatBI Workbench");
    expect(html).toContain("Conversation");
    expect(html).toContain("Tool Activity");
    expect(html).toContain("SQL Guardrail");
    expect(html).toContain("Run Query");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Recent Queries");
    expect(html).toContain("Clear History");
    expect(html).toContain("Dataset Profile");
    expect(html).toContain("Chart Recommendations");
    expect(html).toContain("Access Check");
    expect(html).toContain("Viewer role is read-only");
    expect(html).toContain("validate-sql");
    expect(html).toContain("Tenant A");
    expect(html).toContain("<h4>");
    expect(html).toContain("<svg");
    expect(html).toContain("revenue by region");
    expect(html).toContain("Input Limit");
    expect(html).toContain("1000");
    expect(html).toContain("Send");
  });

  it("renders the Chinese workbench copy", () => {
    const html = renderToString(
      <AppShell
        language="zh"
        activeView="workbench"
        overview={null}
        messages={[
          {
            id: "welcome",
            role: "assistant",
            content: "Agent core 已上线。",
            status: "complete"
          }
        ]}
        toolActivity={[]}
        composerValue=""
        isStreaming={false}
        errorMessage={null}
        statusText="已连接 Agent API"
        onComposerChange={() => {}}
        onSend={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        isProfilingDataset={false}
        isRecommendingCharts={false}
        securityCheck={{
          role: "analyst",
          tenantId: "tenant-a",
          resourceTenantId: "tenant-a",
          action: "read"
        }}
        securityDecision={null}
        isCheckingAccess={false}
        onDatasetChange={() => {}}
        onProfileDataset={() => {}}
        onRecommendCharts={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("ChatBI 工作台");
    expect(html).toContain("工作台");
    expect(html).toContain("文档");
    expect(html).toContain("对话");
    expect(html).toContain("SQL 护栏");
    expect(html).toContain("访问检查");
    expect(html).toContain("数据集画像");
    expect(html).toContain("推荐图表");
  });

  it("renders the documentation page with tutorials and flow source", () => {
    const html = renderToString(
      <AppShell
        language="zh"
        activeView="docs"
        overview={null}
        messages={[]}
        toolActivity={[]}
        composerValue=""
        isStreaming={false}
        errorMessage={null}
        statusText="已连接 Agent API"
        onComposerChange={() => {}}
        onSend={() => {}}
        onPromptSelect={() => {}}
        sqlValue=""
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        isProfilingDataset={false}
        isRecommendingCharts={false}
        securityCheck={{
          role: "analyst",
          tenantId: "tenant-a",
          resourceTenantId: "tenant-a",
          action: "read"
        }}
        securityDecision={null}
        isCheckingAccess={false}
        onDatasetChange={() => {}}
        onProfileDataset={() => {}}
        onRecommendCharts={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("使用文档");
    expect(html).toContain("使用教程");
    expect(html).toContain("接口调用教程");
    expect(html).toContain("流程图");
    expect(html).toContain("flowchart LR");
    expect(html).toContain("/api/chat/stream");
  });
});
