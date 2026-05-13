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
const SUGGESTED_PROMPTS = [
  "Summarize the sales trend for the last 7 days.",
  "Validate this query: select * from orders limit 20",
  "Suggest a chart for monthly revenue by region."
];
const DEFAULT_SQL = "select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20";
const DEFAULT_SECURITY_CHECK: SecurityCheckRequest = {
  role: "analyst",
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
  sqlResult,
  isValidatingSql,
  onSqlChange,
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
  isProfilingDataset,
  isRecommendingCharts,
  securityCheck,
  securityDecision,
  isCheckingAccess,
  onDatasetChange,
  onProfileDataset,
  onRecommendCharts,
  onSecurityCheckChange,
  onCheckAccess
}: {
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
  readonly sqlResult: SqlValidationResult | null;
  readonly isValidatingSql: boolean;
  readonly sqlQueryResult: SqlQueryResult | null;
  readonly sqlHistory: readonly SqlHistoryEntry[];
  readonly isRunningSql: boolean;
  readonly onSqlChange: (value: string) => void;
  readonly onValidateSql: () => void;
  readonly onRunSql: () => void;
  readonly onReuseSqlHistory: (entry: SqlHistoryEntry) => void;
  readonly onExportSqlResult: (entry?: SqlHistoryEntry) => void;
  readonly onClearSqlHistory: () => void;
  readonly datasetValue: string;
  readonly datasetRows: readonly DatasetRow[];
  readonly datasetProfile: DatasetProfile | null;
  readonly chartRecommendations: readonly ChartRecommendation[];
  readonly isProfilingDataset: boolean;
  readonly isRecommendingCharts: boolean;
  readonly securityCheck: SecurityCheckRequest;
  readonly securityDecision: AccessDecision | null;
  readonly isCheckingAccess: boolean;
  readonly onDatasetChange: (value: string) => void;
  readonly onProfileDataset: () => void;
  readonly onRecommendCharts: () => void;
  readonly onSecurityCheckChange: (request: SecurityCheckRequest) => void;
  readonly onCheckAccess: () => void;
}): ReactElement {
  const latestUsage = getLatestUsage(messages);

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">ClusterDataAgent</p>
          <h1>ChatBI Workbench</h1>
          <p className="subtle">
            Stream agent answers, inspect tool activity, and keep the schema context in
            sight.
          </p>
        </div>
        <div className="workspace-status">
          <span className={`status-dot ${overview?.agent.configured ? "is-ready" : "is-off"}`} />
          <div>
            <p className="status-label">{overview?.agent.configured ? "agent ready" : "agent offline"}</p>
            <p className="status-meta">{statusText}</p>
          </div>
        </div>
      </header>

      {errorMessage ? <p className="error">{errorMessage}</p> : null}

      <div className="workspace-grid">
        <section className="chat-column">
          <Panel
            title="Conversation"
            actions={
              latestUsage ? (
                <span className="token-badge">{latestUsage.totalTokens} tokens</span>
              ) : null
            }
          >
            <div className="prompt-row">
              {SUGGESTED_PROMPTS.map((prompt) => (
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
                    <span>{message.role === "assistant" ? "Agent" : "You"}</span>
                    <span>{message.status === "streaming" ? "streaming" : "done"}</span>
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
                Ask the agent
              </label>
              <textarea
                id="chat-composer"
                value={composerValue}
                onChange={(event) => onComposerChange(event.target.value)}
                className="composer-input"
                rows={4}
                placeholder="Ask the agent to validate SQL, summarize a series, or suggest a chart."
                disabled={isStreaming}
              />
              <div className="composer-footer">
                <p className="subtle small">
                  Streaming is powered by the new `/api/chat/stream` endpoint.
                </p>
                <button type="submit" className="primary-button" disabled={isStreaming}>
                  {isStreaming ? "Working..." : "Send"}
                </button>
              </div>
            </form>
          </Panel>

          <Panel
            title="SQL Guardrail"
            actions={
              sqlResult ? (
                <span className={`result-pill ${getValidationBadgeState(sqlResult)}`}>
                  {sqlResult.allowed ? "allowed" : "blocked"}
                </span>
              ) : null
            }
          >
            <div className="tool-form">
              <label htmlFor="sql-input">SQL</label>
              <textarea
                id="sql-input"
                value={sqlValue}
                onChange={(event) => onSqlChange(event.target.value)}
                className="tool-textarea mono"
                rows={4}
              />
              <div className="tool-footer">
                <p className="subtle small">Validates against metadata, aliases, columns, and limits.</p>
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={isValidatingSql || isRunningSql}
                    onClick={onValidateSql}
                  >
                    {isValidatingSql ? "Checking..." : "Validate SQL"}
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={isRunningSql}
                    onClick={onRunSql}
                  >
                    {isRunningSql ? "Running..." : "Run Query"}
                  </button>
                </div>
              </div>
            </div>
            {sqlResult ? (
              <div className="result-box">
                {sqlResult.reason ? <p className="warning-text">{sqlResult.reason}</p> : null}
                <dl className="compact-kv">
                  <div>
                    <dt>Tables</dt>
                    <dd>{sqlResult.referencedTables?.join(", ") || "none"}</dd>
                  </div>
                  <div>
                    <dt>Columns</dt>
                    <dd>{sqlResult.referencedColumns?.join(", ") || "none"}</dd>
                  </div>
                  <div>
                    <dt>Limit</dt>
                    <dd>{sqlResult.limit ?? "not set"}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            {sqlQueryResult ? (
              <SqlQueryResultView
                result={sqlQueryResult}
                onExport={() => {
                  onExportSqlResult();
                }}
              />
            ) : null}
            <SqlHistoryView
              history={sqlHistory}
              onReuse={onReuseSqlHistory}
              onExport={onExportSqlResult}
              onClear={onClearSqlHistory}
            />
          </Panel>

          <Panel
            title="Access Check"
            actions={
              securityDecision ? (
                <span className={`result-pill ${securityDecision.allowed ? "is-ok" : "is-bad"}`}>
                  {securityDecision.allowed ? "allowed" : "denied"}
                </span>
              ) : null
            }
          >
            <div className="security-grid">
              <label>
                <span>Role</span>
                <select
                  value={securityCheck.role}
                  onChange={(event) =>
                    onSecurityCheckChange({
                      ...securityCheck,
                      role: event.target.value as UserRole
                    })
                  }
                >
                  <option value="admin">admin</option>
                  <option value="analyst">analyst</option>
                  <option value="viewer">viewer</option>
                </select>
              </label>
              <label>
                <span>Action</span>
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
                <span>Tenant</span>
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
                <span>Resource Tenant</span>
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
              <p className="subtle small">Checks tenant isolation and role permissions.</p>
              <button
                type="button"
                className="primary-button"
                disabled={isCheckingAccess}
                onClick={onCheckAccess}
              >
                {isCheckingAccess ? "Checking..." : "Check Access"}
              </button>
            </div>
            {securityDecision ? (
              <div className="result-box">
                <dl className="compact-kv">
                  <div>
                    <dt>Decision</dt>
                    <dd>{securityDecision.allowed ? "allowed" : "denied"}</dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{securityDecision.reason ?? "policy matched"}</dd>
                  </div>
                  <div>
                    <dt>Code</dt>
                    <dd>{securityDecision.code ?? "ACCESS_ALLOWED"}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Dataset Profile"
            actions={
              datasetProfile ? (
                <span className="token-badge">
                  {datasetProfile.rowCount} rows / {datasetProfile.fieldCount} fields
                </span>
              ) : null
            }
          >
            <div className="tool-form">
              <label htmlFor="dataset-input">JSON rows</label>
              <textarea
                id="dataset-input"
                value={datasetValue}
                onChange={(event) => onDatasetChange(event.target.value)}
                className="tool-textarea mono"
                rows={8}
              />
              <div className="tool-footer">
                <p className="subtle small">Profiles field types, missing values, distributions, and quality.</p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={isProfilingDataset}
                  onClick={onProfileDataset}
                >
                  {isProfilingDataset ? "Profiling..." : "Run Profile"}
                </button>
              </div>
            </div>
            {datasetProfile ? <DatasetProfileView profile={datasetProfile} /> : null}
          </Panel>

          <Panel
            title="Chart Recommendations"
            actions={
              <button
                type="button"
                className="ghost-button"
                disabled={!datasetProfile || isRecommendingCharts}
                onClick={onRecommendCharts}
              >
                {isRecommendingCharts ? "Recommending..." : "Recommend Charts"}
              </button>
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
                      {recommendation.dimensions.join(", ") || "no dimensions"} to{" "}
                      {recommendation.metrics.join(", ") || "no metrics"}
                    </p>
                    <ChartRecommendationPreview
                      recommendation={recommendation}
                      rows={datasetRows}
                      profile={datasetProfile}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <p className="subtle">Run a dataset profile, then request chart recommendations.</p>
            )}
          </Panel>
        </section>

        <aside className="sidebar-column">
          <Panel title="Agent Overview">
            {overview ? (
              <dl className="kv">
                <div>
                  <dt>Goal</dt>
                  <dd>{overview.manifest.currentGoal}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{overview.agent.defaultModel}</dd>
                </div>
                <div>
                  <dt>Endpoint</dt>
                  <dd className="mono">{overview.agent.endpoint}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>{overview.agent.memoryLimit} messages</dd>
                </div>
                <div>
                  <dt>Tools</dt>
                  <dd>{overview.tools.length}</dd>
                </div>
              </dl>
            ) : (
              <p className="subtle">Loading workspace summary...</p>
            )}
          </Panel>

          <Panel title="Tool Activity">
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
              <p className="subtle">Tool calls will appear here as the agent works.</p>
            )}
          </Panel>

          <Panel title="Workspace Signals">
            {overview ? (
              <dl className="kv">
                <div>
                  <dt>Next Priority</dt>
                  <dd>{overview.manifest.nextPriority}</dd>
                </div>
                <div>
                  <dt>Tables</dt>
                  <dd>{overview.metadata.tableCount}</dd>
                </div>
                <div>
                  <dt>Relations</dt>
                  <dd>{overview.metadata.relationCount}</dd>
                </div>
                <div>
                  <dt>Security</dt>
                  <dd>{overview.security.allowed ? "ready" : overview.security.reason ?? "blocked"}</dd>
                </div>
                {overview.requestSecurity ? (
                  <div>
                    <dt>Input Limit</dt>
                    <dd>{overview.requestSecurity.maxDatasetRows} rows</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </Panel>
        </aside>
      </div>
    </main>
  );
}

function DatasetProfileView({ profile }: { readonly profile: DatasetProfile }): ReactElement {
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
                <dt>Missing</dt>
                <dd>{Math.round(field.missingRatio * 100)}%</dd>
              </div>
              <div>
                <dt>Distinct</dt>
                <dd>{field.distinctCount}</dd>
              </div>
              {typeof field.average === "number" ? (
                <div>
                  <dt>Average</dt>
                  <dd>{formatNumber(field.average)}</dd>
                </div>
              ) : null}
              {field.topValues?.[0] ? (
                <div>
                  <dt>Top</dt>
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
  onExport
}: {
  readonly result: SqlQueryResult;
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
          Export CSV
        </button>
      </div>
      {result.rows.length === 0 ? (
        <p className="subtle small">Query completed without returning rows.</p>
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
  onReuse,
  onExport,
  onClear
}: {
  readonly history: readonly SqlHistoryEntry[];
  readonly onReuse: (entry: SqlHistoryEntry) => void;
  readonly onExport: (entry: SqlHistoryEntry) => void;
  readonly onClear: () => void;
}): ReactElement {
  if (history.length === 0) {
    return (
      <div className="result-box">
        <div className="history-header">
          <strong>Recent Queries</strong>
          <span className="subtle small">Stores the last {MAX_SQL_HISTORY_ENTRIES} successful runs in this browser.</span>
        </div>
        <p className="subtle small">Run a query to create a reusable history entry.</p>
      </div>
    );
  }

  return (
    <div className="result-box">
      <div className="history-header">
        <strong>Recent Queries</strong>
        <div className="button-row">
          <button type="button" className="ghost-button" onClick={onClear}>
            Clear History
          </button>
        </div>
      </div>
      <div className="history-list">
        {history.map((entry) => (
          <article key={entry.id} className="history-item">
            <div className="history-copy">
              <strong className="mono">{buildSqlPreview(entry.sql)}</strong>
              <span className="subtle small">
                {entry.result.rowCount} rows, {entry.result.columns.length} columns, {entry.result.durationMs} ms
              </span>
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
                Reuse
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
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Agent core is online. Ask me to validate SQL, summarize a numeric series, or suggest a chart.",
      status: "complete"
    }
  ]);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [composerValue, setComposerValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("loading overview");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sqlValue, setSqlValue] = useState(DEFAULT_SQL);
  const [sqlResult, setSqlResult] = useState<SqlValidationResult | null>(null);
  const [isValidatingSql, setIsValidatingSql] = useState(false);
  const [sqlQueryResult, setSqlQueryResult] = useState<SqlQueryResult | null>(null);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryEntry[]>([]);
  const [isRunningSql, setIsRunningSql] = useState(false);
  const [datasetValue, setDatasetValue] = useState(DEFAULT_DATASET);
  const [datasetRows, setDatasetRows] = useState<DatasetRow[]>([]);
  const [datasetProfile, setDatasetProfile] = useState<DatasetProfile | null>(null);
  const [chartRecommendations, setChartRecommendations] = useState<ChartRecommendation[]>([]);
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
    const loadOverview = async (): Promise<void> => {
      try {
        const payload = await requestJson<OverviewResponse>("/api/overview");
        setOverview(payload);
        setStatusText(payload.agent.configured ? "connected to agent api" : "agent requires credentials");
      } catch (error) {
        const message = safeErrorMessage(error);
        logger.error("failed to load overview", { error: message });
        setErrorMessage(message);
        setStatusText("overview failed");
      }
    };

    void loadOverview();
  }, []);

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
        setStatusText(`streaming with ${event.model}`);
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
        setStatusText("response complete");
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
        setStatusText("response failed");
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
      setStatusText("request failed");
    } finally {
      setIsStreaming(false);
    }
  };

  const handleValidateSql = async (): Promise<void> => {
    setIsValidatingSql(true);
    setErrorMessage(null);

    try {
      setSqlResult(await validateSql(sqlValue));
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
      const result = await executeSqlQuery(sqlValue);
      const nextEntry = createSqlHistoryEntry(sqlValue, result);

      setSqlResult(result.validation);
      setSqlQueryResult(result);
      logger.info("sql query completed", {
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
    setStatusText("loaded query from history");
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
      setStatusText("query exported");
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
    setStatusText("query history cleared");
  };

  const handleProfileDataset = async (): Promise<void> => {
    setIsProfilingDataset(true);
    setErrorMessage(null);

    try {
      const parsedRows = JSON.parse(datasetValue) as unknown;

      if (!Array.isArray(parsedRows)) {
        throw new Error("Dataset input must be a JSON array");
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
      setChartRecommendations([...(await recommendCharts(datasetProfile, 5))]);
    } catch (error) {
      const message = safeErrorMessage(error);
      logger.error("chart recommendation failed", { error: message });
      setErrorMessage(message);
    } finally {
      setIsRecommendingCharts(false);
    }
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
      sqlResult={sqlResult}
      isValidatingSql={isValidatingSql}
      sqlQueryResult={sqlQueryResult}
      sqlHistory={sqlHistory}
      isRunningSql={isRunningSql}
      onSqlChange={(value) => {
        setSqlValue(value);
        setSqlQueryResult(null);
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
      onSecurityCheckChange={setSecurityCheck}
      onCheckAccess={() => {
        void handleCheckAccess();
      }}
    />
  );
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
