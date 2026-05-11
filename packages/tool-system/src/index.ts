import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";

export type JsonSchema =
  | {
      readonly type: "string";
      readonly description?: string;
      readonly enum?: readonly string[];
    }
  | {
      readonly type: "number" | "integer";
      readonly description?: string;
    }
  | {
      readonly type: "boolean" | "null";
      readonly description?: string;
    }
  | {
      readonly type: "array";
      readonly description?: string;
      readonly items: JsonSchema;
    }
  | {
      readonly type: "object";
      readonly description?: string;
      readonly properties?: Readonly<Record<string, JsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    };

export interface ToolExecutionContext {
  readonly toolName: string;
  readonly attempt: number;
  readonly requestId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
}

export interface ToolExecutionPolicy {
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly execution?: ToolExecutionPolicy;
  execute(
    input: TInput,
    context?: ToolExecutionContext
  ): Promise<TResult> | TResult;
}

export interface ToolMetrics {
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly averageDurationMs: number;
  readonly lastDurationMs: number;
}

export interface ToolHookPayload<TInput = unknown> {
  readonly toolName: string;
  readonly input: TInput;
  readonly attempt: number;
  readonly requestId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolSuccessHookPayload<TInput = unknown, TResult = unknown>
  extends ToolHookPayload<TInput> {
  readonly output: TResult;
  readonly durationMs: number;
}

export interface ToolErrorHookPayload<TInput = unknown>
  extends ToolHookPayload<TInput> {
  readonly error: unknown;
  readonly durationMs: number;
  readonly willRetry: boolean;
}

export interface ToolExecutionHooks {
  beforeExecute?(payload: ToolHookPayload): void | Promise<void>;
  afterExecute?(payload: ToolSuccessHookPayload): void | Promise<void>;
  onError?(payload: ToolErrorHookPayload): void | Promise<void>;
}

export interface ToolRegistryOptions {
  readonly hooks?: ToolExecutionHooks;
  readonly logger?: Logger;
}

interface MutableToolMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly hooks?: ToolExecutionHooks;
  private readonly logger: Logger;
  private readonly metrics = new Map<string, MutableToolMetrics>();

  public constructor(options: ToolRegistryOptions = {}) {
    this.hooks = options.hooks;
    this.logger = options.logger ?? createLogger("tool-system");
  }

  public register<TInput, TResult>(tool: ToolDefinition<TInput, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new AppError(
        `Tool already registered: ${tool.name}`,
        "TOOL_ALREADY_REGISTERED",
        409
      );
    }

    this.tools.set(tool.name, tool);
    this.metrics.set(tool.name, {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastDurationMs: 0
    });
  }

  public list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public getMetrics(): Readonly<Record<string, ToolMetrics>> {
    return Object.fromEntries(
      Array.from(this.metrics.entries()).map(([name, metric]) => [
        name,
        {
          calls: metric.calls,
          successes: metric.successes,
          failures: metric.failures,
          averageDurationMs:
            metric.calls === 0 ? 0 : metric.totalDurationMs / metric.calls,
          lastDurationMs: metric.lastDurationMs
        }
      ])
    );
  }

  public async execute<TInput, TResult>(
    name: string,
    input: TInput,
    context: Omit<ToolExecutionContext, "toolName" | "attempt"> = {}
  ): Promise<TResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new AppError(`Unknown tool: ${name}`, "UNKNOWN_TOOL", 404);
    }

    if (tool.inputSchema) {
      const issues = validateAgainstSchema(tool.inputSchema, input);

      if (issues.length > 0) {
        throw new AppError("Invalid tool input", "INVALID_TOOL_INPUT", 400, {
          toolName: name,
          issues
        });
      }
    }

    const retries = Math.max(tool.execution?.retries ?? 0, 0);

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const executionContext: ToolExecutionContext = {
        ...context,
        toolName: name,
        attempt,
        logger: context.logger ?? this.logger
      };
      const startedAt = Date.now();

      await this.hooks?.beforeExecute?.({
        toolName: name,
        input,
        attempt,
        requestId: context.requestId,
        metadata: context.metadata
      });

      try {
        const result = await runWithTimeout(
          () => tool.execute(input, executionContext),
          tool.execution?.timeoutMs
        );
        const durationMs = Date.now() - startedAt;

        this.recordMetric(name, durationMs, true);
        this.logger.info("tool executed", {
          toolName: name,
          attempt,
          durationMs,
          requestId: context.requestId
        });

        await this.hooks?.afterExecute?.({
          toolName: name,
          input,
          output: result,
          attempt,
          durationMs,
          requestId: context.requestId,
          metadata: context.metadata
        });

        return result as TResult;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const willRetry = attempt <= retries && isRetryableToolError(error);

        this.recordMetric(name, durationMs, false);
        this.logger.error("tool execution failed", {
          toolName: name,
          attempt,
          durationMs,
          requestId: context.requestId,
          error: safeErrorMessage(error)
        });

        await this.hooks?.onError?.({
          toolName: name,
          input,
          error,
          attempt,
          durationMs,
          willRetry,
          requestId: context.requestId,
          metadata: context.metadata
        });

        if (willRetry) {
          continue;
        }

        throw normalizeToolError(name, error);
      }
    }

    throw new AppError("Tool execution exhausted retries", "TOOL_RETRY_EXHAUSTED", 500, {
      toolName: name
    });
  }

  private recordMetric(name: string, durationMs: number, success: boolean): void {
    const metric = this.metrics.get(name);

    if (!metric) {
      return;
    }

    metric.calls += 1;
    metric.totalDurationMs += durationMs;
    metric.lastDurationMs = durationMs;

    if (success) {
      metric.successes += 1;
      return;
    }

    metric.failures += 1;
  }
}

function validateAgainstSchema(schema: JsonSchema, input: unknown, path = "$"): string[] {
  switch (schema.type) {
    case "string":
      if (typeof input !== "string") {
        return [`${path} must be a string`];
      }

      if (schema.enum && !schema.enum.includes(input)) {
        return [`${path} must be one of: ${schema.enum.join(", ")}`];
      }

      return [];
    case "number":
      return typeof input === "number" && Number.isFinite(input)
        ? []
        : [`${path} must be a number`];
    case "integer":
      return Number.isInteger(input) ? [] : [`${path} must be an integer`];
    case "boolean":
      return typeof input === "boolean" ? [] : [`${path} must be a boolean`];
    case "null":
      return input === null ? [] : [`${path} must be null`];
    case "array":
      if (!Array.isArray(input)) {
        return [`${path} must be an array`];
      }

      return input.flatMap((item, index) =>
        validateAgainstSchema(schema.items, item, `${path}[${index}]`)
      );
    case "object":
      if (!isPlainObject(input)) {
        return [`${path} must be an object`];
      }

      return validateObjectSchema(schema, input, path);
    default:
      return [`${path} has an unsupported schema type`];
  }
}

function validateObjectSchema(
  schema: Extract<JsonSchema, { type: "object" }>,
  input: Readonly<Record<string, unknown>>,
  path: string
): string[] {
  const issues: string[] = [];
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const name of required) {
    if (!(name in input)) {
      issues.push(`${path}.${name} is required`);
    }
  }

  for (const [name, value] of Object.entries(input)) {
    const propertySchema = properties[name];

    if (!propertySchema) {
      if (schema.additionalProperties === false) {
        issues.push(`${path}.${name} is not allowed`);
      }

      continue;
    }

    issues.push(...validateAgainstSchema(propertySchema, value, `${path}.${name}`));
  }

  return issues;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runWithTimeout<T>(
  operation: () => Promise<T> | T,
  timeoutMs?: number
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return await operation();
  }

  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(operation()),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new AppError("Tool execution timed out", "TOOL_EXECUTION_TIMEOUT", 504, {
              timeoutMs
            })
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function isRetryableToolError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.statusCode >= 500;
  }

  return true;
}

function normalizeToolError(toolName: string, error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("Tool execution failed", "TOOL_EXECUTION_FAILED", 500, {
    toolName,
    error: safeErrorMessage(error)
  });
}
