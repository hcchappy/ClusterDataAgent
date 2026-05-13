import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";
import { type JsonSchema, type ToolRegistry } from "@clusterdata/tool-system";

const MAX_EMPTY_RESPONSE_RETRIES = 1;

export const DevelopmentPrioritySchema = z.enum([
  "monorepo",
  "agent-core",
  "tool-system",
  "metadata-engine",
  "sql-agent",
  "analysis-service",
  "chart-engine",
  "frontend",
  "security"
]);

export const AgentManifestSchema = z.object({
  projectName: z.string().min(1),
  currentGoal: z.string().min(1),
  priorities: z.array(DevelopmentPrioritySchema).min(1),
  rules: z.array(z.string().min(1)).min(1)
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface AgentRuntimeConfig {
  readonly apiKey: string;
  readonly apiEndpoint: string;
  readonly defaultModel: string;
  readonly requestTimeoutMs: number;
  readonly maxToolCalls: number;
  readonly maxRetries: number;
}

export interface AgentSessionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AgentTurnRequest {
  readonly sessionId: string;
  readonly message: string;
  readonly model?: string;
}

export interface AgentToolCallRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly output: unknown;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AgentTurnResult {
  readonly sessionId: string;
  readonly outputText: string;
  readonly toolCalls: readonly AgentToolCallRecord[];
  readonly usage?: AgentUsage;
}

export type AgentStreamEvent =
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
      readonly toolCalls: readonly AgentToolCallRecord[];
      readonly usage?: AgentUsage;
    }
  | {
      readonly type: "response.failed";
      readonly sessionId: string;
      readonly error: string;
      readonly code: string;
    };

export interface SessionStore {
  get(sessionId: string): readonly AgentSessionMessage[];
  append(sessionId: string, messages: readonly AgentSessionMessage[]): void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSessionMessage[]>();
  private readonly maxMessages: number;

  public constructor(maxMessages = 20) {
    if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
      throw new AppError("Memory limit must be a positive integer", "INVALID_MEMORY_LIMIT", 500);
    }

    this.maxMessages = maxMessages;
  }

  public get(sessionId: string): readonly AgentSessionMessage[] {
    return cloneSessionMessages(this.sessions.get(sessionId) ?? []);
  }

  public append(sessionId: string, messages: readonly AgentSessionMessage[]): void {
    const next = [...this.get(sessionId), ...cloneSessionMessages(messages)].slice(
      -this.maxMessages
    );
    this.sessions.set(sessionId, next);
  }
}

export interface FileSessionStoreOptions {
  readonly filePath: string;
  readonly maxMessages?: number;
  readonly logger?: Logger;
}

export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, AgentSessionMessage[]>();

  public constructor(options: FileSessionStoreOptions) {
    if (!Number.isInteger(options.maxMessages ?? 20) || (options.maxMessages ?? 20) <= 0) {
      throw new AppError("Memory limit must be a positive integer", "INVALID_MEMORY_LIMIT", 500);
    }

    this.filePath = options.filePath.trim();

    if (this.filePath.length === 0) {
      throw new AppError("filePath is required", "SESSION_STORE_PATH_REQUIRED", 500);
    }

    this.maxMessages = options.maxMessages ?? 20;
    this.logger = options.logger ?? createLogger("agent-core-session-store");
    this.loadFromDisk();
  }

  public get(sessionId: string): readonly AgentSessionMessage[] {
    return cloneSessionMessages(this.sessions.get(sessionId) ?? []);
  }

  public append(sessionId: string, messages: readonly AgentSessionMessage[]): void {
    const next = [...this.get(sessionId), ...cloneSessionMessages(messages)].slice(
      -this.maxMessages
    );

    this.sessions.set(sessionId, next);
    this.persistToDisk();
  }

  private loadFromDisk(): void {
    ensureParentDirectory(this.filePath);

    if (!existsSync(this.filePath)) {
      this.persistToDisk();
      this.logger.info("session store created", {
        filePath: this.filePath,
        sessionCount: 0
      });

      return;
    }

    let rawText: string;

    try {
      rawText = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new AppError("Session store file could not be read", "SESSION_STORE_READ_FAILED", 500, {
        filePath: this.filePath,
        error: safeErrorMessage(error)
      });
    }

    const loadedSessions = parsePersistedSessions(rawText, this.filePath);

    for (const [sessionId, messages] of loadedSessions.entries()) {
      this.sessions.set(sessionId, messages.slice(-this.maxMessages));
    }

    this.logger.info("session store loaded", {
      filePath: this.filePath,
      sessionCount: this.sessions.size
    });
  }

  private persistToDisk(): void {
    try {
      ensureParentDirectory(this.filePath);
      writeFileSync(
        this.filePath,
        JSON.stringify(buildPersistedSessions(this.sessions), null, 2),
        "utf8"
      );
      this.logger.info("session store persisted", {
        filePath: this.filePath,
        sessionCount: this.sessions.size
      });
    } catch (error) {
      throw new AppError("Session store file could not be written", "SESSION_STORE_WRITE_FAILED", 500, {
        filePath: this.filePath,
        error: safeErrorMessage(error)
      });
    }
  }
}

export interface ResponsesTransport {
  createResponse(request: OpenAIResponseRequest): Promise<OpenAIResponse>;
  streamResponse?(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void>;
}

export interface AgentExecutorOptions {
  readonly toolRegistry: ToolRegistry;
  readonly sessionStore: SessionStore;
  readonly config: AgentRuntimeConfig;
  readonly instructions?: string;
  readonly logger?: Logger;
  readonly transport?: ResponsesTransport;
}

export class AgentExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly config: AgentRuntimeConfig;
  private readonly instructions: string;
  private readonly logger: Logger;
  private readonly transport: ResponsesTransport;

  public constructor(options: AgentExecutorOptions) {
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.config = options.config;
    this.instructions =
      options.instructions ??
      [
        "You are ClusterDataAgent, a bilingual Chinese/English data analysis assistant.",
        "For database, table, metric, count, list, aggregation, chart, access, or safety questions, use the available tools instead of guessing.",
        "For Chinese business terms, map common words to likely metadata search terms before querying tools, for example 订单/order/orders, 客户/customer/customers, 事件/event/events.",
        "When the user asks how many records/多少记录/多少条/count, first find the relevant table with search-metadata when the table is not explicit, then execute a safe read-only count query with query-sql when available.",
        "Keep SQL read-only, bounded, and metadata-aware. Answer in the same language as the user unless they ask otherwise.",
        "Be concise and explicit, and include the table or SQL result basis for data answers."
      ].join(" ");
    this.logger = options.logger ?? createLogger("agent-core");
    this.transport =
      options.transport ??
      new OpenAIResponsesTransport({
        apiKey: options.config.apiKey,
        apiEndpoint: options.config.apiEndpoint,
        requestTimeoutMs: options.config.requestTimeoutMs,
        maxRetries: options.config.maxRetries,
        logger: this.logger
      });
  }

  public async executeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    let result: AgentTurnResult | undefined;

    for await (const event of this.streamTurn(request)) {
      if (event.type === "response.completed") {
        result = {
          sessionId: event.sessionId,
          outputText: event.outputText,
          toolCalls: event.toolCalls,
          usage: event.usage
        };
      }
    }

    if (!result) {
      throw new AppError("Agent execution failed", "AGENT_EXECUTION_FAILED", 500);
    }

    return result;
  }

  public async *streamTurn(
    request: AgentTurnRequest
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult, void> {
    const parsed = validateTurnRequest(request);
    const model = parsed.model ?? this.config.defaultModel;

    yield {
      type: "session.started",
      sessionId: parsed.sessionId,
      model
    };

    try {
      let completed: AgentTurnResult | undefined;

      for await (const event of this.runTurnStream(parsed, model)) {
        if (isCompletedEvent(event)) {
          completed = {
            sessionId: event.sessionId,
            outputText: event.outputText,
            toolCalls: event.toolCalls,
            usage: event.usage
          };
        }

        yield event;
      }

      if (!completed) {
        throw new AppError("Agent execution completed without a final event", "MISSING_COMPLETION_EVENT", 500);
      }

      return completed;
    } catch (error) {
      const appError = normalizeAgentError(error);
      yield {
        type: "response.failed",
        sessionId: parsed.sessionId,
        error: appError.message,
        code: appError.code
      };
      throw appError;
    }
  }

  private async *runTurnStream(
    request: AgentTurnRequest,
    model: string
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult, void> {
    const history = this.sessionStore.get(request.sessionId);
    const conversation = buildConversationInput(
      this.instructions,
      history,
      request.message
    );
    const toolCalls: AgentToolCallRecord[] = [];
    let totalToolCalls = 0;
    let emptyResponseRetries = 0;
    let latestResponse: OpenAIResponse | undefined;

    this.logger.info("agent turn started", {
      sessionId: request.sessionId,
      model,
      historyCount: history.length
    });

    while (true) {
      let streamedOutputText = "";
      let latestStreamResponse: OpenAIResponse | undefined;

      for await (const event of this.createResponseEventStreamWithRetry({
        model,
        input: conversation,
        tools: buildToolDefinitions(this.toolRegistry)
      })) {
        if (isOutputTextDeltaStreamEvent(event)) {
          streamedOutputText += event.delta;
          yield {
            type: "response.output_text.delta",
            sessionId: request.sessionId,
            delta: event.delta
          };
          continue;
        }

        const completedResponse = extractCompletedStreamResponse(event);

        if (completedResponse) {
          latestStreamResponse = completedResponse;
          continue;
        }

        if (isFailedOpenAIStreamEvent(event)) {
          throw buildOpenAIStreamEventError(event);
        }
      }

      latestResponse = latestStreamResponse;

      if (!latestResponse) {
        if (streamedOutputText.length > 0) {
          latestResponse = buildSyntheticTextResponse(streamedOutputText);
        } else {
          throw new AppError(
            "OpenAI stream completed without a response payload",
            "OPENAI_STREAM_MISSING_RESPONSE",
            502
          );
        }
      }

      const functionCalls = latestResponse.output.filter(isFunctionCallItem);

      if (functionCalls.length === 0) {
        let outputText = streamedOutputText;

        if (outputText.length === 0) {
          const extractedOutputText = tryExtractOutputText(latestResponse);

          if (!extractedOutputText) {
            if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
              emptyResponseRetries += 1;
              this.logger.warn("agent empty response retrying", {
                sessionId: request.sessionId,
                model,
                responseId: latestResponse.id,
                outputItemCount: latestResponse.output.length,
                retry: emptyResponseRetries
              });
              continue;
            }

            throw new AppError("Model returned an empty response", "EMPTY_MODEL_RESPONSE", 502, {
              sessionId: request.sessionId,
              model,
              responseId: latestResponse.id,
              outputItemCount: latestResponse.output.length
            });
          }

          outputText = extractedOutputText;
        }

        this.sessionStore.append(request.sessionId, [
          {
            role: "user",
            content: request.message
          },
          {
            role: "assistant",
            content: outputText
          }
        ]);

        this.logger.info("agent turn completed", {
          sessionId: request.sessionId,
          model,
          toolCallCount: toolCalls.length
        });

        const result = {
          sessionId: request.sessionId,
          outputText,
          toolCalls,
          usage: latestResponse.usage
            ? {
                inputTokens: latestResponse.usage.input_tokens,
                outputTokens: latestResponse.usage.output_tokens,
                totalTokens: latestResponse.usage.total_tokens
              }
            : undefined
        };

        yield {
          type: "response.completed",
          sessionId: request.sessionId,
          outputText: result.outputText,
          toolCalls: result.toolCalls,
          usage: result.usage
        };

        return result;
      }

      emptyResponseRetries = 0;

      for (const functionCall of functionCalls) {
        totalToolCalls += 1;

        if (totalToolCalls > this.config.maxToolCalls) {
          throw new AppError(
            "Agent exceeded the configured tool call limit",
            "AGENT_TOOL_LIMIT_EXCEEDED",
            500,
            {
              sessionId: request.sessionId,
              maxToolCalls: this.config.maxToolCalls
            }
          );
        }

        const parsedArguments = parseFunctionArguments(
          functionCall.arguments,
          functionCall.name
        );
        yield {
          type: "tool.call.started",
          sessionId: request.sessionId,
          callId: functionCall.call_id,
          toolName: functionCall.name,
          arguments: parsedArguments
        };
        const toolResult = await this.toolRegistry.execute(functionCall.name, parsedArguments, {
          requestId: latestResponse.id,
          metadata: {
            sessionId: request.sessionId
          },
          logger: this.logger
        });
        yield {
          type: "tool.call.completed",
          sessionId: request.sessionId,
          callId: functionCall.call_id,
          toolName: functionCall.name,
          output: toolResult
        };

        toolCalls.push({
          callId: functionCall.call_id,
          toolName: functionCall.name,
          arguments: parsedArguments,
          output: toolResult
        });

        conversation.push({
          type: "function_call",
          call_id: functionCall.call_id,
          name: functionCall.name,
          arguments: functionCall.arguments
        });
        conversation.push({
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: JSON.stringify(toolResult)
        });
      }

    }
  }

  private async *createResponseEventStreamWithRetry(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
    if (!this.transport.streamResponse) {
      const response = await this.createResponseWithRetry(request);

      for (const event of buildFallbackResponseEvents(response)) {
        yield event;
      }

      return;
    }

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      let emittedEvent = false;

      try {
        for await (const event of this.transport.streamResponse(request)) {
          emittedEvent = true;
          yield event;
        }

        return;
      } catch (error) {
        const appError = normalizeAgentError(error);

        if (
          !emittedEvent &&
          attempt <= this.config.maxRetries &&
          isRetryableOpenAIError(appError)
        ) {
          this.logger.warn("agent streaming response retrying", {
            attempt,
            code: appError.code,
            error: appError.message
          });
          continue;
        }

        throw appError;
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }

  private async createResponseWithRetry(
    request: OpenAIResponseRequest
  ): Promise<OpenAIResponse> {
    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      try {
        return await this.transport.createResponse(request);
      } catch (error) {
        const appError = normalizeAgentError(error);

        if (attempt <= this.config.maxRetries && isRetryableOpenAIError(appError)) {
          this.logger.warn("agent response retrying", {
            attempt,
            code: appError.code,
            error: appError.message
          });
          continue;
        }

        throw appError;
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }
}

interface OpenAIResponseRequest {
  readonly model: string;
  readonly input: readonly OpenAIInputItem[];
  readonly tools: readonly OpenAIFunctionTool[];
}

interface OpenAIUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

interface OpenAIResponse {
  readonly id: string;
  readonly output: readonly OpenAIOutputItem[];
  readonly output_text?: string;
  readonly usage?: OpenAIUsage;
}

interface OpenAIResponseOutputTextDeltaEvent {
  readonly type: "response.output_text.delta";
  readonly delta: string;
}

interface OpenAIResponseCompletedStreamEvent {
  readonly type: "response.completed";
  readonly response: OpenAIResponse;
}

interface OpenAIResponseFailedStreamEvent {
  readonly type: "response.failed";
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
  };
  readonly response?: {
    readonly error?: {
      readonly message?: string;
      readonly code?: string;
    };
  };
}

interface OpenAIErrorStreamEvent {
  readonly type: "error";
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
  };
}

type OpenAIResponseStreamEvent =
  | OpenAIResponseOutputTextDeltaEvent
  | OpenAIResponseCompletedStreamEvent
  | OpenAIResponseFailedStreamEvent
  | OpenAIErrorStreamEvent
  | (Readonly<Record<string, unknown>> & { readonly type: string });

type OpenAIOutputItem =
  | {
      readonly type: "message";
      readonly role: "assistant";
      readonly content: readonly {
        readonly type: string;
        readonly text?: string;
      }[];
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    };

type OpenAIInputItem =
  | {
      readonly type: "message";
      readonly role: "developer" | "user" | "assistant";
      readonly content: readonly {
        readonly type: "input_text" | "output_text";
        readonly text: string;
      }[];
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "function_call_output";
      readonly call_id: string;
      readonly output: string;
    };

interface OpenAIFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

interface OpenAIResponsesTransportOptions {
  readonly apiKey: string;
  readonly apiEndpoint: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
}

class OpenAIResponsesTransport implements ResponsesTransport {
  private readonly apiKey: string;
  private readonly apiEndpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;

  public constructor(options: OpenAIResponsesTransportOptions) {
    this.apiKey = options.apiKey;
    this.apiEndpoint = resolveResponsesApiEndpoint(options.apiEndpoint);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxRetries = options.maxRetries;
    this.logger = options.logger;
  }

  public async createResponse(request: OpenAIResponseRequest): Promise<OpenAIResponse> {
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await this.sendRequest(request, controller.signal);
        const payload = (await response.json()) as Partial<OpenAIResponse>;

        if (!response.ok) {
          const appError = await buildOpenAIHttpError(response, payload);

          if (attempt <= this.maxRetries && isRetryableOpenAIStatus(response.status)) {
            this.logger.warn("openai request retrying", {
              attempt,
              statusCode: response.status,
              error: appError.message
            });
            continue;
          }

          throw appError;
        }

        return payload as OpenAIResponse;
      } catch (error) {
        const normalizedError = normalizeOpenAITransportError(error);

        if (attempt <= this.maxRetries && isRetryableOpenAIError(normalizedError)) {
          this.logger.warn("openai transport retrying", {
            attempt,
            code: normalizedError.code,
            error: normalizedError.message
          });
          continue;
        }

        throw normalizedError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }

  public async *streamResponse(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.sendRequest(
        request,
        controller.signal,
        {
          accept: "text/event-stream"
        },
        true
      );

      if (!response.ok) {
        throw await buildOpenAIHttpError(response);
      }

      if (!response.body) {
        throw new AppError("OpenAI stream body was empty", "OPENAI_EMPTY_STREAM", 502);
      }

      for await (const event of parseOpenAIResponseStream(response.body)) {
        yield event;
      }
    } catch (error) {
      throw normalizeOpenAITransportError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async sendRequest(
    request: OpenAIResponseRequest,
    signal: AbortSignal,
    extraHeaders?: Readonly<Record<string, string>>,
    stream = false
  ): Promise<Response> {
    return await fetch(this.apiEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        tools: request.tools,
        tool_choice: "auto",
        stream
      }),
      signal
    });
  }
}

function validateTurnRequest(request: AgentTurnRequest): AgentTurnRequest {
  if (request.sessionId.trim().length === 0) {
    throw new AppError("sessionId is required", "SESSION_ID_REQUIRED", 400);
  }

  if (request.message.trim().length === 0) {
    throw new AppError("message is required", "MESSAGE_REQUIRED", 400);
  }

  return {
    sessionId: request.sessionId.trim(),
    message: request.message.trim(),
    model: request.model?.trim() || undefined
  };
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function cloneSessionMessages(
  messages: readonly AgentSessionMessage[]
): AgentSessionMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function parsePersistedSessions(
  rawText: string,
  filePath: string
): Map<string, AgentSessionMessage[]> {
  let parsed: unknown;

  try {
    parsed = rawText.trim().length === 0 ? { sessions: {} } : JSON.parse(rawText);
  } catch (error) {
    throw new AppError("Session store file is not valid JSON", "INVALID_SESSION_STORE", 500, {
      filePath,
      error: safeErrorMessage(error)
    });
  }

  if (!isPlainObject(parsed)) {
    throw new AppError("Session store file must contain an object", "INVALID_SESSION_STORE", 500, {
      filePath
    });
  }

  const sessions = parsed.sessions;

  if (!isPlainObject(sessions)) {
    throw new AppError("Session store file must contain a sessions object", "INVALID_SESSION_STORE", 500, {
      filePath
    });
  }

  const loadedSessions = new Map<string, AgentSessionMessage[]>();

  for (const [sessionId, rawMessages] of Object.entries(sessions)) {
    if (!Array.isArray(rawMessages) || !rawMessages.every(isAgentSessionMessage)) {
      throw new AppError("Session store file contains invalid messages", "INVALID_SESSION_STORE", 500, {
        filePath,
        sessionId
      });
    }

    loadedSessions.set(sessionId, cloneSessionMessages(rawMessages));
  }

  return loadedSessions;
}

function buildPersistedSessions(
  sessions: ReadonlyMap<string, readonly AgentSessionMessage[]>
): {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, readonly AgentSessionMessage[]>>;
} {
  return {
    version: 1,
    sessions: Object.fromEntries(
      Array.from(sessions.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, messages]) => [sessionId, cloneSessionMessages(messages)])
    )
  };
}

function buildConversationInput(
  instructions: string,
  history: readonly AgentSessionMessage[],
  message: string
): OpenAIInputItem[] {
  return [
    {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: instructions
        }
      ]
    },
    ...history.map((entry): OpenAIInputItem => ({
      type: "message",
      role: entry.role,
      content: [
        {
          type: entry.role === "assistant" ? "output_text" : "input_text",
          text: entry.content
        }
      ] as readonly {
        readonly type: "input_text" | "output_text";
        readonly text: string;
      }[]
    })),
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: message
        }
      ]
    }
  ];
}

function buildToolDefinitions(toolRegistry: ToolRegistry): readonly OpenAIFunctionTool[] {
  return toolRegistry.list().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters:
      tool.inputSchema ??
      ({
        type: "object",
        properties: {},
        additionalProperties: true
      } satisfies JsonSchema)
  }));
}

function tryExtractOutputText(response: OpenAIResponse): string | undefined {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const text = response.output
    .filter(
      (item): item is Extract<OpenAIOutputItem, { type: "message" }> => item.type === "message"
    )
    .flatMap((item) => item.content)
    .map((content) => extractMessageContentText(content))
    .join("")
    .trim();

  return text.length > 0 ? text : undefined;
}

function extractMessageContentText(content: { readonly type: string; readonly text?: string }): string {
  if (typeof content.text === "string") {
    return content.text;
  }

  const refusal = (content as { readonly refusal?: string }).refusal;

  return typeof refusal === "string" ? refusal : "";
}

function parseFunctionArguments(
  rawArguments: string,
  toolName: string
): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("arguments must be an object");
    }

    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new AppError("Invalid tool arguments from model", "INVALID_TOOL_ARGUMENTS", 502, {
      toolName,
      error: safeErrorMessage(error)
    });
  }
}

function isFunctionCallItem(
  item: OpenAIOutputItem
): item is Extract<OpenAIOutputItem, { type: "function_call" }> {
  return item.type === "function_call";
}

function* buildFallbackResponseEvents(
  response: OpenAIResponse
): Generator<OpenAIResponseStreamEvent, void, void> {
  const functionCalls = response.output.filter(isFunctionCallItem);

  if (functionCalls.length === 0) {
    const outputText = tryExtractOutputText(response);

    if (outputText) {
      for (const delta of chunkText(outputText)) {
        yield {
          type: "response.output_text.delta",
          delta
        };
      }
    }
  }

  yield {
    type: "response.completed",
    response
  };
}

function chunkText(text: string, chunkSize = 80): readonly string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }

  return chunks;
}

function isCompletedEvent(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "response.completed" }> {
  return event.type === "response.completed";
}

function isOutputTextDeltaStreamEvent(
  event: OpenAIResponseStreamEvent
): event is OpenAIResponseOutputTextDeltaEvent {
  return event.type === "response.output_text.delta" && typeof event.delta === "string";
}

function extractCompletedStreamResponse(
  event: OpenAIResponseStreamEvent
): OpenAIResponse | undefined {
  if (event.type !== "response.completed") {
    return undefined;
  }

  if (isOpenAIResponse((event as OpenAIResponseCompletedStreamEvent).response)) {
    return (event as OpenAIResponseCompletedStreamEvent).response;
  }

  if (isOpenAIResponse(event)) {
    return event;
  }

  throw new AppError(
    "OpenAI stream completed with an invalid response payload",
    "INVALID_OPENAI_STREAM_RESPONSE",
    502
  );
}

function buildSyntheticTextResponse(outputText: string): OpenAIResponse {
  return {
    id: `synthetic_stream_${Date.now()}`,
    output_text: outputText,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }]
      }
    ]
  };
}

function isFailedOpenAIStreamEvent(
  event: OpenAIResponseStreamEvent
): event is OpenAIResponseFailedStreamEvent | OpenAIErrorStreamEvent {
  return event.type === "response.failed" || event.type === "error";
}

function buildOpenAIStreamEventError(event: OpenAIResponseFailedStreamEvent | OpenAIErrorStreamEvent): AppError {
  const details = extractOpenAIStreamErrorDetails(event);

  return new AppError(details.message, details.code, 502, {
    eventType: event.type
  });
}

function isRetryableOpenAIStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

function isRetryableOpenAIError(error: AppError): boolean {
  return error.statusCode === 504 || error.statusCode === 502 || isRetryableOpenAIStatus(error.statusCode);
}

function normalizeAgentError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (isUnavailableModelChannelError(error.message, error.code)) {
      return new AppError(
        buildUnavailableModelChannelMessage(error.message),
        "OPENAI_MODEL_CHANNEL_UNAVAILABLE",
        error.statusCode,
        error.details
      );
    }

    return error;
  }

  return new AppError("Agent execution failed", "AGENT_EXECUTION_FAILED", 500, {
    error: safeErrorMessage(error)
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentSessionMessage(value: unknown): value is AgentSessionMessage {
  return (
    isPlainObject(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string"
  );
}

function isOpenAIResponse(value: unknown): value is OpenAIResponse {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.output)
  );
}

async function buildOpenAIHttpError(
  response: Response,
  payload?: Partial<OpenAIResponse>
): Promise<AppError> {
  const errorPayload =
    payload && isPlainObject(payload) ? payload : await parseOpenAIErrorPayload(response);
  const errorDetails = extractOpenAIErrorDetails(errorPayload);

  return new AppError(
    errorDetails.message,
    errorDetails.code,
    response.status
  );
}

async function parseOpenAIErrorPayload(
  response: Response
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const responseText = await response.text();

  if (responseText.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseText) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return {
      error: {
        message: responseText
      }
    };
  }
}

function extractOpenAIErrorDetails(
  payload: unknown
): {
  readonly message: string;
  readonly code: string;
} {
  if (!isPlainObject(payload)) {
    return {
      message: "OpenAI request failed",
      code: "OPENAI_RESPONSE_ERROR"
    };
  }

  const nestedError = isPlainObject(payload.error) ? payload.error : undefined;
  const message =
    (typeof nestedError?.message === "string" && nestedError.message.trim().length > 0
      ? nestedError.message
      : typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : "OpenAI request failed");
  const code =
    (typeof nestedError?.code === "string" && nestedError.code.trim().length > 0
      ? nestedError.code
      : typeof payload.code === "string" && payload.code.trim().length > 0
        ? payload.code
        : "OPENAI_RESPONSE_ERROR");

  if (isUnavailableModelChannelError(message, code)) {
    return {
      message: buildUnavailableModelChannelMessage(message),
      code: "OPENAI_MODEL_CHANNEL_UNAVAILABLE"
    };
  }

  return {
    message,
    code
  };
}

function extractOpenAIStreamErrorDetails(
  payload: unknown
): {
  readonly message: string;
  readonly code: string;
} {
  if (!isPlainObject(payload)) {
    return {
      message: "OpenAI streaming request failed",
      code: "OPENAI_STREAM_ERROR"
    };
  }

  const directError = isPlainObject(payload.error) ? payload.error : undefined;
  const nestedResponse = isPlainObject(payload.response) ? payload.response : undefined;
  const nestedError = isPlainObject(nestedResponse?.error) ? nestedResponse.error : undefined;
  const error = directError ?? nestedError;
  const message =
    typeof error?.message === "string" && error.message.trim().length > 0
      ? error.message
      : "OpenAI streaming request failed";
  const code =
    typeof error?.code === "string" && error.code.trim().length > 0
      ? error.code
      : "OPENAI_STREAM_ERROR";

  if (isUnavailableModelChannelError(message, code)) {
    return {
      message: buildUnavailableModelChannelMessage(message),
      code: "OPENAI_MODEL_CHANNEL_UNAVAILABLE"
    };
  }

  return {
    message,
    code
  };
}

function isUnavailableModelChannelError(message: string, code: string): boolean {
  return (
    code === "model_not_found" &&
    /no available channel for model/i.test(message)
  );
}

function buildUnavailableModelChannelMessage(upstreamMessage: string): string {
  return `The configured upstream model is not available in the current provider group. Update OPENAI_MODEL, OPENAI_ENDPOINT, or the API key/channel configuration. Upstream message: ${upstreamMessage}`;
}

function normalizeOpenAITransportError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (isUnavailableModelChannelError(error.message, error.code)) {
      return new AppError(
        buildUnavailableModelChannelMessage(error.message),
        "OPENAI_MODEL_CHANNEL_UNAVAILABLE",
        error.statusCode,
        error.details
      );
    }

    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new AppError("OpenAI request timed out", "OPENAI_TIMEOUT", 504);
  }

  return new AppError("OpenAI request failed", "OPENAI_REQUEST_FAILED", 502, {
    error: safeErrorMessage(error)
  });
}

async function* parseOpenAIResponseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
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
      buffer = buffer.replace(/\r/g, "");

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

        const event = parseOpenAIStreamChunk(chunk);

        if (event) {
          yield event;
        }
      }
    }

    const trailing = buffer.trim();

    if (trailing.length > 0) {
      const event = parseOpenAIStreamChunk(trailing);

      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOpenAIStreamChunk(chunk: string): OpenAIResponseStreamEvent | undefined {
  const lines = chunk.split("\n");
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line[5] === " " ? line.slice(6) : line.slice(5)));

  if (dataLines.length === 0) {
    if (isIgnorableSseChunk(lines)) {
      return undefined;
    }

    throw new AppError("Malformed OpenAI SSE payload", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk
    });
  }

  const rawData = dataLines.join("\n").trim();

  if (rawData === "[DONE]") {
    return undefined;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawData);
  } catch (error) {
    throw new AppError("Invalid JSON in OpenAI SSE payload", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk,
      error: safeErrorMessage(error)
    });
  }

  if (!isPlainObject(payload) || typeof payload.type !== "string") {
    throw new AppError("OpenAI SSE payload is missing a type", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk
    });
  }

  if (eventName && payload.type !== eventName) {
    throw new AppError("OpenAI SSE event type mismatch", "INVALID_OPENAI_STREAM_EVENT", 502, {
      eventName,
      payloadType: payload.type
    });
  }

  return payload as OpenAIResponseStreamEvent;
}

function isIgnorableSseChunk(lines: readonly string[]): boolean {
  return lines.every((line) => {
    const trimmed = line.trim();

    return (
      trimmed.length === 0 ||
      trimmed.startsWith(":") ||
      trimmed.startsWith("event:") ||
      trimmed.startsWith("id:") ||
      trimmed.startsWith("retry:")
    );
  });
}

export function resolveResponsesApiEndpoint(endpoint: string): string {
  const normalized = endpoint.trim();

  if (normalized.length === 0) {
    return "https://api.openai.com/v1/responses";
  }

  if (normalized.endsWith("/responses")) {
    return normalized;
  }

  return `${normalized.replace(/\/+$/, "")}/responses`;
}

export function buildAgentManifest(manifest: AgentManifest): {
  projectName: string;
  currentGoal: string;
  nextPriority: string;
  rules: readonly string[];
  summary: string;
} {
  const parsed = AgentManifestSchema.safeParse(manifest);

  if (!parsed.success) {
    throw new AppError("Invalid agent manifest", "INVALID_AGENT_MANIFEST", 400, {
      issues: parsed.error.issues
    });
  }

  const [nextPriority] = parsed.data.priorities;

  return {
    projectName: parsed.data.projectName,
    currentGoal: parsed.data.currentGoal,
    nextPriority,
    rules: parsed.data.rules,
    summary: `${parsed.data.projectName}: ${parsed.data.currentGoal}`
  };
}
