import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createLogger, safeErrorMessage } from "@clusterdata/shared";
import {
  checkAccess,
  executeSqlQuery,
  profileDataset,
  recommendCharts,
  requestJson,
  streamChat,
  validateSql,
  type AccessAction,
  type AccessDecision,
  type ChartRecommendation,
  type ChartTheme,
  type ChatStreamEvent,
  type DatasetRow,
  type DatasetProfile,
  type SecurityCheckRequest,
  type SqlQueryResult,
  type SqlValidationResult,
  type UserRole
} from "./api.js";
import { ChartRecommendationPreview } from "./chart-preview.js";
import { MarkdownContent } from "./markdown.js";
import {
  MAX_SQL_HISTORY_ENTRIES,
  SQL_HISTORY_STORAGE_KEY,
  buildSqlExportFileName,
  buildSqlPreview,
  convertSqlResultToCsv,
  createSqlHistoryEntry,
  getValidationBadgeState,
  parseSqlHistory,
  serializeSqlHistory,
  upsertSqlHistory,
  type SqlHistoryEntry
} from "./sql-workbench.js";

interface OverviewResponse {
  ok: boolean;
  manifest: {
    projectName: string;
    currentGoal: string;
    nextPriority: string;
    rules: readonly string[];
    summary: string;
  };
  metadata: {
    tableCount: number;
    columnCount: number;
    relationCount: number;
  };
  tools: readonly { name: string; description: string }[];
  toolMetrics: Readonly<
    Record<
      string,
      {
        calls: number;
        successes: number;
        failures: number;
        averageDurationMs: number;
        lastDurationMs: number;
      }
    >
  >;
  agent: {
    configured: boolean;
    endpoint: string;
    defaultModel: string;
    memoryLimit: number;
    maxToolCalls: number;
    streaming: boolean;
  };
  requestSecurity?: {
    maxChatMessageChars: number;
    maxSqlChars: number;
    maxDatasetRows: number;
    maxChartDataPoints: number;
  };
  security: { allowed: boolean; reason?: string };
}

interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly status?: "streaming" | "complete";
  readonly usage?: UsageSummary;
}

interface ToolActivity {
  readonly id: string;
  readonly toolName: string;
  readonly status: "running" | "complete";
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly output?: unknown;
}

const logger = createLogger("web");
const DEFAULT_SQL = "select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20";
const DEFAULT_SQL_ROLE: UserRole = "analyst";
const USER_ROLE_OPTIONS: readonly UserRole[] = ["admin", "analyst", "viewer"];
const CHART_THEME_OPTIONS: readonly ChartTheme[] = ["dark", "light"];
const DEFAULT_CHART_THEME: ChartTheme = "dark";
const DEFAULT_SECURITY_CHECK: SecurityCheckRequest = {
  role: DEFAULT_SQL_ROLE,
  tenantId: "tenant-a",
  resourceTenantId: "tenant-a",
  action: "read"
};
const DEFAULT_DATASET = JSON.stringify(
  [
    { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10, region: "north" },
    { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20, region: "south" },
    { createdAt: "2026-01-03T00:00:00.000Z", revenue: 30, region: "north" }
  ],
  null,
  2
);

type Language = "en" | "zh";
type ViewMode = "workbench" | "docs";

interface ManualSection {
  readonly title: string;
  readonly description: string;
  readonly items: readonly string[];
}

interface FlowStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

interface FlowLink {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

interface UiCopy {
  readonly navWorkbench: string;
  readonly navDocs: string;
  readonly languageLabel: string;
  readonly languageEnglish: string;
  readonly languageChinese: string;
  readonly title: string;
  readonly subtitle: string;
  readonly agentReady: string;
  readonly agentOffline: string;
  readonly conversation: string;
  readonly tokens: string;
  readonly agent: string;
  readonly you: string;
  readonly streaming: string;
  readonly done: string;
  readonly askAgent: string;
  readonly composerPlaceholder: string;
  readonly streamingHelp: string;
  readonly working: string;
  readonly send: string;
  readonly sqlGuardrail: string;
  readonly allowed: string;
  readonly blocked: string;
  readonly denied: string;
  readonly sqlHelp: string;
  readonly checking: string;
  readonly validateSql: string;
  readonly running: string;
  readonly runQuery: string;
  readonly tables: string;
  readonly columns: string;
  readonly limit: string;
  readonly none: string;
  readonly notSet: string;
  readonly accessCheck: string;
  readonly role: string;
  readonly action: string;
  readonly tenant: string;
  readonly resourceTenant: string;
  readonly accessHelp: string;
  readonly checkAccess: string;
  readonly decision: string;
  readonly reason: string;
  readonly code: string;
  readonly policyMatched: string;
  readonly accessAllowedCode: string;
  readonly datasetProfile: string;
  readonly rowsFields: (rows: number, fields: number) => string;
  readonly jsonRows: string;
  readonly datasetHelp: string;
  readonly profiling: string;
  readonly runProfile: string;
  readonly chartRecommendations: string;
  readonly chartTheme?: string;
  readonly chartThemeDark?: string;
  readonly chartThemeLight?: string;
  readonly recommending: string;
  readonly recommendCharts: string;
  readonly chartEmpty: string;
  readonly noDimensions: string;
  readonly noMetrics: string;
  readonly to: string;
  readonly agentOverview: string;
  readonly goal: string;
  readonly model: string;
  readonly endpoint: string;
  readonly memory: string;
  readonly messages: string;
  readonly tools: string;
  readonly loadingWorkspace: string;
  readonly toolActivity: string;
  readonly toolEmpty: string;
  readonly workspaceSignals: string;
  readonly nextPriority: string;
  readonly relations: string;
  readonly security: string;
  readonly ready: string;
  readonly inputLimit: string;
  readonly rows: string;
  readonly missing: string;
  readonly distinct: string;
  readonly average: string;
  readonly top: string;
  readonly exportCsv: string;
  readonly queryEmpty: string;
  readonly recentQueries: string;
  readonly historyStores: (count: number) => string;
  readonly historyEmpty: string;
  readonly clearHistory: string;
  readonly reuse: string;
  readonly querySummary: (rows: number, columns: number, durationMs: number) => string;
  readonly welcomeMessage: string;
  readonly loadingOverview: string;
  readonly connectedStatus: string;
  readonly credentialsStatus: string;
  readonly overviewFailedStatus: string;
  readonly responseCompleteStatus: string;
  readonly responseFailedStatus: string;
  readonly requestFailedStatus: string;
  readonly loadedHistoryStatus: string;
  readonly queryExportedStatus: string;
  readonly historyClearedStatus: string;
  readonly datasetArrayError: string;
  readonly streamWithModel: (model: string) => string;
  readonly prompts: readonly string[];
  readonly docsTitle: string;
  readonly docsSubtitle: string;
  readonly tutorialTitle: string;
  readonly tutorialItems: readonly string[];
  readonly manualTitle?: string;
  readonly manualSections?: readonly ManualSection[];
  readonly apiTutorialTitle: string;
  readonly apiIntro: string;
  readonly apiSteps: readonly {
    readonly title: string;
    readonly description: string;
    readonly command: string;
  }[];
  readonly flowTitle: string;
  readonly flowIntro: string;
  readonly flowSteps: readonly (FlowStep | string)[];
  readonly flowLinks?: readonly FlowLink[];
  readonly mermaidTitle: string;
}

const UI_COPY: Record<Language, UiCopy> = {
  en: {
    navWorkbench: "Workbench",
    navDocs: "Docs",
    languageLabel: "Language",
    languageEnglish: "English",
    languageChinese: "中文",
    title: "ChatBI Workbench",
    subtitle: "Stream agent answers, inspect tool activity, and keep the schema context in sight.",
    agentReady: "agent ready",
    agentOffline: "agent offline",
    conversation: "Conversation",
    tokens: "tokens",
    agent: "Agent",
    you: "You",
    streaming: "streaming",
    done: "done",
    askAgent: "Ask the agent",
    composerPlaceholder: "Ask the agent to validate SQL, summarize a series, or suggest a chart.",
    streamingHelp: "Streaming is powered by the `/api/chat/stream` endpoint.",
    working: "Working...",
    send: "Send",
    sqlGuardrail: "SQL Guardrail",
    allowed: "allowed",
    blocked: "blocked",
    denied: "denied",
    sqlHelp: "Validates against metadata, aliases, columns, limits, and the selected role.",
    checking: "Checking...",
    validateSql: "Validate SQL",
    running: "Running...",
    runQuery: "Run Query",
    tables: "Tables",
    columns: "Columns",
    limit: "Limit",
    none: "none",
    notSet: "not set",
    accessCheck: "Access Check",
    role: "Role",
    action: "Action",
    tenant: "Tenant",
    resourceTenant: "Resource Tenant",
    accessHelp: "Checks tenant isolation and role permissions.",
    checkAccess: "Check Access",
    decision: "Decision",
    reason: "Reason",
    code: "Code",
    policyMatched: "policy matched",
    accessAllowedCode: "ACCESS_ALLOWED",
    datasetProfile: "Dataset Profile",
    rowsFields: (rows, fields) => `${rows} rows / ${fields} fields`,
    jsonRows: "JSON rows",
    datasetHelp: "Profiles field types, missing values, distributions, and quality.",
    profiling: "Profiling...",
    runProfile: "Run Profile",
    chartRecommendations: "Chart Recommendations",
    chartTheme: "Chart Theme",
    chartThemeDark: "Dark",
    chartThemeLight: "Light",
    recommending: "Recommending...",
    recommendCharts: "Recommend Charts",
    chartEmpty: "Run a dataset profile, then request chart recommendations.",
    noDimensions: "no dimensions",
    noMetrics: "no metrics",
    to: "to",
    agentOverview: "Agent Overview",
    goal: "Goal",
    model: "Model",
    endpoint: "Endpoint",
    memory: "Memory",
    messages: "messages",
    tools: "Tools",
    loadingWorkspace: "Loading workspace summary...",
    toolActivity: "Tool Activity",
    toolEmpty: "Tool calls will appear here as the agent works.",
    workspaceSignals: "Workspace Signals",
    nextPriority: "Next Priority",
    relations: "Relations",
    security: "Security",
    ready: "ready",
    inputLimit: "Input Limit",
    rows: "rows",
    missing: "Missing",
    distinct: "Distinct",
    average: "Average",
    top: "Top",
    exportCsv: "Export CSV",
    queryEmpty: "Query completed without returning rows.",
    recentQueries: "Recent Queries",
    historyStores: (count) => `Stores the last ${count} successful runs in this browser.`,
    historyEmpty: "Run a query to create a reusable history entry.",
    clearHistory: "Clear History",
    reuse: "Reuse",
    querySummary: (rows, columns, durationMs) => `${rows} rows, ${columns} columns, ${durationMs} ms`,
    welcomeMessage:
      "Agent core is online. Ask me to validate SQL, summarize a numeric series, or suggest a chart.",
    loadingOverview: "loading overview",
    connectedStatus: "connected to agent api",
    credentialsStatus: "agent requires credentials",
    overviewFailedStatus: "overview failed",
    responseCompleteStatus: "response complete",
    responseFailedStatus: "response failed",
    requestFailedStatus: "request failed",
    loadedHistoryStatus: "loaded query from history",
    queryExportedStatus: "query exported",
    historyClearedStatus: "query history cleared",
    datasetArrayError: "Dataset input must be a JSON array",
    streamWithModel: (model) => `streaming with ${model}`,
    prompts: [
      "Summarize the sales trend for the last 7 days.",
      "Validate this query: select * from orders limit 20",
      "Suggest a chart for monthly revenue by region."
    ],
    docsTitle: "Usage Documentation",
    docsSubtitle: "A practical guide for operating the ChatBI workbench and calling the API directly.",
    tutorialTitle: "Usage Tutorial",
    tutorialItems: [
      "Open the Workbench tab and confirm the agent status is ready or review the credentials message.",
      "Use Conversation for natural-language analysis, SQL checks, dataset summaries, and chart requests.",
      "Use SQL Guardrail to validate bounded SELECT statements with the intended role before running read-only queries.",
      "Paste JSON rows into Dataset Profile, run the profile, then generate chart recommendations.",
      "Use Access Check to verify tenant isolation and role/action decisions before exposing data."
    ],
    manualTitle: "Detailed Usage Manual",
    manualSections: [
      {
        title: "Conversation",
        description: "Use the chat panel when the question needs tool use, metadata lookup, SQL validation, or a written explanation.",
        items: [
          "Ask schema-aware questions in English or Chinese; business terms for orders, customers, and events are expanded during metadata search.",
          "Streaming answers show tool activity as the agent validates SQL, profiles data, recommends charts, or checks access.",
          "Assistant responses support markdown headings, lists, links, and code blocks for readable analysis notes."
        ]
      },
      {
        title: "SQL Guardrail",
        description: "Use this panel before running database queries or when validating SQL generated by the agent.",
        items: [
          "Choose the intended role first: admin, analyst, or viewer.",
          "Only bounded SELECT/WITH statements are accepted; destructive SQL, unknown tables, unknown columns, ambiguous fields, and unsafe SELECT INTO are rejected.",
          "Successful query runs are saved in browser-local history and can be replayed or exported as CSV."
        ]
      },
      {
        title: "Dataset Profile",
        description: "Use JSON rows to inspect field quality before choosing a visualization.",
        items: [
          "Paste an array of objects, then run the profile to infer number, string, boolean, date, mixed, or empty fields.",
          "Review missing ratios, distinct counts, averages, top values, duplicate rows, and quality warnings.",
          "Large, invalid, or oversized payloads are stopped by request guardrails before analysis work starts."
        ]
      },
      {
        title: "Chart Recommendations",
        description: "Turn a dataset profile into chart choices and preview them with polished themes.",
        items: [
          "Recommendations include time series, category comparison, numeric distribution, outlier scatter, or table fallback views.",
          "Use Chart Theme to switch dark or light styling for previews and generated ECharts options.",
          "Dense series are sampled, long pie tails are grouped into Other, and option metadata records zoom/progressive hints."
        ]
      },
      {
        title: "Access Check",
        description: "Verify tenant isolation and role/action policy decisions before exposing data.",
        items: [
          "Set role, action, tenant, and resource tenant to test an authorization decision.",
          "Allowed or denied decisions include policy reasons and machine-readable codes.",
          "Security audit logs cover chat, SQL validation, SQL query, metadata refresh, and access-check flows."
        ]
      }
    ],
    apiTutorialTitle: "API Calling Tutorial",
    apiIntro: "The examples assume the API is running at http://127.0.0.1:3001.",
    apiSteps: [
      {
        title: "Health check",
        description: "Confirm the API process and database configuration summary are reachable.",
        command: "curl http://127.0.0.1:3001/health"
      },
      {
        title: "Validate SQL",
        description: "Check that a read-only query is bounded and matches the metadata catalog.",
        command:
          'curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\\"sql\\":\\"select id, name from Tenant limit 20\\"}"'
      },
      {
        title: "Execute SQL",
        description: "Run a validated read-only query through the PostgreSQL executor when DATABASE_URL is configured.",
        command:
          'curl -X POST http://127.0.0.1:3001/api/sql/query -H "content-type: application/json" -d "{\\"sql\\":\\"select id, name from Tenant limit 20\\",\\"role\\":\\"analyst\\"}"'
      },
      {
        title: "Profile dataset",
        description: "Infer field kinds, distributions, missing values, and quality warnings from JSON rows.",
        command:
          'curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\\"rows\\":[{\\"region\\":\\"north\\",\\"amount\\":10},{\\"region\\":\\"south\\",\\"amount\\":20}]}"'
      },
      {
        title: "Recommend charts",
        description: "Generate profile-aware chart recommendations with a polished dark or light theme.",
        command:
          'curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\\"profile\\":{\\"rowCount\\":2,\\"fieldCount\\":2,\\"fields\\":[{\\"name\\":\\"amount\\",\\"kind\\":\\"number\\",\\"count\\":2,\\"missingCount\\":0,\\"missingRatio\\":0,\\"distinctCount\\":2,\\"examples\\":[10,20],\\"minimum\\":10,\\"maximum\\":20,\\"average\\":15,\\"median\\":15,\\"standardDeviation\\":5,\\"outliers\\":[]},{\\"name\\":\\"region\\",\\"kind\\":\\"string\\",\\"count\\":2,\\"missingCount\\":0,\\"missingRatio\\":0,\\"distinctCount\\":2,\\"examples\\":[\\"north\\",\\"south\\"],\\"topValues\\":[{\\"value\\":\\"north\\",\\"count\\":1},{\\"value\\":\\"south\\",\\"count\\":1}]}],\\"quality\\":{\\"emptyFieldCount\\":0,\\"highMissingFieldCount\\":0,\\"mixedFieldCount\\":0,\\"duplicateRowCount\\":0,\\"warnings\\":[]}},\\"maxRecommendations\\":3,\\"theme\\":\\"light\\"}"'
      },
      {
        title: "Check access",
        description: "Evaluate tenant-aware role and action permissions.",
        command:
          'curl -X POST http://127.0.0.1:3001/api/security/check -H "content-type: application/json" -d "{\\"role\\":\\"viewer\\",\\"tenantId\\":\\"tenant-a\\",\\"resourceTenantId\\":\\"tenant-a\\",\\"action\\":\\"read\\"}"'
      },
      {
        title: "Stream chat",
        description: "Ask the agent to call tools and stream answer deltas back to the browser or terminal.",
        command:
          'curl -N -X POST http://127.0.0.1:3001/api/chat/stream -H "content-type: application/json" -d "{\\"sessionId\\":\\"demo\\",\\"message\\":\\"Validate select id from Tenant limit 20\\"}"'
      }
    ],
    flowTitle: "Workflow",
    flowIntro: "The workbench keeps the agent, metadata, guardrails, analysis, charting, and security checks in one loop.",
    flowSteps: [
      {
        id: "user",
        title: "User",
        detail: "Ask, paste SQL, load JSON rows, or request an access decision."
      },
      {
        id: "workbench",
        title: "Workbench",
        detail: "Collects input, streams responses, shows previews, and keeps history local."
      },
      {
        id: "api",
        title: "API Guardrails",
        detail: "Validates payload size, prompt-injection signals, roles, and chart limits."
      },
      {
        id: "tools",
        title: "Agent Tools",
        detail: "Routes metadata search, SQL, analysis, chart, and security tool calls."
      },
      {
        id: "metadata",
        title: "Metadata + SQL",
        detail: "Loads Prisma/Postgres catalogs, validates read-only SQL, and executes safe queries."
      },
      {
        id: "analysis",
        title: "Analysis + Charts",
        detail: "Profiles datasets, detects trends/outliers, and builds themed chart options."
      },
      {
        id: "decision",
        title: "Decision",
        detail: "Returns streamed answers, query rows, chart previews, audit events, or deny reasons."
      }
    ],
    flowLinks: [
      { from: "user", to: "workbench", label: "input" },
      { from: "workbench", to: "api", label: "request" },
      { from: "api", to: "tools", label: "validated" },
      { from: "tools", to: "metadata", label: "schema + SQL" },
      { from: "tools", to: "analysis", label: "profile + chart" },
      { from: "metadata", to: "decision", label: "rows / blocks" },
      { from: "analysis", to: "decision", label: "insights" },
      { from: "decision", to: "workbench", label: "stream + preview" }
    ],
    mermaidTitle: "Mermaid Flow Source"
  },
  zh: {
    navWorkbench: "工作台",
    navDocs: "文档",
    languageLabel: "语言",
    languageEnglish: "English",
    languageChinese: "中文",
    title: "ChatBI 工作台",
    subtitle: "流式获取 Agent 回答，查看工具活动，并保持数据模型上下文可见。",
    agentReady: "Agent 就绪",
    agentOffline: "Agent 离线",
    conversation: "对话",
    tokens: "tokens",
    agent: "Agent",
    you: "你",
    streaming: "流式输出",
    done: "完成",
    askAgent: "询问 Agent",
    composerPlaceholder: "让 Agent 校验 SQL、总结序列，或推荐图表。",
    streamingHelp: "流式输出由 `/api/chat/stream` 接口提供。",
    working: "处理中...",
    send: "发送",
    sqlGuardrail: "SQL 护栏",
    allowed: "允许",
    blocked: "拦截",
    denied: "拒绝",
    sqlHelp: "根据元数据、别名、字段和 LIMIT 校验 SQL。",
    checking: "校验中...",
    validateSql: "校验 SQL",
    running: "运行中...",
    runQuery: "运行查询",
    tables: "表",
    columns: "字段",
    limit: "限制",
    none: "无",
    notSet: "未设置",
    accessCheck: "访问检查",
    role: "角色",
    action: "操作",
    tenant: "租户",
    resourceTenant: "资源租户",
    accessHelp: "检查租户隔离和角色权限。",
    checkAccess: "检查权限",
    decision: "决策",
    reason: "原因",
    code: "代码",
    policyMatched: "策略通过",
    accessAllowedCode: "ACCESS_ALLOWED",
    datasetProfile: "数据集画像",
    rowsFields: (rows, fields) => `${rows} 行 / ${fields} 个字段`,
    jsonRows: "JSON 行数据",
    datasetHelp: "分析字段类型、缺失值、分布和质量。",
    profiling: "画像生成中...",
    runProfile: "生成画像",
    chartRecommendations: "图表推荐",
    recommending: "推荐中...",
    recommendCharts: "推荐图表",
    chartEmpty: "先生成数据集画像，再请求图表推荐。",
    noDimensions: "无维度",
    noMetrics: "无指标",
    to: "到",
    agentOverview: "Agent 概览",
    goal: "目标",
    model: "模型",
    endpoint: "接口地址",
    memory: "记忆",
    messages: "条消息",
    tools: "工具",
    loadingWorkspace: "正在加载工作区摘要...",
    toolActivity: "工具活动",
    toolEmpty: "Agent 工作时，工具调用会显示在这里。",
    workspaceSignals: "工作区信号",
    nextPriority: "下一优先级",
    relations: "关系",
    security: "安全",
    ready: "就绪",
    inputLimit: "输入限制",
    rows: "行",
    missing: "缺失",
    distinct: "去重值",
    average: "平均值",
    top: "最高频",
    exportCsv: "导出 CSV",
    queryEmpty: "查询完成，但没有返回行。",
    recentQueries: "最近查询",
    historyStores: (count) => `在当前浏览器中保存最近 ${count} 次成功查询。`,
    historyEmpty: "运行一次查询后会生成可复用历史记录。",
    clearHistory: "清空历史",
    reuse: "复用",
    querySummary: (rows, columns, durationMs) => `${rows} 行，${columns} 列，${durationMs} ms`,
    welcomeMessage: "Agent core 已上线。你可以让我校验 SQL、总结数值序列，或推荐图表。",
    loadingOverview: "正在加载概览",
    connectedStatus: "已连接 Agent API",
    credentialsStatus: "Agent 需要凭据",
    overviewFailedStatus: "概览加载失败",
    responseCompleteStatus: "回答完成",
    responseFailedStatus: "回答失败",
    requestFailedStatus: "请求失败",
    loadedHistoryStatus: "已从历史载入查询",
    queryExportedStatus: "查询已导出",
    historyClearedStatus: "查询历史已清空",
    datasetArrayError: "数据集输入必须是 JSON 数组",
    streamWithModel: (model) => `正在使用 ${model} 流式输出`,
    prompts: ["总结最近 7 天的销售趋势。", "校验这个查询：select * from orders limit 20", "为按区域统计的月收入推荐图表。"],
    docsTitle: "使用文档",
    docsSubtitle: "面向 ChatBI 工作台操作和 API 直接调用的实用指南。",
    tutorialTitle: "使用教程",
    tutorialItems: [
      "打开工作台标签，确认 Agent 状态为就绪，或查看凭据提示。",
      "在对话区使用自然语言完成分析、SQL 检查、数据总结和图表请求。",
      "在 SQL 护栏中先校验带 LIMIT 的 SELECT，再运行只读查询。",
      "把 JSON 行数据粘贴到数据集画像，生成画像后再推荐图表。",
      "使用访问检查，在暴露数据前验证租户隔离和角色/操作决策。"
    ],
    apiTutorialTitle: "接口调用教程",
    apiIntro: "以下示例假设 API 运行在 http://127.0.0.1:3001。",
    apiSteps: [
      {
        title: "健康检查",
        description: "确认 API 进程和数据库配置摘要可访问。",
        command: "curl http://127.0.0.1:3001/health"
      },
      {
        title: "校验 SQL",
        description: "检查只读查询是否带边界，并匹配元数据目录。",
        command:
          'curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\\"sql\\":\\"select id, name from Tenant limit 20\\"}"'
      },
      {
        title: "生成数据集画像",
        description: "从 JSON 行数据中推断字段类型、分布、缺失值和质量告警。",
        command:
          'curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\\"rows\\":[{\\"region\\":\\"north\\",\\"amount\\":10},{\\"region\\":\\"south\\",\\"amount\\":20}]}"'
      },
      {
        title: "流式对话",
        description: "让 Agent 调用工具，并把回答增量流式返回浏览器或终端。",
        command:
          'curl -N -X POST http://127.0.0.1:3001/api/chat/stream -H "content-type: application/json" -d "{\\"sessionId\\":\\"demo\\",\\"message\\":\\"Validate select id from Tenant limit 20\\"}"'
      }
    ],
    flowTitle: "流程图",
    flowIntro: "工作台把 Agent、元数据、护栏、分析、图表和安全检查放在同一个闭环中。",
    flowSteps: ["用户", "工作台", "API", "Agent 工具", "元数据与 SQL", "分析与图表", "决策"],
    mermaidTitle: "Mermaid 流程源码"
  }
};

const ZH_DOCS_MANUAL_TITLE = "详细使用文档";

const ZH_DOCS_MANUAL_SECTIONS: readonly ManualSection[] = [
  {
    title: "对话分析",
    description: "当问题需要 Agent 调用工具、检索元数据、校验 SQL 或生成解释时，优先使用对话区。",
    items: [
      "可以用中文或英文提问；订单、客户、事件等业务词会在元数据检索时自动展开。",
      "流式回答会展示工具活动，方便追踪 SQL 校验、数据画像、图表推荐和访问检查过程。",
      "回答支持标题、列表、链接和代码块，适合沉淀为可读的分析记录。"
    ]
  },
  {
    title: "SQL 护栏",
    description: "在运行数据库查询前，或在执行 Agent 生成的 SQL 前，先用护栏做只读安全校验。",
    items: [
      "先选择目标角色：admin、analyst 或 viewer。",
      "仅允许带边界的 SELECT/WITH 查询；破坏性 SQL、未知表、未知字段、歧义字段和 unsafe SELECT INTO 会被拦截。",
      "成功查询会保存在浏览器本地历史中，可复用，也可导出为 CSV。"
    ]
  },
  {
    title: "数据画像",
    description: "把 JSON 行数据转成字段质量、分布和异常概览，再决定后续分析或可视化方式。",
    items: [
      "粘贴对象数组后运行画像，系统会推断 number、string、boolean、date、mixed 或 empty 字段。",
      "重点查看缺失率、去重数、平均值、Top 值、重复行和质量告警。",
      "过大、非法或超限 payload 会在进入分析前被请求护栏拦截。"
    ]
  },
  {
    title: "图表推荐",
    description: "基于数据画像生成图表建议，并用经过 polish 的明暗主题预览 ECharts 选项。",
    items: [
      "推荐类型覆盖时间序列、分类对比、数值分布、异常点散点和表格兜底视图。",
      "通过 Chart Theme 在暗色和亮色预览之间切换，生成的 ECharts options 会同步主题。",
      "密集序列会采样，长尾饼图会合并为 Other，元数据会记录 zoom/progressive 等渲染提示。"
    ]
  },
  {
    title: "访问检查",
    description: "在暴露数据前验证租户隔离、角色权限和操作策略。",
    items: [
      "设置角色、动作、租户和资源租户，快速测试授权结果。",
      "允许或拒绝都会返回策略原因和机器可读 code。",
      "安全审计日志覆盖对话、SQL 校验、SQL 查询、元数据刷新和访问检查流程。"
    ]
  }
];

const ZH_DOCS_API_STEPS: UiCopy["apiSteps"] = [
  {
    title: "健康检查",
    description: "确认 API 进程和数据库配置摘要可访问。",
    command: "curl http://127.0.0.1:3001/health"
  },
  {
    title: "校验 SQL",
    description: "检查只读查询是否带边界，并确认表和字段能匹配元数据目录。",
    command:
      'curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\\"sql\\":\\"select id, name from Tenant limit 20\\"}"'
  },
  {
    title: "执行 SQL",
    description: "当 DATABASE_URL 已配置时，通过 PostgreSQL executor 运行已校验的只读查询。",
    command:
      'curl -X POST http://127.0.0.1:3001/api/sql/query -H "content-type: application/json" -d "{\\"sql\\":\\"select id, name from Tenant limit 20\\",\\"role\\":\\"analyst\\"}"'
  },
  {
    title: "生成数据画像",
    description: "从 JSON 行数据中推断字段类型、分布、缺失值和质量告警。",
    command:
      'curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\\"rows\\":[{\\"region\\":\\"north\\",\\"amount\\":10},{\\"region\\":\\"south\\",\\"amount\\":20}]}"'
  },
  {
    title: "推荐图表",
    description: "基于画像生成图表建议，并应用 polish 后的暗色或亮色主题。",
    command:
      'curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\\"profile\\":{\\"rowCount\\":2,\\"fieldCount\\":2,\\"fields\\":[{\\"name\\":\\"amount\\",\\"kind\\":\\"number\\",\\"count\\":2,\\"missingCount\\":0,\\"missingRatio\\":0,\\"distinctCount\\":2,\\"examples\\":[10,20],\\"minimum\\":10,\\"maximum\\":20,\\"average\\":15,\\"median\\":15,\\"standardDeviation\\":5,\\"outliers\\":[]},{\\"name\\":\\"region\\",\\"kind\\":\\"string\\",\\"count\\":2,\\"missingCount\\":0,\\"missingRatio\\":0,\\"distinctCount\\":2,\\"examples\\":[\\"north\\",\\"south\\"],\\"topValues\\":[{\\"value\\":\\"north\\",\\"count\\":1},{\\"value\\":\\"south\\",\\"count\\":1}]}],\\"quality\\":{\\"emptyFieldCount\\":0,\\"highMissingFieldCount\\":0,\\"mixedFieldCount\\":0,\\"duplicateRowCount\\":0,\\"warnings\\":[]}},\\"maxRecommendations\\":3,\\"theme\\":\\"light\\"}"'
  },
  {
    title: "访问检查",
    description: "评估带租户上下文的角色和动作权限。",
    command:
      'curl -X POST http://127.0.0.1:3001/api/security/check -H "content-type: application/json" -d "{\\"role\\":\\"viewer\\",\\"tenantId\\":\\"tenant-a\\",\\"resourceTenantId\\":\\"tenant-a\\",\\"action\\":\\"read\\"}"'
  },
  {
    title: "流式对话",
    description: "让 Agent 调用工具，并把回答增量流式返回浏览器或终端。",
    command:
      'curl -N -X POST http://127.0.0.1:3001/api/chat/stream -H "content-type: application/json" -d "{\\"sessionId\\":\\"demo\\",\\"message\\":\\"Validate select id from Tenant limit 20\\"}"'
  }
];

const ZH_DOCS_FLOW_STEPS: readonly FlowStep[] = [
  {
    id: "user",
    title: "用户",
    detail: "提出问题、粘贴 SQL、载入 JSON 行数据，或请求访问决策。"
  },
  {
    id: "workbench",
    title: "工作台",
    detail: "收集输入、展示流式回答和图表预览，并把查询历史保存在本地。"
  },
  {
    id: "api",
    title: "API 护栏",
    detail: "校验 payload 大小、prompt-injection signals、角色和图表参数边界。"
  },
  {
    id: "tools",
    title: "Agent 工具",
    detail: "路由元数据检索、SQL、分析、图表和安全检查工具调用。"
  },
  {
    id: "metadata",
    title: "元数据 + SQL",
    detail: "加载 Prisma/Postgres 目录，校验只读 SQL，并执行安全查询。"
  },
  {
    id: "analysis",
    title: "分析与图表",
    detail: "生成数据画像，识别趋势和异常点，并构建主题化图表 options。"
  },
  {
    id: "decision",
    title: "结果决策",
    detail: "返回流式回答、查询行、图表预览、审计事件或拒绝原因。"
  }
];

const ZH_DOCS_FLOW_LINKS: readonly FlowLink[] = [
  { from: "user", to: "workbench", label: "输入" },
  { from: "workbench", to: "api", label: "请求" },
  { from: "api", to: "tools", label: "已校验" },
  { from: "tools", to: "metadata", label: "schema + SQL" },
  { from: "tools", to: "analysis", label: "画像 + 图表" },
  { from: "metadata", to: "decision", label: "行数据 / 拦截" },
  { from: "analysis", to: "decision", label: "洞察" },
  { from: "decision", to: "workbench", label: "流式 + 预览" }
];

function getCopy(language: Language): UiCopy {
  return UI_COPY[language];
}

function Panel({
  title,
  children,
  actions
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}): ReactElement {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function AppShell({
  language,
  activeView,
  overview,
  messages,
  toolActivity,
  composerValue,
  isStreaming,
  errorMessage,
  statusText,
  onComposerChange,
  onSend,
  onPromptSelect,
  sqlValue,
  sqlRole,
  sqlResult,
  isValidatingSql,
  onSqlChange,
  onSqlRoleChange,
  onValidateSql,
  sqlQueryResult,
  sqlHistory,
  isRunningSql,
  onRunSql,
  onReuseSqlHistory,
  onExportSqlResult,
  onClearSqlHistory,
  datasetValue,
  datasetRows,
  datasetProfile,
  chartRecommendations,
  chartTheme,
  isProfilingDataset,
  isRecommendingCharts,
  securityCheck,
  securityDecision,
  isCheckingAccess,
  onDatasetChange,
  onProfileDataset,
  onRecommendCharts,
  onChartThemeChange,
  onSecurityCheckChange,
  onCheckAccess,
  onLanguageChange,
  onViewChange
}: {
  readonly language: Language;
  readonly activeView: ViewMode;
  readonly overview: OverviewResponse | null;
  readonly messages: readonly ChatMessage[];
  readonly toolActivity: readonly ToolActivity[];
  readonly composerValue: string;
  readonly isStreaming: boolean;
  readonly errorMessage: string | null;
  readonly statusText: string;
  readonly onComposerChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onPromptSelect: (prompt: string) => void;
  readonly sqlValue: string;
  readonly sqlRole: UserRole;
  readonly sqlResult: SqlValidationResult | null;
  readonly isValidatingSql: boolean;
  readonly sqlQueryResult: SqlQueryResult | null;
  readonly sqlHistory: readonly SqlHistoryEntry[];
  readonly isRunningSql: boolean;
  readonly onSqlChange: (value: string) => void;
  readonly onSqlRoleChange: (role: UserRole) => void;
  readonly onValidateSql: () => void;
  readonly onRunSql: () => void;
  readonly onReuseSqlHistory: (entry: SqlHistoryEntry) => void;
  readonly onExportSqlResult: (entry?: SqlHistoryEntry) => void;
  readonly onClearSqlHistory: () => void;
  readonly datasetValue: string;
  readonly datasetRows: readonly DatasetRow[];
  readonly datasetProfile: DatasetProfile | null;
  readonly chartRecommendations: readonly ChartRecommendation[];
  readonly chartTheme: ChartTheme;
  readonly isProfilingDataset: boolean;
  readonly isRecommendingCharts: boolean;
  readonly securityCheck: SecurityCheckRequest;
  readonly securityDecision: AccessDecision | null;
  readonly isCheckingAccess: boolean;
  readonly onDatasetChange: (value: string) => void;
  readonly onProfileDataset: () => void;
  readonly onRecommendCharts: () => void;
  readonly onChartThemeChange: (theme: ChartTheme) => void;
  readonly onSecurityCheckChange: (request: SecurityCheckRequest) => void;
  readonly onCheckAccess: () => void;
  readonly onLanguageChange: (language: Language) => void;
  readonly onViewChange: (view: ViewMode) => void;
}): ReactElement {
  const latestUsage = getLatestUsage(messages);
  const copy = getCopy(language);

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div className="workspace-primary">
          <div className="view-tabs" aria-label="Primary view">
            <button
              type="button"
              className={activeView === "workbench" ? "is-active" : ""}
              onClick={() => onViewChange("workbench")}
            >
              {copy.navWorkbench}
            </button>
            <button
              type="button"
              className={activeView === "docs" ? "is-active" : ""}
              onClick={() => onViewChange("docs")}
            >
              {copy.navDocs}
            </button>
          </div>
          <div>
            <p className="eyebrow">ClusterDataAgent</p>
            <h1>{activeView === "docs" ? copy.docsTitle : copy.title}</h1>
            <p className="subtle">{activeView === "docs" ? copy.docsSubtitle : copy.subtitle}</p>
          </div>
        </div>
        <div className="workspace-controls">
          <label className="language-select">
            <span>{copy.languageLabel}</span>
            <select
              value={language}
              onChange={(event) => onLanguageChange(event.target.value as Language)}
            >
              <option value="en">{copy.languageEnglish}</option>
              <option value="zh">{copy.languageChinese}</option>
            </select>
          </label>
          <div className="workspace-status">
            <span className={`status-dot ${overview?.agent.configured ? "is-ready" : "is-off"}`} />
            <div>
              <p className="status-label">
                {overview?.agent.configured ? copy.agentReady : copy.agentOffline}
              </p>
              <p className="status-meta">{statusText}</p>
            </div>
          </div>
        </div>
      </header>

      {errorMessage ? <p className="error">{errorMessage}</p> : null}

      {activeView === "docs" ? <DocsPage copy={copy} /> : null}

      {activeView === "workbench" ? (
      <div className="workspace-grid">
        <section className="chat-column">
          <Panel
            title={copy.conversation}
            actions={
              latestUsage ? (
                <span className="token-badge">
                  {latestUsage.totalTokens} {copy.tokens}
                </span>
              ) : null
            }
          >
            <div className="prompt-row">
              {copy.prompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="ghost-button"
                  onClick={() => onPromptSelect(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="message-list">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message-bubble ${message.role === "assistant" ? "is-assistant" : "is-user"}`}
                >
                  <div className="message-meta">
                    <span>{message.role === "assistant" ? copy.agent : copy.you}</span>
                    <span>{message.status === "streaming" ? copy.streaming : copy.done}</span>
                  </div>
                  {message.content ? (
                    <MarkdownContent content={message.content} />
                  ) : (
                    <p>{message.status === "streaming" ? "..." : ""}</p>
                  )}
                </article>
              ))}
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                onSend();
              }}
            >
              <label className="sr-only" htmlFor="chat-composer">
                {copy.askAgent}
              </label>
              <textarea
                id="chat-composer"
                value={composerValue}
                onChange={(event) => onComposerChange(event.target.value)}
                className="composer-input"
                rows={4}
                placeholder={copy.composerPlaceholder}
                disabled={isStreaming}
              />
              <div className="composer-footer">
                <p className="subtle small">{copy.streamingHelp}</p>
                <button type="submit" className="primary-button" disabled={isStreaming}>
                  {isStreaming ? copy.working : copy.send}
                </button>
              </div>
            </form>
          </Panel>

          <Panel
            title={copy.sqlGuardrail}
            actions={
              sqlResult ? (
                <span className={`result-pill ${getValidationBadgeState(sqlResult)}`}>
                  {sqlResult.allowed ? copy.allowed : copy.blocked}
                </span>
              ) : null
            }
          >
            <div className="tool-form">
              <label htmlFor="sql-role-select">{copy.role}</label>
              <select
                id="sql-role-select"
                value={sqlRole}
                onChange={(event) => onSqlRoleChange(event.target.value as UserRole)}
              >
                {USER_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <label htmlFor="sql-input">SQL</label>
              <textarea
                id="sql-input"
                value={sqlValue}
                onChange={(event) => onSqlChange(event.target.value)}
                className="tool-textarea mono"
                rows={4}
              />
              <div className="tool-footer">
                <p className="subtle small">{copy.sqlHelp}</p>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={isValidatingSql || isRunningSql}
                    onClick={onValidateSql}
                  >
                    {isValidatingSql ? copy.checking : copy.validateSql}
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={isRunningSql}
                    onClick={onRunSql}
                  >
                    {isRunningSql ? copy.running : copy.runQuery}
                  </button>
                </div>
              </div>
            </div>
            {sqlResult ? (
              <div className="result-box">
                {sqlResult.reason ? <p className="warning-text">{sqlResult.reason}</p> : null}
                <dl className="compact-kv">
                  <div>
                    <dt>{copy.tables}</dt>
                    <dd>{sqlResult.referencedTables?.join(", ") || copy.none}</dd>
                  </div>
                  <div>
                    <dt>{copy.columns}</dt>
                    <dd>{sqlResult.referencedColumns?.join(", ") || copy.none}</dd>
                  </div>
                  <div>
                    <dt>{copy.limit}</dt>
                    <dd>{sqlResult.limit ?? copy.notSet}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            {sqlQueryResult ? (
              <SqlQueryResultView
                result={sqlQueryResult}
                copy={copy}
                onExport={() => {
                  onExportSqlResult();
                }}
              />
            ) : null}
            <SqlHistoryView
              history={sqlHistory}
              copy={copy}
              onReuse={onReuseSqlHistory}
              onExport={onExportSqlResult}
              onClear={onClearSqlHistory}
            />
          </Panel>

          <Panel
            title={copy.accessCheck}
            actions={
              securityDecision ? (
                <span className={`result-pill ${securityDecision.allowed ? "is-ok" : "is-bad"}`}>
                  {securityDecision.allowed ? copy.allowed : copy.denied}
                </span>
              ) : null
            }
          >
            <div className="security-grid">
              <label>
                <span>{copy.role}</span>
                <select
                  value={securityCheck.role}
                  onChange={(event) =>
                    onSecurityCheckChange({
                      ...securityCheck,
                      role: event.target.value as UserRole
                    })
                  }
                >
                  {USER_ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.action}</span>
                <select
                  value={securityCheck.action}
                  onChange={(event) =>
                    onSecurityCheckChange({
                      ...securityCheck,
                      action: event.target.value as AccessAction
                    })
                  }
                >
                  <option value="read">read</option>
                  <option value="write">write</option>
                  <option value="delete">delete</option>
                </select>
              </label>
              <label>
                <span>{copy.tenant}</span>
                <input
                  value={securityCheck.tenantId}
                  onChange={(event) =>
                    onSecurityCheckChange({
                      ...securityCheck,
                      tenantId: event.target.value
                    })
                  }
                />
              </label>
              <label>
                <span>{copy.resourceTenant}</span>
                <input
                  value={securityCheck.resourceTenantId}
                  onChange={(event) =>
                    onSecurityCheckChange({
                      ...securityCheck,
                      resourceTenantId: event.target.value
                    })
                  }
                />
              </label>
            </div>
            <div className="tool-footer">
              <p className="subtle small">{copy.accessHelp}</p>
              <button
                type="button"
                className="primary-button"
                disabled={isCheckingAccess}
                onClick={onCheckAccess}
              >
                {isCheckingAccess ? copy.checking : copy.checkAccess}
              </button>
            </div>
            {securityDecision ? (
              <div className="result-box">
                <dl className="compact-kv">
                  <div>
                    <dt>{copy.decision}</dt>
                    <dd>{securityDecision.allowed ? copy.allowed : copy.denied}</dd>
                  </div>
                  <div>
                    <dt>{copy.reason}</dt>
                    <dd>{securityDecision.reason ?? copy.policyMatched}</dd>
                  </div>
                  <div>
                    <dt>{copy.code}</dt>
                    <dd>{securityDecision.code ?? copy.accessAllowedCode}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </Panel>

          <Panel
            title={copy.datasetProfile}
            actions={
              datasetProfile ? (
                <span className="token-badge">
                  {copy.rowsFields(datasetProfile.rowCount, datasetProfile.fieldCount)}
                </span>
              ) : null
            }
          >
            <div className="tool-form">
              <label htmlFor="dataset-input">{copy.jsonRows}</label>
              <textarea
                id="dataset-input"
                value={datasetValue}
                onChange={(event) => onDatasetChange(event.target.value)}
                className="tool-textarea mono"
                rows={8}
              />
              <div className="tool-footer">
                <p className="subtle small">{copy.datasetHelp}</p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={isProfilingDataset}
                  onClick={onProfileDataset}
                >
                  {isProfilingDataset ? copy.profiling : copy.runProfile}
                </button>
              </div>
            </div>
            {datasetProfile ? <DatasetProfileView profile={datasetProfile} copy={copy} /> : null}
          </Panel>

          <Panel
            title={copy.chartRecommendations}
            actions={
              <div className="chart-toolbar">
                <label className="chart-theme-select">
                  <span>{copy.chartTheme ?? "Chart Theme"}</span>
                  <select
                    value={chartTheme}
                    onChange={(event) => onChartThemeChange(event.target.value as ChartTheme)}
                  >
                    {CHART_THEME_OPTIONS.map((theme) => (
                      <option key={theme} value={theme}>
                        {theme === "dark"
                          ? copy.chartThemeDark ?? "Dark"
                          : copy.chartThemeLight ?? "Light"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!datasetProfile || isRecommendingCharts}
                  onClick={onRecommendCharts}
                >
                  {isRecommendingCharts ? copy.recommending : copy.recommendCharts}
                </button>
              </div>
            }
          >
            {chartRecommendations.length > 0 ? (
              <div className="recommendation-list">
                {chartRecommendations.map((recommendation) => (
                  <article key={recommendation.title} className="recommendation-item">
                    <div className="recommendation-heading">
                      <span className="chart-kind">{recommendation.kind}</span>
                      <strong>{recommendation.title}</strong>
                      <span>{Math.round(recommendation.score * 100)}%</span>
                    </div>
                    <p className="subtle small">{recommendation.reason}</p>
                    <p className="subtle small">
                      {recommendation.dimensions.join(", ") || copy.noDimensions} {copy.to}{" "}
                      {recommendation.metrics.join(", ") || copy.noMetrics}
                    </p>
                    <ChartRecommendationPreview
                      recommendation={recommendation}
                      rows={datasetRows}
                      profile={datasetProfile}
                      theme={chartTheme}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <p className="subtle">{copy.chartEmpty}</p>
            )}
          </Panel>
        </section>

        <aside className="sidebar-column">
          <Panel title={copy.agentOverview}>
            {overview ? (
              <dl className="kv">
                <div>
                  <dt>{copy.goal}</dt>
                  <dd>{overview.manifest.currentGoal}</dd>
                </div>
                <div>
                  <dt>{copy.model}</dt>
                  <dd>{overview.agent.defaultModel}</dd>
                </div>
                <div>
                  <dt>{copy.endpoint}</dt>
                  <dd className="mono">{overview.agent.endpoint}</dd>
                </div>
                <div>
                  <dt>{copy.memory}</dt>
                  <dd>
                    {overview.agent.memoryLimit} {copy.messages}
                  </dd>
                </div>
                <div>
                  <dt>{copy.tools}</dt>
                  <dd>{overview.tools.length}</dd>
                </div>
              </dl>
            ) : statusText === copy.overviewFailedStatus ? (
              <div className="overview-empty-state">
                <p className="warning-text">{copy.overviewFailedStatus}</p>
                {errorMessage ? <p className="subtle small">{errorMessage}</p> : null}
              </div>
            ) : (
              <p className="subtle">{copy.loadingWorkspace}</p>
            )}
          </Panel>

          <Panel title={copy.toolActivity}>
            {toolActivity.length > 0 ? (
              <div className="activity-list">
                {toolActivity.map((activity) => (
                  <article key={activity.id} className="activity-item">
                    <div className="activity-heading">
                      <span className="mono">{activity.toolName}</span>
                      <span>{activity.status}</span>
                    </div>
                    {activity.arguments ? (
                      <pre>{JSON.stringify(activity.arguments, null, 2)}</pre>
                    ) : null}
                    {activity.output ? <pre>{JSON.stringify(activity.output, null, 2)}</pre> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="subtle">{copy.toolEmpty}</p>
            )}
          </Panel>

          <Panel title={copy.workspaceSignals}>
            {overview ? (
              <dl className="kv">
                <div>
                  <dt>{copy.nextPriority}</dt>
                  <dd>{overview.manifest.nextPriority}</dd>
                </div>
                <div>
                  <dt>{copy.tables}</dt>
                  <dd>{overview.metadata.tableCount}</dd>
                </div>
                <div>
                  <dt>{copy.relations}</dt>
                  <dd>{overview.metadata.relationCount}</dd>
                </div>
                <div>
                  <dt>{copy.security}</dt>
                  <dd>{overview.security.allowed ? copy.ready : overview.security.reason ?? copy.blocked}</dd>
                </div>
                {overview.requestSecurity ? (
                  <div>
                    <dt>{copy.inputLimit}</dt>
                    <dd>
                      {overview.requestSecurity.maxDatasetRows} {copy.rows}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : statusText === copy.overviewFailedStatus ? (
              <p className="subtle small">{copy.overviewFailedStatus}</p>
            ) : null}
          </Panel>
        </aside>
      </div>
      ) : null}
    </main>
  );
}

function DocsPage({ copy }: { readonly copy: UiCopy }): ReactElement {
  const isChineseDocs = copy.languageChinese === "中文";
  const fallbackApiSteps = isChineseDocs ? ZH_DOCS_API_STEPS : UI_COPY.en.apiSteps;
  const manualTitle =
    copy.manualTitle ?? (isChineseDocs ? ZH_DOCS_MANUAL_TITLE : UI_COPY.en.manualTitle) ?? "Detailed Usage Manual";
  const manualSections =
    copy.manualSections ?? (isChineseDocs ? ZH_DOCS_MANUAL_SECTIONS : UI_COPY.en.manualSections) ?? [];
  const apiSteps =
    copy.apiSteps.length >= fallbackApiSteps.length
      ? copy.apiSteps
      : [...copy.apiSteps, ...fallbackApiSteps.slice(copy.apiSteps.length)];
  const flowSteps = isChineseDocs ? ZH_DOCS_FLOW_STEPS : normalizeFlowSteps(copy.flowSteps);
  const flowLinks = isChineseDocs ? ZH_DOCS_FLOW_LINKS : copy.flowLinks ?? buildDefaultFlowLinks(copy);
  const mermaidSource = buildWorkflowMermaid(flowSteps, flowLinks);

  return (
    <div className="docs-layout">
      <Panel title={copy.tutorialTitle}>
        <ol className="docs-list">
          {copy.tutorialItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </Panel>

      <Panel title={manualTitle}>
        <div className="manual-grid">
          {manualSections.map((section) => (
            <article key={section.title} className="manual-section">
              <div className="manual-section-heading">
                <span>{section.title.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>{section.title}</strong>
                  <p className="subtle small">{section.description}</p>
                </div>
              </div>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title={copy.apiTutorialTitle}>
        <p className="subtle docs-intro">{copy.apiIntro}</p>
        <div className="api-guide-list">
          {apiSteps.map((step) => (
            <article key={step.title} className="api-guide-item">
              <div>
                <strong>{step.title}</strong>
                <p className="subtle small">{step.description}</p>
              </div>
              <pre className="docs-code">{step.command}</pre>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title={copy.flowTitle}>
        <p className="subtle docs-intro">{copy.flowIntro}</p>
        <div className="flow-map" aria-label={copy.flowTitle}>
          {flowSteps.map((step, index) => (
            <article key={step.id} className={`flow-node flow-node-${step.id}`}>
              <span>{index + 1}</span>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </article>
          ))}
          {flowLinks.map((link) => (
            <div
              key={`${link.from}-${link.to}`}
              className={`flow-link flow-link-${link.from}-${link.to}`}
            >
              <span>{link.label}</span>
            </div>
          ))}
        </div>
        <div className="result-box">
          <strong>{copy.mermaidTitle}</strong>
          <pre className="docs-code">{mermaidSource}</pre>
        </div>
      </Panel>
    </div>
  );
}

function DatasetProfileView({
  profile,
  copy
}: {
  readonly profile: DatasetProfile;
  readonly copy: UiCopy;
}): ReactElement {
  return (
    <div className="profile-summary">
      {profile.quality.warnings.length > 0 ? (
        <div className="result-box">
          {profile.quality.warnings.map((warning) => (
            <p key={warning} className="warning-text">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <div className="field-grid">
        {profile.fields.map((field) => (
          <article key={field.name} className="field-card">
            <div className="field-heading">
              <strong>{field.name}</strong>
              <span>{field.kind}</span>
            </div>
            <dl className="compact-kv">
              <div>
                <dt>{copy.missing}</dt>
                <dd>{Math.round(field.missingRatio * 100)}%</dd>
              </div>
              <div>
                <dt>{copy.distinct}</dt>
                <dd>{field.distinctCount}</dd>
              </div>
              {typeof field.average === "number" ? (
                <div>
                  <dt>{copy.average}</dt>
                  <dd>{formatNumber(field.average)}</dd>
                </div>
              ) : null}
              {field.topValues?.[0] ? (
                <div>
                  <dt>{copy.top}</dt>
                  <dd>
                    {field.topValues[0].value} ({field.topValues[0].count})
                  </dd>
                </div>
              ) : null}
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

function SqlQueryResultView({
  result,
  copy,
  onExport
}: {
  readonly result: SqlQueryResult;
  readonly copy: UiCopy;
  readonly onExport: () => void;
}): ReactElement {
  return (
    <div className="result-box">
      <div className="query-summary-row">
        <div className="query-summary">
          <span>{result.rowCount} rows</span>
          <span>{result.columns.length} columns</span>
          <span>{result.durationMs} ms</span>
        </div>
        <button type="button" className="ghost-button" onClick={onExport}>
          {copy.exportCsv}
        </button>
      </div>
      {result.rows.length === 0 ? (
        <p className="subtle small">{copy.queryEmpty}</p>
      ) : (
        <div className="result-table-wrap">
          <table className="result-table">
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={`row-${index}`}>
                  {result.columns.map((column) => (
                    <td key={`${index}-${column}`}>{formatQueryCell(row[column])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SqlHistoryView({
  history,
  copy,
  onReuse,
  onExport,
  onClear
}: {
  readonly history: readonly SqlHistoryEntry[];
  readonly copy: UiCopy;
  readonly onReuse: (entry: SqlHistoryEntry) => void;
  readonly onExport: (entry: SqlHistoryEntry) => void;
  readonly onClear: () => void;
}): ReactElement {
  if (history.length === 0) {
    return (
      <div className="result-box">
        <div className="history-header">
          <strong>{copy.recentQueries}</strong>
          <span className="subtle small">{copy.historyStores(MAX_SQL_HISTORY_ENTRIES)}</span>
        </div>
        <p className="subtle small">{copy.historyEmpty}</p>
      </div>
    );
  }

  return (
    <div className="result-box">
      <div className="history-header">
        <strong>{copy.recentQueries}</strong>
        <div className="button-row">
          <button type="button" className="ghost-button" onClick={onClear}>
            {copy.clearHistory}
          </button>
        </div>
      </div>
      <div className="history-list">
        {history.map((entry) => (
          <article key={entry.id} className="history-item">
            <div className="history-copy">
              <strong className="mono">{buildSqlPreview(entry.sql)}</strong>
              <span className="subtle small">{copy.querySummary(entry.result.rowCount, entry.result.columns.length, entry.result.durationMs)}</span>
              <span className="subtle small">{formatHistoryTimestamp(entry.executedAt)}</span>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  onReuse(entry);
                }}
              >
                {copy.reuse}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  onExport(entry);
                }}
              >
                CSV
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatQueryCell(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function getLatestUsage(messages: readonly ChatMessage[]): UsageSummary | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage;

    if (usage) {
      return usage;
    }
  }

  return undefined;
}

export default function App(): ReactElement {
  const [language, setLanguage] = useState<Language>("zh");
  const [activeView, setActiveView] = useState<ViewMode>("workbench");
  const copy = getCopy(language);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: getCopy("zh").welcomeMessage,
      status: "complete"
    }
  ]);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [composerValue, setComposerValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusText, setStatusText] = useState(copy.loadingOverview);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sqlValue, setSqlValue] = useState(DEFAULT_SQL);
  const [sqlRole, setSqlRole] = useState<UserRole>(DEFAULT_SQL_ROLE);
  const [sqlResult, setSqlResult] = useState<SqlValidationResult | null>(null);
  const [isValidatingSql, setIsValidatingSql] = useState(false);
  const [sqlQueryResult, setSqlQueryResult] = useState<SqlQueryResult | null>(null);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryEntry[]>([]);
  const [isRunningSql, setIsRunningSql] = useState(false);
  const [datasetValue, setDatasetValue] = useState(DEFAULT_DATASET);
  const [datasetRows, setDatasetRows] = useState<DatasetRow[]>([]);
  const [datasetProfile, setDatasetProfile] = useState<DatasetProfile | null>(null);
  const [chartRecommendations, setChartRecommendations] = useState<ChartRecommendation[]>([]);
  const [chartTheme, setChartTheme] = useState<ChartTheme>(DEFAULT_CHART_THEME);
  const [isProfilingDataset, setIsProfilingDataset] = useState(false);
  const [isRecommendingCharts, setIsRecommendingCharts] = useState(false);
  const [securityCheck, setSecurityCheck] =
    useState<SecurityCheckRequest>(DEFAULT_SECURITY_CHECK);
  const [securityDecision, setSecurityDecision] = useState<AccessDecision | null>(null);
  const [isCheckingAccess, setIsCheckingAccess] = useState(false);
  const sessionId = useMemo(
    () => `web-${globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`}`,
    []
  );

  useEffect(() => {
    setMessages((current) =>
      current.map((message) =>
        message.id === "welcome"
          ? {
              ...message,
              content: copy.welcomeMessage
            }
          : message
      )
    );
  }, [copy.welcomeMessage]);

  useEffect(() => {
    const loadOverview = async (): Promise<void> => {
      try {
        const payload = await requestJson<OverviewResponse>("/api/overview");
        setOverview(payload);
        setStatusText(payload.agent.configured ? copy.connectedStatus : copy.credentialsStatus);
      } catch (error) {
        const message = safeErrorMessage(error);
        logger.error("failed to load overview", { error: message });
        setErrorMessage(message);
        setStatusText(copy.overviewFailedStatus);
      }
    };

    void loadOverview();
  }, [copy.connectedStatus, copy.credentialsStatus, copy.overviewFailedStatus]);

  useEffect(() => {
    try {
      const history = readStoredSqlHistory();

      logger.info("sql history loaded", {
        entryCount: history.length
      });
      setSqlHistory(history);
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("failed to load sql history", { error: message });
      setErrorMessage(message);
    }
  }, []);

  const appendUserMessage = (content: string): string => {
    const assistantId = `assistant-${Date.now()}`;

    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        status: "complete"
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        status: "streaming"
      }
    ]);

    return assistantId;
  };

  const applyStreamEvent = (assistantId: string, event: ChatStreamEvent): void => {
    switch (event.type) {
      case "session.started":
        setStatusText(copy.streamWithModel(event.model));
        return;
      case "response.output_text.delta":
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: `${message.content}${event.delta}`
                }
              : message
          )
        );
        return;
      case "tool.call.started":
        setToolActivity((current) => [
          {
            id: event.callId,
            toolName: event.toolName,
            status: "running",
            arguments: event.arguments
          },
          ...current.filter((activity) => activity.id !== event.callId)
        ]);
        return;
      case "tool.call.completed":
        setToolActivity((current) =>
          current.map((activity) =>
            activity.id === event.callId
              ? {
                  ...activity,
                  status: "complete",
                  output: event.output
                }
              : activity
          )
        );
        return;
      case "response.completed":
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: event.outputText,
                  status: "complete",
                  usage: event.usage
                }
              : message
          )
        );
        setStatusText(copy.responseCompleteStatus);
        return;
      case "response.failed":
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: event.error,
                  status: "complete"
                }
              : message
          )
        );
        setErrorMessage(event.error);
        setStatusText(copy.responseFailedStatus);
    }
  };

  const handleSend = async (): Promise<void> => {
    const content = composerValue.trim();

    if (content.length === 0 || isStreaming) {
      return;
    }

    setErrorMessage(null);
    setComposerValue("");
    setIsStreaming(true);
    const assistantId = appendUserMessage(content);

    try {
      await streamChat(
        {
          sessionId,
          message: content,
          model: overview?.agent.defaultModel
        },
        (event) => {
          applyStreamEvent(assistantId, event);
        }
      );
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("chat request failed", { error: message });
      setErrorMessage(message);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantId
            ? {
                ...entry,
                content: message,
                status: "complete"
              }
            : entry
        )
      );
      setStatusText(copy.requestFailedStatus);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleValidateSql = async (): Promise<void> => {
    setIsValidatingSql(true);
    setErrorMessage(null);

    try {
      const result = await validateSql(sqlValue, { role: sqlRole });

      setSqlResult(result);
      logger.info("sql validation completed", {
        allowed: result.allowed,
        role: sqlRole,
        tableCount: result.referencedTables?.length ?? 0,
        columnCount: result.referencedColumns?.length ?? 0,
        limit: result.limit ?? null
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("sql validation failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsValidatingSql(false);
    }
  };

  const handleRunSql = async (): Promise<void> => {
    setIsRunningSql(true);
    setErrorMessage(null);

    try {
      const result = await executeSqlQuery(sqlValue, { role: sqlRole });
      const nextEntry = createSqlHistoryEntry(sqlValue, result);

      setSqlResult(result.validation);
      setSqlQueryResult(result);
      logger.info("sql query completed", {
        role: sqlRole,
        rowCount: result.rowCount,
        columnCount: result.columns.length,
        durationMs: result.durationMs
      });
      setSqlHistory((current) => {
        const next = [...upsertSqlHistory(current, nextEntry)];

        persistSqlHistory(next);
        return next;
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("sql query failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsRunningSql(false);
    }
  };

  const handleReuseSqlHistory = (entry: SqlHistoryEntry): void => {
    setSqlValue(entry.sql);
    setSqlResult(entry.result.validation);
    setSqlQueryResult(entry.result);
    logger.info("sql history entry reused", {
      entryId: entry.id,
      rowCount: entry.result.rowCount
    });
    setStatusText(copy.loadedHistoryStatus);
  };

  const handleExportSqlResult = (entry?: SqlHistoryEntry): void => {
    const result = entry?.result ?? sqlQueryResult;

    if (!result) {
      return;
    }

    try {
      exportSqlResultToCsv(result, entry?.executedAt);
      logger.info("sql result exported", {
        rowCount: result.rowCount,
        columnCount: result.columns.length
      });
      setStatusText(copy.queryExportedStatus);
      setErrorMessage(null);
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("sql export failed", { error: message });
      setErrorMessage(message);
    }
  };

  const handleClearSqlHistory = (): void => {
    setSqlHistory([]);
    clearStoredSqlHistory();
    logger.info("sql history cleared");
    setStatusText(copy.historyClearedStatus);
  };

  const handleProfileDataset = async (): Promise<void> => {
    setIsProfilingDataset(true);
    setErrorMessage(null);

    try {
      const parsedRows = JSON.parse(datasetValue) as unknown;

      if (!Array.isArray(parsedRows)) {
        throw new Error(copy.datasetArrayError);
      }

      const profile = await profileDataset(parsedRows as Readonly<Record<string, unknown>>[]);

      setDatasetRows(parsedRows as DatasetRow[]);
      setDatasetProfile(profile);
      setChartRecommendations([]);
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("dataset profile failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsProfilingDataset(false);
    }
  };

  const handleRecommendCharts = async (): Promise<void> => {
    if (!datasetProfile) {
      return;
    }

    setIsRecommendingCharts(true);
    setErrorMessage(null);

    try {
      setChartRecommendations([...(await recommendCharts(datasetProfile, 5, chartTheme))]);
      logger.info("chart recommendations requested", {
        theme: chartTheme,
        recommendationLimit: 5
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("chart recommendation failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsRecommendingCharts(false);
    }
  };

  const handleChartThemeChange = (theme: ChartTheme): void => {
    setChartTheme(theme);
    setChartRecommendations([]);
    logger.info("chart theme selected", { theme });
  };

  const handleCheckAccess = async (): Promise<void> => {
    setIsCheckingAccess(true);
    setErrorMessage(null);

    try {
      setSecurityDecision(await checkAccess(securityCheck));
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("access check failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsCheckingAccess(false);
    }
  };

  return (
    <AppShell
      language={language}
      activeView={activeView}
      overview={overview}
      messages={messages}
      toolActivity={toolActivity}
      composerValue={composerValue}
      isStreaming={isStreaming}
      errorMessage={errorMessage}
      statusText={statusText}
      onComposerChange={setComposerValue}
      onSend={() => {
        void handleSend();
      }}
      onPromptSelect={(prompt) => {
        setComposerValue(prompt);
      }}
      sqlValue={sqlValue}
      sqlRole={sqlRole}
      sqlResult={sqlResult}
      isValidatingSql={isValidatingSql}
      sqlQueryResult={sqlQueryResult}
      sqlHistory={sqlHistory}
      isRunningSql={isRunningSql}
      onSqlChange={(value) => {
        setSqlValue(value);
        setSqlQueryResult(null);
      }}
      onSqlRoleChange={(role) => {
        setSqlRole(role);
        setSqlResult(null);
        setSqlQueryResult(null);
        logger.info("sql role selected", { role });
      }}
      onValidateSql={() => {
        void handleValidateSql();
      }}
      onRunSql={() => {
        void handleRunSql();
      }}
      onReuseSqlHistory={handleReuseSqlHistory}
      onExportSqlResult={handleExportSqlResult}
      onClearSqlHistory={handleClearSqlHistory}
      datasetValue={datasetValue}
      datasetRows={datasetRows}
      datasetProfile={datasetProfile}
      chartRecommendations={chartRecommendations}
      chartTheme={chartTheme}
      isProfilingDataset={isProfilingDataset}
      isRecommendingCharts={isRecommendingCharts}
      securityCheck={securityCheck}
      securityDecision={securityDecision}
      isCheckingAccess={isCheckingAccess}
      onDatasetChange={(value) => {
        setDatasetValue(value);
        setDatasetRows([]);
        setDatasetProfile(null);
        setChartRecommendations([]);
      }}
      onProfileDataset={() => {
        void handleProfileDataset();
      }}
      onRecommendCharts={() => {
        void handleRecommendCharts();
      }}
      onChartThemeChange={handleChartThemeChange}
      onSecurityCheckChange={setSecurityCheck}
      onCheckAccess={() => {
        void handleCheckAccess();
      }}
      onLanguageChange={setLanguage}
      onViewChange={setActiveView}
    />
  );
}

function normalizeFlowSteps(steps: UiCopy["flowSteps"]): readonly FlowStep[] {
  if (steps.length > 0 && typeof steps[0] !== "string") {
    return steps as readonly FlowStep[];
  }

  const fallbackDetails = [
    "Ask, paste SQL, load JSON rows, or request an access decision.",
    "Collects input, streams responses, shows previews, and keeps history local.",
    "Validates payload size, prompt-injection signals, roles, and chart limits.",
    "Routes metadata search, SQL, analysis, chart, and security tool calls.",
    "Loads Prisma/Postgres catalogs, validates read-only SQL, and executes safe queries.",
    "Profiles datasets, detects trends/outliers, and builds themed chart options.",
    "Returns streamed answers, query rows, chart previews, audit events, or deny reasons."
  ];

  return (steps as readonly string[]).map((title, index) => ({
    id: ["user", "workbench", "api", "tools", "metadata", "analysis", "decision"][index] ?? `step-${index}`,
    title,
    detail: fallbackDetails[index] ?? title
  }));
}

function buildDefaultFlowLinks(copy: UiCopy): readonly FlowLink[] {
  return (
    UI_COPY.en.flowLinks ?? [
      { from: "user", to: "workbench", label: "input" },
      { from: "workbench", to: "api", label: "request" },
      { from: "api", to: "tools", label: "validated" },
      { from: "tools", to: "metadata", label: "schema + SQL" },
      { from: "tools", to: "analysis", label: "profile + chart" },
      { from: "metadata", to: "decision", label: "rows / blocks" },
      { from: "analysis", to: "decision", label: "insights" },
      { from: "decision", to: "workbench", label: "stream + preview" }
    ]
  ).map((link) => ({
    ...link,
    label: copy.languageLabel === "璇█" ? link.label : link.label
  }));
}

function buildWorkflowMermaid(
  steps: readonly FlowStep[],
  links: readonly FlowLink[]
): string {
  const nodeIds = new Map(steps.map((step, index) => [step.id, String.fromCharCode(65 + index)]));
  const nodeLines = steps.map((step) => {
    const nodeId = nodeIds.get(step.id) ?? step.id;

    return `  ${nodeId}["${step.title}<br/>${step.detail}"]`;
  });
  const linkLines = links.map((link) => {
    const from = nodeIds.get(link.from) ?? link.from;
    const to = nodeIds.get(link.to) ?? link.to;

    return `  ${from} -->|${link.label}| ${to}`;
  });

  return [
    "flowchart LR",
    "  classDef input fill:#172033,stroke:#87a3ff,color:#e7ecf3;",
    "  classDef guard fill:#1b2430,stroke:#49cc93,color:#e7ecf3;",
    "  classDef data fill:#1c2030,stroke:#ffb86c,color:#e7ecf3;",
    "  classDef result fill:#211b2f,stroke:#c1a6ff,color:#e7ecf3;",
    ...nodeLines,
    ...linkLines,
    "  class A,B input;",
    "  class C,D guard;",
    "  class E,F data;",
    "  class G result;"
  ].join("\n");
}

function readStoredSqlHistory(): SqlHistoryEntry[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }

  return [...parseSqlHistory(window.localStorage.getItem(SQL_HISTORY_STORAGE_KEY))];
}

function persistSqlHistory(history: readonly SqlHistoryEntry[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  window.localStorage.setItem(SQL_HISTORY_STORAGE_KEY, serializeSqlHistory(history));
  logger.info("sql history persisted", {
    entryCount: history.length
  });
}

function clearStoredSqlHistory(): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  window.localStorage.removeItem(SQL_HISTORY_STORAGE_KEY);
}

function exportSqlResultToCsv(result: SqlQueryResult, executedAt?: string): void {
  if (typeof document === "undefined") {
    throw new Error("CSV export is not available in this environment");
  }

  const csv = convertSqlResultToCsv(result);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = buildSqlExportFileName(executedAt ?? new Date().toISOString());
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
