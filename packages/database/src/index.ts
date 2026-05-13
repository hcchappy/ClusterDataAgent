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

export interface ReadOnlyQueryExecutor {
  executeReadOnlyQuery(sql: string): Promise<ReadOnlyQueryResult>;
}

export interface PostgresClientQueryResult<T extends DatabaseQueryRow = DatabaseQueryRow> {
  readonly rows: readonly T[];
  readonly rowCount?: number | null;
  readonly fields?: readonly DatabaseQueryField[];
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
