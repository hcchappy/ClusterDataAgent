const DEFAULT_API_BASE_URL = "http://127.0.0.1:3001";
const HTML_PREVIEW_LENGTH = 120;

export interface ChatRequest {
  readonly sessionId: string;
  readonly message: string;
  readonly model?: string;
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
    throw new Error(extractErrorMessage(payload));
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
    body: JSON.stringify({
      sql,
      ...(options.role ? { role: options.role } : {})
    })
  });
}

export async function profileDataset(rows: readonly DatasetRow[]): Promise<DatasetProfile> {
  const response = await requestJson<{ profile: DatasetProfile }>("/api/analysis/profile", {
    method: "POST",
    body: JSON.stringify({ rows })
  });

  return response.profile;
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

export async function streamChat(
  request: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void
): Promise<void> {
  const response = await fetch(buildApiUrl("/api/chat/stream"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Chat request failed with status ${response.status}`);
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
