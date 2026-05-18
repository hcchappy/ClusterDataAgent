import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import App, { AppShell } from "../src/App.js";

function createBaseProps(): Parameters<typeof AppShell>[0] {
  return {
    language: "en",
    activeView: "workbench",
    overview: null,
    messages: [],
    toolActivity: [],
    composerValue: "",
    isStreaming: false,
    errorMessage: null,
    statusText: "connected to agent api",
    activeSessionId: "web-session-active",
    operatorApiKey: "operator-secret",
    operatorRuntime: null,
    metadataInsights: null,
    metadataQuery: "",
    metadataSearchResults: [],
    agentSessions: [],
    selectedSession: null,
    isLoadingSessions: false,
    isLoadingSessionDetail: false,
    isClearingSessions: false,
    isLoadingRuntime: false,
    isLoadingMetadata: false,
    isSearchingMetadata: false,
    isSavingSessionMetadata: false,
    isForkingSession: false,
    deletingSessionId: null,
    sessionTitleValue: "",
    sessionTagsValue: "",
    onComposerChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
    onPromptSelect: () => {},
    onOperatorApiKeyChange: () => {},
    onLoadRuntime: () => {},
    onMetadataQueryChange: () => {},
    onLoadMetadataInsights: () => {},
    onSearchMetadata: () => {},
    onUseMetadataStarterSql: () => {},
    onLoadSessions: () => {},
    onCreateSession: () => {},
    onSelectSession: () => {},
    onSessionTitleChange: () => {},
    onSessionTagsChange: () => {},
    onSaveSession: () => {},
    onForkSession: () => {},
    onDeleteSession: () => {},
    onClearSessions: () => {},
    sqlValue: "select id from Tenant limit 20",
    sqlRole: "analyst",
    sqlResult: null,
    isValidatingSql: false,
    sqlQueryResult: null,
    sqlHistory: [],
    isRunningSql: false,
    onSqlChange: () => {},
    onSqlRoleChange: () => {},
    onValidateSql: () => {},
    onRunSql: () => {},
    onReuseSqlHistory: () => {},
    onExportSqlResult: () => {},
    onClearSqlHistory: () => {},
    datasetValue: "[]",
    datasetRows: [],
    datasetProfile: null,
    datasetInsights: [],
    chartRecommendations: [],
    chartTheme: "dark",
    isProfilingDataset: false,
    isRecommendingCharts: false,
    securityCheck: {
      role: "analyst",
      tenantId: "tenant-a",
      resourceTenantId: "tenant-a",
      action: "read"
    },
    securityDecision: null,
    isCheckingAccess: false,
    onDatasetChange: () => {},
    onProfileDataset: () => {},
    onRecommendCharts: () => {},
    onChartThemeChange: () => {},
    onSecurityCheckChange: () => {},
    onCheckAccess: () => {},
    onLanguageChange: () => {},
    onViewChange: () => {}
  };
}

describe("web app", () => {
  it("defaults to the Chinese workbench", () => {
    const html = renderToString(<App />);

    expect(html).toContain("ChatBI 工作台");
    expect(html).toContain("工作台");
    expect(html).toContain("文档");
    expect(html).toContain("语言");
  });

  it("renders session admin controls and stored sessions", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
        overview={{
          ok: true,
          manifest: {
            projectName: "ClusterDataAgent",
            currentGoal: "Session storage upgrade",
            nextPriority: "agent-core",
            rules: ["small commits"],
            summary: "ClusterDataAgent: Session storage upgrade"
          },
          metadata: {
            tableCount: 2,
            columnCount: 3,
            relationCount: 1
          },
          tools: [{ name: "validate-sql", description: "Validate SQL" }],
          toolMetrics: {},
          agent: {
            configured: true,
            endpoint: "https://api.openai.com/v1",
            defaultModel: "gpt-4.1-mini",
            memoryLimit: 20,
            memoryStore: "file",
            memoryStorePath: "/tmp/agent-sessions.json",
            sessionCount: 2,
            maxToolCalls: 6,
            streaming: true
          },
          runtime: {
            startedAt: "2026-05-12T13:55:00.000Z",
            uptimeMs: 240000,
            activeRequests: 1,
            activeChatStreams: 0,
            totalRequests: 12,
            rateLimitedRequests: 1,
            lastMetadataRefreshAt: "2026-05-12T13:50:00.000Z"
          },
          requestSecurity: {
            maxSessionIdChars: 128,
            maxSessionTitleChars: 120,
            maxSessionTags: 8,
            maxSessionTagChars: 32,
            maxChatMessageChars: 8000,
            maxSqlChars: 20000,
            maxDatasetRows: 1000,
            maxChartDataPoints: 5000
          },
          security: { allowed: true }
        }}
        operatorRuntime={{
          ok: true,
          runtime: {
            startedAt: "2026-05-12T13:55:00.000Z",
            uptimeMs: 240000,
            activeRequests: 1,
            activeChatStreams: 0,
            totalRequests: 12,
            rateLimitedRequests: 1,
            lastMetadataRefreshAt: "2026-05-12T13:50:00.000Z",
            statusCounts: {
              success: 10,
              clientError: 1,
              serverError: 1
            },
            chatStreams: {
              started: 4,
              completed: 3,
              aborted: 1,
              failed: 0
            },
            routes: [
              {
                route: "/api/chat/stream",
                requests: 4
              }
            ]
          },
          sessionCount: 2,
          toolCount: 9,
          toolMetrics: {}
        }}
        metadataInsights={{
          summary: {
            tableCount: 2,
            columnCount: 5,
            relationCount: 1
          },
          dataTypes: [{ dataType: "text", count: 2 }],
          relationHotspots: [{ tableName: "orders", relationCount: 1 }],
          tables: [
            {
              tableName: "orders",
              columnCount: 3,
              relationCount: 1,
              sampleColumns: [
                { name: "id", dataType: "integer" },
                { name: "customer_id", dataType: "integer" }
              ],
              relatedTables: ["customers"],
              starterQuery: "select id, customer_id from orders limit 20"
            }
          ]
        }}
        metadataQuery="customer"
        metadataSearchResults={[
          {
            type: "column",
            tableName: "orders",
            columnName: "customer_id",
            score: 91
          }
        ]}
        messages={[
          {
            id: "welcome",
            role: "assistant",
            content: "Revenue is trending up.",
            status: "complete"
          }
        ]}
        activeSessionId="session-b"
        selectedSession={{
          sessionId: "session-b",
          createdAt: "2026-05-12T14:00:00.000Z",
          updatedAt: "2026-05-12T14:05:00.000Z",
          messageCount: 2,
          title: "Revenue Review",
          tags: ["finance", "q2"],
          forkedFromSessionId: "session-root",
          lastMessage: {
            role: "assistant",
            content: "Revenue is trending up."
          },
          messages: [
            { role: "user", content: "Summarize revenue" },
            { role: "assistant", content: "Revenue is trending up." }
          ]
        }}
        agentSessions={[
          {
            sessionId: "session-b",
            createdAt: "2026-05-12T14:00:00.000Z",
            updatedAt: "2026-05-12T14:05:00.000Z",
            messageCount: 2,
            title: "Revenue Review",
            tags: ["finance", "q2"],
            forkedFromSessionId: "session-root",
            lastMessage: {
              role: "assistant",
              content: "Revenue is trending up."
            }
          },
          {
            sessionId: "session-a",
            createdAt: "2026-05-11T13:00:00.000Z",
            updatedAt: "2026-05-11T13:04:00.000Z",
            messageCount: 2,
            title: "Orders Review",
            tags: ["ops"],
            lastMessage: {
              role: "assistant",
              content: "Orders are flat."
            }
          }
        ]}
        sessionTitleValue="Revenue Review"
        sessionTagsValue="finance, q2"
      />
    );

    expect(html).toContain("Session Admin");
    expect(html).toContain("Runtime Ops");
    expect(html).toContain("Operator API Key");
    expect(html).toContain("Load Runtime");
    expect(html).toContain("Metadata Explorer");
    expect(html).toContain("Search Metadata");
    expect(html).toContain("Search Results");
    expect(html).toContain("Use Starter SQL");
    expect(html).toContain("Load Sessions");
    expect(html).toContain("New Session");
    expect(html).toContain("Clear Sessions");
    expect(html).toContain("session-b");
    expect(html).toContain("session-a");
    expect(html).toContain("Revenue Review");
    expect(html).toContain("finance");
    expect(html).toContain("q2");
    expect(html).toContain("Forked From");
    expect(html).toContain("Continue Session");
    expect(html).toContain("Delete Session");
    expect(html).toContain("Save Session");
    expect(html).toContain("Fork Session");
    expect(html).toContain("/api/chat/stream");
    expect(html).toContain("customer_id");
    expect(html).toContain("Revenue is trending up.");
  });

  it("renders the chat workspace and tool activity", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
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
          toolGovernance: {
            allowedTools: ["search-metadata", "query-sql"],
            blockedTools: ["suggest-chart"],
            maxToolResultChars: 12000
          },
          agent: {
            configured: true,
            endpoint: "https://api.openai.com/v1",
            defaultModel: "gpt-4.1-mini",
            memoryLimit: 20,
            maxToolCalls: 6,
            streaming: true
          },
          runtime: {
            startedAt: "2026-05-12T13:55:00.000Z",
            uptimeMs: 180000,
            activeRequests: 1,
            activeChatStreams: 0,
            totalRequests: 12,
            rateLimitedRequests: 1,
            lastMetadataRefreshAt: "2026-05-12T13:50:00.000Z"
          },
          requestSecurity: {
            maxSessionIdChars: 128,
            maxSessionTitleChars: 120,
            maxSessionTags: 8,
            maxSessionTagChars: 32,
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
        onSubmit={() => {}}
        onStop={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlRole="viewer"
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
          rows: [
            { id: "tenant-a", name: "Tenant A" },
            { id: "tenant-b", name: "Tenant B" }
          ],
          rowCount: 42,
          durationMs: 8,
          page: {
            offset: 0,
            limit: 2,
            returnedRows: 2,
            hasMore: true
          },
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
        onSqlRoleChange={() => {}}
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
        datasetInsights={[
          {
            kind: "trend",
            title: "revenue trend",
            summary: "revenue rose across 2 time buckets.",
            fields: ["createdAt", "revenue"],
            metrics: [
              { label: "change", value: "10" },
              { label: "changePct", value: "100%" }
            ]
          }
        ]}
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
        chartTheme="dark"
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
        onChartThemeChange={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("ChatBI Workbench");
    expect(html).toContain("Conversation");
    expect(html).toContain("Tool Activity");
    expect(html).toContain("Tool Governance");
    expect(html).toContain("Runtime Ops");
    expect(html).toContain("search-metadata, query-sql");
    expect(html).toContain("suggest-chart");
    expect(html).toContain("12000");
    expect(html).toContain("SQL Guardrail");
    expect(html).toContain('id="sql-role-select"');
    expect(html).toContain("Run Query");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Recent Queries");
    expect(html).toContain("Clear History");
    expect(html).toContain("Dataset Profile");
    expect(html).toContain("Analysis Insights");
    expect(html).toContain("revenue trend");
    expect(html).toContain("Chart Recommendations");
    expect(html).toContain("Access Check");
    expect(html).toContain("Viewer role is read-only");
    expect(html).toContain("validate-sql");
    expect(html).toContain("Tenant A");
    expect(html).toContain("Tenant B");
    expect(html).toContain("Preview 2/42");
    expect(html).toContain("Showing rows 1-2 of 42");
    expect(html).toContain("Next Page");
    expect(html).toContain("Previous Page");
    expect(html).toContain("<h4>");
    expect(html).toContain("<svg");
    expect(html).toContain("revenue by region");
    expect(html).toContain("Input Limit");
    expect(html).toContain("1000");
    expect(html).toContain("Rate Limited");
    expect(html).toContain("Send");
  });

  it("renders curated metadata explorer insights when no search results are active", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
        metadataInsights={{
          summary: {
            tableCount: 2,
            columnCount: 5,
            relationCount: 1
          },
          dataTypes: [{ dataType: "text", count: 2 }],
          relationHotspots: [{ tableName: "orders", relationCount: 1 }],
          tables: [
            {
              tableName: "orders",
              columnCount: 3,
              relationCount: 1,
              sampleColumns: [
                { name: "id", dataType: "integer" },
                { name: "customer_id", dataType: "integer" }
              ],
              relatedTables: ["customers"],
              starterQuery: "select id, customer_id from orders limit 20"
            }
          ]
        }}
      />
    );

    expect(html).toContain("Top Tables");
    expect(html).toContain("Data Types");
    expect(html).toContain("Relation Hotspots");
    expect(html).toContain("orders<!-- -->:<!-- -->1");
    expect(html).toContain("Relations");
    expect(html).toContain("customers");
  });

  it("renders a stop action while chat streaming is active", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
        overview={null}
        messages={[]}
        toolActivity={[]}
        composerValue="hello"
        isStreaming={true}
        errorMessage={null}
        statusText="streaming"
        onComposerChange={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlRole="analyst"
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onSqlRoleChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        chartTheme="dark"
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
        onChartThemeChange={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("Stop");
  });

  it("renders the Chinese workbench copy", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
        language="zh"
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
        onSubmit={() => {}}
        onStop={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlRole="analyst"
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onSqlRoleChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        chartTheme="dark"
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
        onChartThemeChange={() => {}}
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

  it("renders an overview failure instead of an endless loading state", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
        overview={null}
        messages={[]}
        toolActivity={[]}
        composerValue=""
        isStreaming={false}
        errorMessage="Unable to connect to the API server"
        statusText="overview failed"
        onComposerChange={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
        onPromptSelect={() => {}}
        sqlValue="select id from Tenant limit 20"
        sqlRole="analyst"
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onSqlRoleChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        chartTheme="dark"
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
        onChartThemeChange={() => {}}
        onSecurityCheckChange={() => {}}
        onCheckAccess={() => {}}
        onLanguageChange={() => {}}
        onViewChange={() => {}}
      />
    );

    expect(html).toContain("overview failed");
    expect(html).toContain("Unable to connect to the API server");
    expect(html).not.toContain("Loading workspace summary...");
  });

  it("renders the documentation page with tutorials and flow source", () => {
    const html = renderToString(
      <AppShell
        {...createBaseProps()}
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
        onSubmit={() => {}}
        onStop={() => {}}
        onPromptSelect={() => {}}
        sqlValue=""
        sqlRole="analyst"
        sqlResult={null}
        isValidatingSql={false}
        sqlQueryResult={null}
        sqlHistory={[]}
        isRunningSql={false}
        onSqlChange={() => {}}
        onSqlRoleChange={() => {}}
        onValidateSql={() => {}}
        onRunSql={() => {}}
        onReuseSqlHistory={() => {}}
        onExportSqlResult={() => {}}
        onClearSqlHistory={() => {}}
        datasetValue="[]"
        datasetRows={[]}
        datasetProfile={null}
        chartRecommendations={[]}
        chartTheme="dark"
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
        onChartThemeChange={() => {}}
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
    expect(html).toContain("详细使用文档");
    expect(html).toContain("SQL 护栏");
    expect(html).toContain("图表推荐");
    expect(html).toContain("/api/charts/suggest");
    expect(html).toContain("/api/security/check");
    expect(html).toContain("prompt-injection signals");
    expect(html).toContain("分析与图表");
    expect(html).toContain("flow-map");
    expect(html).toContain("flowchart LR");
    expect(html).toContain("/api/chat/stream");
  });
});
