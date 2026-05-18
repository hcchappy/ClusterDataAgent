const DEFAULT_API_BASE_URL = "http://127.0.0.1:3001";
const HTML_PREVIEW_LENGTH = 120;

export interface ChatRequest {
  readonly sessionId: string;
  readonly message: string;
  readonly model?: string;
}

export interface AgentSessionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AgentSessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly forkedFromSessionId?: string;
  readonly lastMessage?: AgentSessionMessage;
}

export interface AgentSessionRecord extends AgentSessionSummary {
  readonly messages: readonly AgentSessionMessage[];
}

export interface AgentSessionMetadataInput {
  readonly title?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface AgentSessionForkInput extends AgentSessionMetadataInput {
  readonly sessionId?: string;
}

export interface SqlValidationResult {
  readonly allowed: boolean;
  readonly normalizedSql: string;
  readonly reason?: string;
  readonly referencedTables?: readonly string[];
  readonly referencedColumns?: readonly string[];
  readonly limit?: number;
}

export interface SqlQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly durationMs: number;
  readonly validation: SqlValidationResult;
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
    readonly returnedRows: number;
    readonly hasMore: boolean;
  };
  readonly cache?: {
    readonly key: string;
    readonly hit: boolean;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

export interface SqlAsyncQueryJob {
  readonly jobId: string;
  readonly status: "running" | "completed" | "failed";
  readonly submittedAt: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
  readonly cacheKey?: string;
  readonly rowCount?: number;
  readonly durationMs?: number;
  readonly referencedTables?: readonly string[];
  readonly limit?: number;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
}

export interface ToolMetricSummary {
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly averageDurationMs: number;
  readonly lastDurationMs: number;
}

export interface RuntimePublicSnapshot {
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly activeRequests: number;
  readonly activeChatStreams: number;
  readonly totalRequests: number;
  readonly rateLimitedRequests: number;
  readonly lastMetadataRefreshAt: string;
}

export interface RuntimeOperatorSnapshot extends RuntimePublicSnapshot {
  readonly statusCounts: {
    readonly success: number;
    readonly clientError: number;
    readonly serverError: number;
  };
  readonly chatStreams: {
    readonly started: number;
    readonly completed: number;
    readonly aborted: number;
    readonly failed: number;
  };
  readonly routes: readonly {
    readonly route: string;
    readonly requests: number;
  }[];
}

export interface OperatorRuntimeResponse {
  readonly ok: true;
  readonly runtime: RuntimeOperatorSnapshot;
  readonly sessionCount: number;
  readonly toolCount: number;
  readonly toolMetrics: Readonly<Record<string, ToolMetricSummary>>;
}

export interface MetadataSearchResult {
  readonly type: "table" | "column" | "relation";
  readonly tableName: string;
  readonly columnName?: string;
  readonly relation?: {
    readonly fromTable: string;
    readonly fromColumn: string;
    readonly toTable: string;
    readonly toColumn: string;
  };
  readonly score: number;
}

export interface MetadataTableInsight {
  readonly tableName: string;
  readonly columnCount: number;
  readonly relationCount: number;
  readonly sampleColumns: readonly {
    readonly name: string;
    readonly dataType: string;
  }[];
  readonly relatedTables: readonly string[];
  readonly starterQuery: string;
}

export interface MetadataCatalogInsights {
  readonly summary: {
    readonly tableCount: number;
    readonly columnCount: number;
    readonly relationCount: number;
  };
  readonly dataTypes: readonly {
    readonly dataType: string;
    readonly count: number;
  }[];
  readonly relationHotspots: readonly {
    readonly tableName: string;
    readonly relationCount: number;
  }[];
  readonly tables: readonly MetadataTableInsight[];
}

export interface SemanticSearchResult {
  readonly type: "model" | "dimension" | "metric";
  readonly id: string;
  readonly label: string;
  readonly modelId: string;
  readonly tableName: string;
  readonly columnName?: string;
  readonly aggregation?: "count" | "countDistinct" | "sum" | "average" | "minimum" | "maximum";
  readonly score: number;
}

export interface SemanticCatalogInsights {
  readonly summary: {
    readonly modelCount: number;
    readonly metricCount: number;
    readonly dimensionCount: number;
    readonly ownerCount: number;
  };
  readonly models: readonly {
    readonly modelId: string;
    readonly label: string;
    readonly tableName: string;
    readonly dimensionCount: number;
    readonly metricCount: number;
    readonly owner?: string;
    readonly refreshCadence?: string;
  }[];
  readonly metrics: readonly {
    readonly metricId: string;
    readonly label: string;
    readonly modelId: string;
    readonly aggregation: "count" | "countDistinct" | "sum" | "average" | "minimum" | "maximum";
    readonly owner?: string;
    readonly format?: "integer" | "number" | "currency" | "percent";
    readonly defaultTimeDimensionId?: string;
    readonly allowedDimensionCount: number;
  }[];
  readonly owners: readonly {
    readonly owner: string;
    readonly modelCount: number;
    readonly metricCount: number;
  }[];
}

export interface SemanticMetricFilter {
  readonly dimensionId: string;
  readonly operator: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in";
  readonly values: readonly (string | number | boolean)[];
}

export interface SemanticMetricQueryRequest {
  readonly metricIds: readonly string[];
  readonly dimensionIds?: readonly string[];
  readonly timeDimensionId?: string;
  readonly timeGrain?: "raw" | "day" | "week" | "month";
  readonly filters?: readonly SemanticMetricFilter[];
  readonly limit?: number;
  readonly role?: UserRole;
}

export interface SemanticMetricQuery {
  readonly modelId: string;
  readonly modelLabel: string;
  readonly metricIds: readonly string[];
  readonly dimensionIds: readonly string[];
  readonly timeDimensionId?: string;
  readonly timeGrain?: "raw" | "day" | "week" | "month";
  readonly limit: number;
  readonly sql: string;
  readonly metrics: readonly {
    readonly id: string;
    readonly label: string;
    readonly aggregation: "count" | "countDistinct" | "sum" | "average" | "minimum" | "maximum";
    readonly columnName?: string;
  }[];
  readonly dimensions: readonly {
    readonly id: string;
    readonly label: string;
    readonly columnName: string;
    readonly dataType: "string" | "number" | "boolean" | "date";
  }[];
  readonly filters: readonly SemanticMetricFilter[];
  readonly referencedTables: readonly string[];
  readonly referencedColumns: readonly string[];
}

export interface DatasetInsight {
  readonly kind: "quality" | "trend" | "breakdown" | "correlation";
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly string[];
  readonly metrics?: readonly {
    readonly label: string;
    readonly value: string | number;
  }[];
}

export interface DatasetInsightsResult {
  readonly profile: DatasetProfile;
  readonly insights: readonly DatasetInsight[];
}

export interface ApiErrorPayload {
  readonly ok: false;
  readonly message: string;
  readonly code: string;
  readonly error: {
    readonly message: string;
    readonly code: string;
    readonly statusCode: number;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId?: string;
  };
}

export type DatasetRow = Readonly<Record<string, unknown>>;

export type FieldKind = "number" | "string" | "boolean" | "date" | "mixed" | "empty";

export interface FieldProfile {
  readonly name: string;
  readonly kind: FieldKind;
  readonly count: number;
  readonly missingCount: number;
  readonly missingRatio: number;
  readonly distinctCount: number;
  readonly examples: readonly unknown[];
  readonly minimum?: number | string;
  readonly maximum?: number | string;
  readonly average?: number;
  readonly median?: number;
  readonly standardDeviation?: number;
  readonly topValues?: readonly { readonly value: string; readonly count: number }[];
  readonly trueCount?: number;
  readonly falseCount?: number;
  readonly outliers?: readonly {
    readonly index: number;
    readonly value: number;
    readonly score: number;
  }[];
}

export interface DatasetProfile {
  readonly rowCount: number;
  readonly fieldCount: number;
  readonly fields: readonly FieldProfile[];
  readonly quality: {
    readonly emptyFieldCount: number;
    readonly highMissingFieldCount: number;
    readonly mixedFieldCount: number;
    readonly duplicateRowCount: number;
    readonly warnings: readonly string[];
  };
}

export interface ChartRecommendation {
  readonly kind: "line" | "bar" | "pie" | "table" | "histogram" | "scatter";
  readonly title: string;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly score: number;
  readonly reason: string;
  readonly option?: unknown;
}

export type ChartTheme = "dark" | "light";
export type UserRole = "admin" | "analyst" | "viewer";
export type AccessAction = "read" | "write" | "delete";

export interface SecurityCheckRequest {
  readonly role: UserRole;
  readonly tenantId: string;
  readonly resourceTenantId: string;
  readonly action: AccessAction;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

export interface SqlRequestOptions {
  readonly role?: UserRole;
  readonly offset?: number;
  readonly pageLimit?: number;
  readonly useCache?: boolean;
}

export interface OperatorRequestOptions {
  readonly apiKey: string;
}

export type ChatStreamEvent =
  | {
      readonly type: "session.started";
      readonly sessionId: string;
      readonly model: string;
    }
  | {
      readonly type: "response.output_text.delta";
      readonly sessionId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool.call.started";
      readonly sessionId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool.call.completed";
      readonly sessionId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly output: unknown;
    }
  | {
      readonly type: "response.completed";
      readonly sessionId: string;
      readonly outputText: string;
      readonly toolCalls: readonly {
        readonly callId: string;
        readonly toolName: string;
        readonly arguments: Readonly<Record<string, unknown>>;
        readonly output: unknown;
      }[];
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
      };
    }
  | {
      readonly type: "response.failed";
      readonly sessionId: string;
      readonly error: string;
      readonly code: string;
    };

export function getApiBaseUrl(): string {
  const env = import.meta.env as ImportMetaEnv & {
    readonly WEB_API_BASE_URL?: string;
  };

  return normalizeApiBaseUrl(env.VITE_API_BASE_URL ?? env.WEB_API_BASE_URL);
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = buildApiUrl(path);
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const payload = await parseJsonResponse<T>(response, url);

  if (!response.ok) {
    throw buildApiError(payload, response.status);
  }

  return payload;
}

function buildApiUrl(path: string): string {
  const baseUrl = getApiBaseUrl();

  if (baseUrl.length === 0) {
    return path;
  }

  return `${baseUrl}${path}`;
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return DEFAULT_API_BASE_URL;
  }

  if (trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("application/json")) {
    const body = await response.text();
    const preview = body.replace(/\s+/g, " ").trim().slice(0, HTML_PREVIEW_LENGTH);
    const suffix = preview.length > 0 ? `: ${preview}` : "";

    throw new Error(
      `Expected JSON from ${url}, but received ${contentType || "an unknown content type"}${suffix}`
    );
  }

  return (await response.json()) as T;
}

export async function validateSql(
  sql: string,
  options: SqlRequestOptions = {}
): Promise<SqlValidationResult> {
  return await requestJson<SqlValidationResult>("/api/sql/validate", {
    method: "POST",
    body: JSON.stringify({
      sql,
      ...(options.role ? { role: options.role } : {})
    })
  });
}

export async function executeSqlQuery(
  sql: string,
  options: SqlRequestOptions = {}
): Promise<SqlQueryResult> {
  return await requestJson<SqlQueryResult>("/api/sql/query", {
    method: "POST",
    body: JSON.stringify(buildSqlRequestPayload(sql, options))
  });
}

export async function startSqlQueryJob(
  sql: string,
  options: SqlRequestOptions = {}
): Promise<SqlAsyncQueryJob> {
  const response = await requestJson<{
    readonly job: SqlAsyncQueryJob;
  }>("/api/sql/query/async", {
    method: "POST",
    body: JSON.stringify(buildSqlRequestPayload(sql, {
      role: options.role,
      useCache: options.useCache
    }))
  });

  return response.job;
}

export async function getSqlQueryJob(jobId: string): Promise<SqlAsyncQueryJob> {
  const response = await requestJson<{
    readonly job: SqlAsyncQueryJob;
  }>(`/api/sql/query/jobs/${encodeURIComponent(jobId)}`);

  return response.job;
}

export async function getSqlQueryJobResult(
  jobId: string,
  options: Pick<SqlRequestOptions, "offset" | "pageLimit"> = {}
): Promise<SqlQueryResult> {
  const params = new URLSearchParams();

  if (typeof options.offset === "number") {
    params.set("offset", String(options.offset));
  }

  if (typeof options.pageLimit === "number") {
    params.set("pageLimit", String(options.pageLimit));
  }

  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await requestJson<{
    readonly result: SqlQueryResult;
  }>(`/api/sql/query/jobs/${encodeURIComponent(jobId)}/result${query}`);

  return response.result;
}

export async function profileDataset(rows: readonly DatasetRow[]): Promise<DatasetProfile> {
  const response = await requestJson<{ profile: DatasetProfile }>("/api/analysis/profile", {
    method: "POST",
    body: JSON.stringify({ rows })
  });

  return response.profile;
}

export async function analyzeDatasetInsights(
  rows: readonly DatasetRow[]
): Promise<DatasetInsightsResult> {
  const response = await requestJson<{
    profile: DatasetProfile;
    insights: readonly DatasetInsight[];
  }>("/api/analysis/insights", {
    method: "POST",
    body: JSON.stringify({ rows })
  });

  return {
    profile: response.profile,
    insights: response.insights
  };
}

export async function recommendCharts(
  profile: DatasetProfile,
  maxRecommendations = 5,
  theme: ChartTheme = "dark"
): Promise<readonly ChartRecommendation[]> {
  const response = await requestJson<{
    recommendations: readonly ChartRecommendation[];
  }>("/api/charts/suggest", {
    method: "POST",
    body: JSON.stringify({ profile, maxRecommendations, theme })
  });

  return response.recommendations;
}

export async function checkAccess(
  request: SecurityCheckRequest
): Promise<AccessDecision> {
  const response = await requestJson<{ decision: AccessDecision }>("/api/security/check", {
    method: "POST",
    body: JSON.stringify(request)
  });

  return response.decision;
}

export async function getMetadataInsights(
  limit = 8
): Promise<MetadataCatalogInsights> {
  const response = await requestJson<{ insights: MetadataCatalogInsights }>(
    `/api/metadata/insights?limit=${encodeURIComponent(String(limit))}`
  );

  return response.insights;
}

export async function searchMetadata(
  query: string,
  limit = 8
): Promise<readonly MetadataSearchResult[]> {
  const response = await requestJson<{ results: readonly MetadataSearchResult[] }>(
    `/api/metadata/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`
  );

  return response.results;
}

export async function getSemanticInsights(
  modelLimit = 6,
  metricLimit = 10
): Promise<SemanticCatalogInsights> {
  const response = await requestJson<{ insights: SemanticCatalogInsights }>(
    `/api/semantic/insights?modelLimit=${encodeURIComponent(String(modelLimit))}&metricLimit=${encodeURIComponent(String(metricLimit))}`
  );

  return response.insights;
}

export async function searchSemantics(
  query: string,
  limit = 8
): Promise<readonly SemanticSearchResult[]> {
  const response = await requestJson<{ results: readonly SemanticSearchResult[] }>(
    `/api/semantic/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`
  );

  return response.results;
}

export async function generateSemanticSql(
  request: SemanticMetricQueryRequest
): Promise<{
  readonly query: SemanticMetricQuery;
  readonly sql: string;
}> {
  return await requestJson<{
    readonly query: SemanticMetricQuery;
    readonly sql: string;
  }>("/api/semantic/sql", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function executeSemanticQuery(
  request: SemanticMetricQueryRequest
): Promise<{
  readonly query: SemanticMetricQuery;
  readonly sql: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly durationMs: number;
  readonly validation: SqlValidationResult;
}> {
  return await requestJson<{
    readonly query: SemanticMetricQuery;
    readonly sql: string;
    readonly columns: readonly string[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number;
    readonly durationMs: number;
    readonly validation: SqlValidationResult;
  }>("/api/semantic/query", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function listAgentSessions(
  options: OperatorRequestOptions
): Promise<readonly AgentSessionSummary[]> {
  const response = await requestJson<{ sessions: readonly AgentSessionSummary[] }>(
    "/api/agent/sessions",
    {
      headers: buildOperatorHeaders(options)
    }
  );

  return response.sessions;
}

export async function getAgentSession(
  sessionId: string,
  options: OperatorRequestOptions
): Promise<AgentSessionRecord> {
  const response = await requestJson<{ session: AgentSessionRecord }>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: buildOperatorHeaders(options)
    }
  );

  return response.session;
}

export async function updateAgentSession(
  sessionId: string,
  input: AgentSessionMetadataInput,
  options: OperatorRequestOptions
): Promise<AgentSessionRecord> {
  const response = await requestJson<{ session: AgentSessionRecord }>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: buildOperatorHeaders(options),
      body: JSON.stringify(input)
    }
  );

  return response.session;
}

export async function forkAgentSession(
  sessionId: string,
  input: AgentSessionForkInput,
  options: OperatorRequestOptions
): Promise<{
  readonly sourceSessionId: string;
  readonly session: AgentSessionRecord;
}> {
  return await requestJson<{
    readonly sourceSessionId: string;
    readonly session: AgentSessionRecord;
  }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: "POST",
    headers: buildOperatorHeaders(options),
    body: JSON.stringify(input)
  });
}

export async function deleteAgentSession(
  sessionId: string,
  options: OperatorRequestOptions
): Promise<{
  readonly sessionId: string;
  readonly deleted: boolean;
}> {
  const response = await requestJson<{
    readonly sessionId: string;
    readonly deleted: boolean;
  }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: buildOperatorHeaders(options)
  });

  return response;
}

export async function clearAgentSessions(
  options: OperatorRequestOptions
): Promise<{
  readonly deletedCount: number;
}> {
  const response = await requestJson<{
    readonly deletedCount: number;
  }>("/api/agent/sessions", {
    method: "DELETE",
    headers: buildOperatorHeaders(options)
  });

  return response;
}

export async function getOperatorRuntime(
  options: OperatorRequestOptions
): Promise<OperatorRuntimeResponse> {
  return await requestJson<OperatorRuntimeResponse>("/api/ops/runtime", {
    headers: buildOperatorHeaders(options)
  });
}

export async function streamChat(
  request: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
  options: {
    readonly signal?: AbortSignal;
  } = {}
): Promise<void> {
  const response = await fetch(buildApiUrl("/api/chat/stream"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(request),
    signal: options.signal
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.toLowerCase().includes("application/json")) {
      const payload = (await response.json()) as unknown;

      throw buildApiError(payload, response.status);
    }

    const body = await response.text();
    const preview = body.replace(/\s+/g, " ").trim();
    const suffix = preview.length > 0 ? `: ${preview.slice(0, HTML_PREVIEW_LENGTH)}` : "";

    throw new Error(`Chat request failed with status ${response.status}${suffix}`);
  }

  if (!response.body) {
    throw new Error("Streaming is not available in this environment");
  }

  for await (const event of parseSseStream(response.body)) {
    onEvent(event);
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ChatStreamEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundaryIndex = buffer.indexOf("\n\n");

        if (boundaryIndex === -1) {
          break;
        }

        const chunk = buffer.slice(0, boundaryIndex).trim();
        buffer = buffer.slice(boundaryIndex + 2);

        if (chunk.length === 0) {
          continue;
        }

        yield parseSseChunk(chunk);
      }
    }

    const trailing = buffer.trim();

    if (trailing.length > 0) {
      yield parseSseChunk(trailing);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseChunk(chunk: string): ChatStreamEvent {
  const lines = chunk.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLines = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));

  if (!eventLine || dataLines.length === 0) {
    throw new Error("Malformed SSE payload");
  }

  const type = eventLine.slice(7).trim();
  const payload = JSON.parse(dataLines.join("\n")) as ChatStreamEvent;

  if (payload.type !== type) {
    throw new Error("SSE event type mismatch");
  }

  return payload;
}

function extractErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const candidate = payload as { error?: unknown; message?: unknown };

    if (typeof candidate.error === "string" && candidate.error.length > 0) {
      return candidate.error;
    }

    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      return candidate.message;
    }
  }

  return "Request failed";
}

function buildApiError(payload: unknown, statusCode: number): Error {
  const message = extractErrorMessage(payload);
  const error = new Error(message) as Error & {
    readonly code?: string;
    readonly statusCode?: number;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId?: string;
  };

  if (payload && typeof payload === "object") {
    const candidate = payload as {
      code?: unknown;
      error?: {
        code?: unknown;
        statusCode?: unknown;
        details?: unknown;
        requestId?: unknown;
      };
    };

    if (typeof candidate.code === "string") {
      Object.assign(error, { code: candidate.code });
    }

    if (candidate.error && typeof candidate.error === "object") {
      Object.assign(error, {
        code:
          typeof candidate.error.code === "string"
            ? candidate.error.code
            : error.code,
        statusCode:
          typeof candidate.error.statusCode === "number"
            ? candidate.error.statusCode
            : statusCode,
        details:
          candidate.error.details &&
          typeof candidate.error.details === "object" &&
          !Array.isArray(candidate.error.details)
            ? (candidate.error.details as Readonly<Record<string, unknown>>)
            : undefined,
        requestId:
          typeof candidate.error.requestId === "string"
            ? candidate.error.requestId
            : undefined
      });
    }
  }

  if (typeof error.statusCode !== "number") {
    Object.assign(error, { statusCode });
  }

  return error;
}

function buildOperatorHeaders(
  options: OperatorRequestOptions
): Readonly<Record<string, string>> {
  return {
    "x-operator-api-key": options.apiKey
  };
}

function buildSqlRequestPayload(
  sql: string,
  options: SqlRequestOptions
): Readonly<Record<string, unknown>> {
  return {
    sql,
    ...(options.role ? { role: options.role } : {}),
    ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
    ...(typeof options.pageLimit === "number" ? { pageLimit: options.pageLimit } : {}),
    ...(typeof options.useCache === "boolean" ? { useCache: options.useCache } : {})
  };
}
