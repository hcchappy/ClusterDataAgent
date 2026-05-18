import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";

export const DatabaseConfigSchema = z.object({
  databaseUrl: z.string().optional().default("")
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_RESULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_ASYNC_QUERY_JOB_TTL_MS = 15 * 60_000;
const DEFAULT_ASYNC_QUERY_JOB_MAX_ENTRIES = 100;

export interface DatabaseQueryRow {
  readonly [key: string]: unknown;
}

export interface DatabaseQueryField {
  readonly name: string;
}

export interface ReadOnlyQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly DatabaseQueryRow[];
  readonly rowCount: number;
  readonly durationMs: number;
}

export interface QueryResultPage {
  readonly offset: number;
  readonly limit: number;
  readonly returnedRows: number;
  readonly hasMore: boolean;
}

export interface PaginatedReadOnlyQueryResult extends ReadOnlyQueryResult {
  readonly page: QueryResultPage;
}

export interface ReadOnlyQueryExecutor {
  executeReadOnlyQuery(sql: string): Promise<ReadOnlyQueryResult>;
}

export interface QueryResultCacheEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly hitCount: number;
}

export interface InMemoryQueryResultCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export type AsyncQueryJobStatus = "running" | "completed" | "failed";

export interface AsyncQueryJobError {
  readonly message: string;
  readonly code?: string;
}

export interface AsyncQueryJobRecord<T> {
  readonly jobId: string;
  readonly status: AsyncQueryJobStatus;
  readonly submittedAt: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
  readonly cacheKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly error?: AsyncQueryJobError;
  readonly result?: T;
}

export interface InMemoryAsyncQueryJobManagerOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

export interface PostgresClientQueryResult<T extends DatabaseQueryRow = DatabaseQueryRow> {
  readonly rows: readonly T[];
  readonly rowCount?: number | null;
  readonly fields?: readonly DatabaseQueryField[];
}

interface MutableQueryResultCacheEntry<T> {
  key: string;
  value: T;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

interface AsyncQueryJobMutableRecord<T> {
  jobId: string;
  status: AsyncQueryJobStatus;
  submittedAt: string;
  startedAt: string;
  completedAt?: string;
  expiresAt: string;
  cacheKey?: string;
  metadata?: Readonly<Record<string, unknown>>;
  error?: AsyncQueryJobError;
  result?: T;
}

export interface PostgresClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends DatabaseQueryRow = DatabaseQueryRow>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<PostgresClientQueryResult<T>>;
}

export type PostgresClientFactory = (databaseUrl: string) => PostgresClient;

export interface PostgresReadOnlyQueryExecutorOptions {
  readonly databaseUrl: string;
  readonly statementTimeoutMs?: number;
  readonly logger?: Logger;
  readonly clientFactory?: PostgresClientFactory;
}

export function summarizeDatabaseConfig(config: DatabaseConfig): {
  readonly configured: boolean;
  readonly dialect: "postgresql" | "unknown";
} {
  const parsed = DatabaseConfigSchema.safeParse(config);

  if (!parsed.success) {
    throw new AppError("Invalid database config", "INVALID_DATABASE_CONFIG", 400, {
      issues: parsed.error.issues
    });
  }

  return {
    configured: parsed.data.databaseUrl.length > 0,
    dialect: parsed.data.databaseUrl.startsWith("postgresql://")
      ? "postgresql"
      : "unknown"
  };
}

export function buildQueryResultCacheKey(
  parts: readonly (string | number | boolean | undefined | null)[]
): string {
  const normalized = parts
    .map((part) => (part === undefined || part === null ? "" : String(part).trim()))
    .join("\u001f");

  return `query:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function paginateReadOnlyQueryResult(
  result: ReadOnlyQueryResult,
  options: {
    readonly offset?: number;
    readonly limit?: number;
  } = {}
): PaginatedReadOnlyQueryResult {
  const offset = normalizePaginationOffset(options.offset);
  const limit = normalizePaginationLimit(options.limit, result.rows.length);
  const rows = result.rows.slice(offset, offset + limit);

  return {
    ...result,
    rows,
    page: {
      offset,
      limit,
      returnedRows: rows.length,
      hasMore: offset + rows.length < result.rows.length
    }
  };
}

export class InMemoryQueryResultCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly entries = new Map<string, MutableQueryResultCacheEntry<T>>();

  public constructor(options: InMemoryQueryResultCacheOptions = {}) {
    this.ttlMs = validatePositiveInteger(
      options.ttlMs ?? DEFAULT_QUERY_RESULT_CACHE_TTL_MS,
      "Query result cache TTL",
      "INVALID_QUERY_RESULT_CACHE_TTL"
    );
    this.maxEntries = validatePositiveInteger(
      options.maxEntries ?? DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES,
      "Query result cache max entries",
      "INVALID_QUERY_RESULT_CACHE_MAX_ENTRIES"
    );
    this.logger = options.logger ?? createLogger("database.cache");
    this.now = options.now ?? Date.now;
  }

  public get(key: string): QueryResultCacheEntry<T> | undefined {
    const normalizedKey = assertNonEmptyCacheKey(key);

    this.evictExpiredEntries();

    const entry = this.entries.get(normalizedKey);

    if (!entry) {
      this.logger.info("query result cache miss", {
        key: normalizedKey,
        size: this.entries.size
      });
      return undefined;
    }

    entry.hitCount += 1;
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, entry);

    this.logger.info("query result cache hit", {
      key: normalizedKey,
      hitCount: entry.hitCount,
      size: this.entries.size
    });

    return { ...entry };
  }

  public set(key: string, value: T): QueryResultCacheEntry<T> {
    const normalizedKey = assertNonEmptyCacheKey(key);
    const now = this.now();
    const entry: MutableQueryResultCacheEntry<T> = {
      key: normalizedKey,
      value,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      hitCount: 0
    };

    this.evictExpiredEntries();
    this.entries.set(normalizedKey, entry);
    this.evictOverflowEntries();

    this.logger.info("query result cache stored", {
      key: normalizedKey,
      ttlMs: this.ttlMs,
      size: this.entries.size
    });

    return { ...entry };
  }

  public delete(key: string): boolean {
    const normalizedKey = assertNonEmptyCacheKey(key);
    const deleted = this.entries.delete(normalizedKey);

    if (deleted) {
      this.logger.info("query result cache entry deleted", {
        key: normalizedKey,
        size: this.entries.size
      });
    }

    return deleted;
  }

  public clear(): void {
    const previousSize = this.entries.size;
    this.entries.clear();

    this.logger.info("query result cache cleared", {
      previousSize
    });
  }

  private evictExpiredEntries(): void {
    const now = this.now();
    let deletedCount = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (Date.parse(entry.expiresAt) > now) {
        continue;
      }

      this.entries.delete(key);
      deletedCount += 1;
    }

    if (deletedCount > 0) {
      this.logger.info("query result cache expired entries cleared", {
        deletedCount,
        size: this.entries.size
      });
    }
  }

  private evictOverflowEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;

      if (typeof oldestKey !== "string") {
        break;
      }

      this.entries.delete(oldestKey);
      this.logger.info("query result cache entry evicted", {
        key: oldestKey,
        size: this.entries.size
      });
    }
  }
}

export class InMemoryAsyncQueryJobManager<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly jobs = new Map<string, AsyncQueryJobMutableRecord<T>>();

  public constructor(options: InMemoryAsyncQueryJobManagerOptions = {}) {
    this.ttlMs = validatePositiveInteger(
      options.ttlMs ?? DEFAULT_ASYNC_QUERY_JOB_TTL_MS,
      "Async query job TTL",
      "INVALID_ASYNC_QUERY_JOB_TTL"
    );
    this.maxEntries = validatePositiveInteger(
      options.maxEntries ?? DEFAULT_ASYNC_QUERY_JOB_MAX_ENTRIES,
      "Async query job max entries",
      "INVALID_ASYNC_QUERY_JOB_MAX_ENTRIES"
    );
    this.logger = options.logger ?? createLogger("database.jobs");
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
  }

  public start(
    execute: () => Promise<T>,
    options: {
      readonly cacheKey?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    } = {}
  ): AsyncQueryJobRecord<T> {
    const job = this.createRunningRecord(options);

    void (async () => {
      try {
        const result = await execute();
        this.complete(job.jobId, result);
      } catch (error) {
        this.fail(job.jobId, error);
      }
    })();

    return job;
  }

  public createCompleted(
    result: T,
    options: {
      readonly cacheKey?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    } = {}
  ): AsyncQueryJobRecord<T> {
    const now = this.now();
    const record: AsyncQueryJobMutableRecord<T> = {
      jobId: this.generateId(),
      status: "completed",
      submittedAt: new Date(now).toISOString(),
      startedAt: new Date(now).toISOString(),
      completedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      cacheKey: options.cacheKey,
      metadata: options.metadata,
      result
    };

    this.storeRecord(record);
    this.logger.info("async query job created from cached result", {
      jobId: record.jobId,
      cacheKey: record.cacheKey
    });

    return { ...record };
  }

  public get(jobId: string): AsyncQueryJobRecord<T> | undefined {
    const normalizedJobId = assertNonEmptyAsyncQueryJobId(jobId);

    this.evictExpiredJobs();

    const record = this.jobs.get(normalizedJobId);

    if (!record) {
      this.logger.info("async query job miss", {
        jobId: normalizedJobId,
        size: this.jobs.size
      });
      return undefined;
    }

    return { ...record };
  }

  public complete(jobId: string, result: T): AsyncQueryJobRecord<T> | undefined {
    const normalizedJobId = assertNonEmptyAsyncQueryJobId(jobId);
    const record = this.jobs.get(normalizedJobId);

    if (!record) {
      this.logger.warn("async query job completion skipped because the job no longer exists", {
        jobId: normalizedJobId
      });
      return undefined;
    }

    const completedAt = new Date(this.now()).toISOString();
    const nextRecord: AsyncQueryJobMutableRecord<T> = {
      ...record,
      status: "completed",
      completedAt,
      result,
      error: undefined
    };

    this.jobs.set(normalizedJobId, nextRecord);
    this.logger.info("async query job completed", {
      jobId: normalizedJobId,
      cacheKey: nextRecord.cacheKey
    });

    return { ...nextRecord };
  }

  public fail(jobId: string, error: unknown): AsyncQueryJobRecord<T> | undefined {
    const normalizedJobId = assertNonEmptyAsyncQueryJobId(jobId);
    const record = this.jobs.get(normalizedJobId);

    if (!record) {
      this.logger.warn("async query job failure skipped because the job no longer exists", {
        jobId: normalizedJobId,
        error: safeErrorMessage(error)
      });
      return undefined;
    }

    const completedAt = new Date(this.now()).toISOString();
    const nextRecord: AsyncQueryJobMutableRecord<T> = {
      ...record,
      status: "failed",
      completedAt,
      error: {
        message: safeErrorMessage(error),
        code: error instanceof AppError ? error.code : undefined
      },
      result: undefined
    };

    this.jobs.set(normalizedJobId, nextRecord);
    this.logger.error("async query job failed", {
      jobId: normalizedJobId,
      cacheKey: nextRecord.cacheKey,
      error: nextRecord.error?.message,
      code: nextRecord.error?.code
    });

    return { ...nextRecord };
  }

  public delete(jobId: string): boolean {
    const normalizedJobId = assertNonEmptyAsyncQueryJobId(jobId);
    const deleted = this.jobs.delete(normalizedJobId);

    if (deleted) {
      this.logger.info("async query job deleted", {
        jobId: normalizedJobId,
        size: this.jobs.size
      });
    }

    return deleted;
  }

  public clear(): void {
    const previousSize = this.jobs.size;
    this.jobs.clear();

    this.logger.info("async query job store cleared", {
      previousSize
    });
  }

  private createRunningRecord(options: {
    readonly cacheKey?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): AsyncQueryJobRecord<T> {
    const now = this.now();
    const record: AsyncQueryJobMutableRecord<T> = {
      jobId: this.generateId(),
      status: "running",
      submittedAt: new Date(now).toISOString(),
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      cacheKey: options.cacheKey,
      metadata: options.metadata
    };

    this.storeRecord(record);
    this.logger.info("async query job started", {
      jobId: record.jobId,
      cacheKey: record.cacheKey
    });

    return { ...record };
  }

  private storeRecord(record: AsyncQueryJobMutableRecord<T>): void {
    this.evictExpiredJobs();
    this.jobs.set(record.jobId, record);
    this.evictOverflowJobs();
  }

  private evictExpiredJobs(): void {
    const now = this.now();
    let deletedCount = 0;

    for (const [jobId, record] of this.jobs.entries()) {
      if (Date.parse(record.expiresAt) > now) {
        continue;
      }

      this.jobs.delete(jobId);
      deletedCount += 1;
    }

    if (deletedCount > 0) {
      this.logger.info("async query jobs expired entries cleared", {
        deletedCount,
        size: this.jobs.size
      });
    }
  }

  private evictOverflowJobs(): void {
    while (this.jobs.size > this.maxEntries) {
      const oldestJobId = this.jobs.keys().next().value;

      if (typeof oldestJobId !== "string") {
        break;
      }

      this.jobs.delete(oldestJobId);
      this.logger.info("async query job evicted", {
        jobId: oldestJobId,
        size: this.jobs.size
      });
    }
  }
}

export class PostgresReadOnlyQueryExecutor implements ReadOnlyQueryExecutor {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly logger: Logger;
  private readonly clientFactory: PostgresClientFactory;

  public constructor(options: PostgresReadOnlyQueryExecutorOptions) {
    const summary = summarizeDatabaseConfig({
      databaseUrl: options.databaseUrl
    });

    if (!summary.configured) {
      throw new AppError("Database URL is required", "DATABASE_URL_REQUIRED", 500);
    }

    if (summary.dialect !== "postgresql") {
      throw new AppError("Only PostgreSQL is supported", "UNSUPPORTED_DATABASE_DIALECT", 500, {
        dialect: summary.dialect
      });
    }

    if (
      !Number.isInteger(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS) ||
      (options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS) <= 0
    ) {
      throw new AppError(
        "Statement timeout must be a positive integer",
        "INVALID_STATEMENT_TIMEOUT",
        500
      );
    }

    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs =
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.logger = options.logger ?? createLogger("database");
    this.clientFactory = options.clientFactory ?? createPgClient;
  }

  public async executeReadOnlyQuery(sql: string): Promise<ReadOnlyQueryResult> {
    const normalizedSql = sql.trim();

    if (normalizedSql.length === 0) {
      throw new AppError("SQL cannot be empty", "EMPTY_SQL", 400);
    }

    const client = this.clientFactory(this.databaseUrl);
    const startedAt = Date.now();
    let transactionStarted = false;

    this.logger.info("read-only query started", {
      sqlLength: normalizedSql.length,
      statementTimeoutMs: this.statementTimeoutMs
    });

    try {
      await client.connect();
      await client.query("begin read only");
      transactionStarted = true;
      await client.query(`set local statement_timeout = ${this.statementTimeoutMs}`);
      const result = await client.query(normalizedSql);
      await client.query("commit");
      transactionStarted = false;

      const columns = resolveColumns(result);
      const rows = result.rows.map((row) => ({ ...row }));
      const durationMs = Date.now() - startedAt;

      this.logger.info("read-only query completed", {
        columnCount: columns.length,
        rowCount: result.rowCount ?? rows.length,
        durationMs
      });

      return {
        columns,
        rows,
        rowCount: result.rowCount ?? rows.length,
        durationMs
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("rollback");
        } catch (rollbackError) {
          this.logger.warn("read-only query rollback failed", {
            error: safeErrorMessage(rollbackError)
          });
        }
      }

      this.logger.error("read-only query failed", {
        error: safeErrorMessage(error)
      });

      throw new AppError(
        "Database query execution failed",
        "DATABASE_QUERY_FAILED",
        502,
        {
          error: safeErrorMessage(error)
        }
      );
    } finally {
      try {
        await client.end();
      } catch (error) {
        this.logger.warn("database client close failed", {
          error: safeErrorMessage(error)
        });
      }
    }
  }
}

function resolveColumns(result: PostgresClientQueryResult): readonly string[] {
  if (result.fields && result.fields.length > 0) {
    return result.fields.map((field) => field.name);
  }

  const firstRow = result.rows[0];

  if (!firstRow) {
    return [];
  }

  return Object.keys(firstRow);
}

function validatePositiveInteger(value: number, name: string, code: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(`${name} must be a positive integer`, code, 500, {
      value
    });
  }

  return value;
}

function normalizePaginationOffset(value: number | undefined): number {
  if (typeof value === "undefined") {
    return 0;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new AppError("Pagination offset must be a non-negative integer", "INVALID_PAGINATION_OFFSET", 400, {
      offset: value
    });
  }

  return value;
}

function normalizePaginationLimit(value: number | undefined, fallbackSize: number): number {
  if (typeof value === "undefined") {
    return fallbackSize > 0 ? fallbackSize : 1;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("Pagination limit must be a positive integer", "INVALID_PAGINATION_LIMIT", 400, {
      limit: value
    });
  }

  return value;
}

function assertNonEmptyCacheKey(key: string): string {
  const normalizedKey = key.trim();

  if (normalizedKey.length === 0) {
    throw new AppError("Query result cache key is required", "QUERY_RESULT_CACHE_KEY_REQUIRED", 500);
  }

  return normalizedKey;
}

function assertNonEmptyAsyncQueryJobId(jobId: string): string {
  const normalizedJobId = jobId.trim();

  if (normalizedJobId.length === 0) {
    throw new AppError("Async query job id is required", "ASYNC_QUERY_JOB_ID_REQUIRED", 400);
  }

  return normalizedJobId;
}

function createPgClient(databaseUrl: string): PostgresClient {
  const client = new pg.Client({
    connectionString: databaseUrl
  });

  return {
    async connect() {
      await client.connect();
    },
    async end() {
      await client.end();
    },
    async query<T extends DatabaseQueryRow = DatabaseQueryRow>(
      sql: string,
      values?: readonly unknown[]
    ) {
      const result = await client.query<T>(sql, values ? [...values] : undefined);

      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields.map((field) => ({
          name: field.name
        }))
      };
    }
  };
}
