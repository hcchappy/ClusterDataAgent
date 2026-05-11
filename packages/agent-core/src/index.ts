import { z } from "zod";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";
import { type JsonSchema, type ToolRegistry } from "@clusterdata/tool-system";

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
    return this.sessions.get(sessionId) ?? [];
  }

  public append(sessionId: string, messages: readonly AgentSessionMessage[]): void {
    const next = [...this.get(sessionId), ...messages].slice(-this.maxMessages);
    this.sessions.set(sessionId, next);
  }
}

export interface ResponsesTransport {
  createResponse(request: OpenAIResponseRequest): Promise<OpenAIResponse>;
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
      "You are ClusterDataAgent. Use available tools when they help answer data and safety questions accurately. Be concise and explicit.";
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
    let latestResponse: OpenAIResponse | undefined;

    this.logger.info("agent turn started", {
      sessionId: request.sessionId,
      model,
      historyCount: history.length
    });

    while (true) {
      latestResponse = await this.createResponseWithRetry({
        model,
        input: conversation,
        tools: buildToolDefinitions(this.toolRegistry)
      });

      const functionCalls = latestResponse.output.filter(isFunctionCallItem);

      if (functionCalls.length === 0) {
        const outputText = extractOutputText(latestResponse);

        for (const delta of chunkText(outputText)) {
          yield {
            type: "response.output_text.delta",
            sessionId: request.sessionId,
            delta
          };
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
        const response = await fetch(this.apiEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: request.model,
            input: request.input,
            tools: request.tools,
            tool_choice: "auto"
          }),
          signal: controller.signal
        });

        const payload = (await response.json()) as Partial<OpenAIResponse> & {
          readonly error?: {
            readonly message?: string;
            readonly code?: string;
          };
        };

        if (!response.ok) {
          const errorCode = payload.error?.code ?? "OPENAI_RESPONSE_ERROR";
          const errorMessage = payload.error?.message ?? "OpenAI request failed";
          const appError = new AppError(errorMessage, errorCode, response.status);

          if (attempt <= this.maxRetries && isRetryableOpenAIStatus(response.status)) {
            this.logger.warn("openai request retrying", {
              attempt,
              statusCode: response.status,
              error: errorMessage
            });
            continue;
          }

          throw appError;
        }

        return payload as OpenAIResponse;
      } catch (error) {
        const normalizedError =
          error instanceof AppError
            ? error
            : error instanceof DOMException && error.name === "AbortError"
              ? new AppError("OpenAI request timed out", "OPENAI_TIMEOUT", 504)
              : new AppError("OpenAI request failed", "OPENAI_REQUEST_FAILED", 502, {
                  error: safeErrorMessage(error)
                });

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

function extractOutputText(response: OpenAIResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const text = response.output
    .filter(
      (item): item is Extract<OpenAIOutputItem, { type: "message" }> => item.type === "message"
    )
    .flatMap((item) => item.content)
    .map((content) => content.text ?? "")
    .join("")
    .trim();

  if (text.length === 0) {
    throw new AppError("Model returned an empty response", "EMPTY_MODEL_RESPONSE", 502);
  }

  return text;
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

function isRetryableOpenAIStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

function isRetryableOpenAIError(error: AppError): boolean {
  return error.statusCode === 504 || error.statusCode === 502 || isRetryableOpenAIStatus(error.statusCode);
}

function normalizeAgentError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("Agent execution failed", "AGENT_EXECUTION_FAILED", 500, {
    error: safeErrorMessage(error)
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
