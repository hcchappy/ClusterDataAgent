export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: LogContext;

  public constructor(
    message: string,
    code: string,
    statusCode = 500,
    details?: LogContext
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface SerializedAppError {
  readonly message: string;
  readonly code: string;
  readonly statusCode: number;
  readonly details?: LogContext;
  readonly requestId?: string;
}

export interface ErrorResponseBody {
  readonly ok: false;
  readonly message: string;
  readonly code: string;
  readonly error: SerializedAppError;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unexpected error";
}

export function serializeAppError(
  error: unknown,
  requestId?: string
): SerializedAppError {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("Internal error", "INTERNAL_ERROR", 500);

  return {
    message: appError.message,
    code: appError.code,
    statusCode: appError.statusCode,
    ...(appError.details ? { details: appError.details } : {}),
    ...(requestId ? { requestId } : {})
  };
}

export function buildErrorResponse(
  error: unknown,
  requestId?: string
): ErrorResponseBody {
  const serialized = serializeAppError(error, requestId);

  return {
    ok: false,
    message: serialized.message,
    code: serialized.code,
    error: serialized
  };
}

export function formatLogEntry(
  level: LogLevel,
  scope: string,
  message: string,
  context?: LogContext
): string {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ? { context } : {})
  };

  return JSON.stringify(entry);
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, context?: LogContext) => {
    const entry = formatLogEntry(level, scope, message, context);

    if (level === "error") {
      console.error(entry);
      return;
    }

    if (level === "warn") {
      console.warn(entry);
      return;
    }

    console.log(entry);
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}

export function nonEmptyList<T>(items: readonly T[]): readonly T[] {
  if (items.length === 0) {
    throw new AppError("List cannot be empty", "EMPTY_LIST", 400);
  }

  return items;
}
