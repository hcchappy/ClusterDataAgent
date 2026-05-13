import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import {
  AgentExecutor,
  FileSessionStore,
  InMemorySessionStore,
  buildAgentManifest,
  type AgentTurnRequest,
  type SessionStore
} from "@clusterdata/agent-core";
import {
  analyzeTimeSeries,
  profileDataset,
  summarizeSeries,
  type DatasetRow,
  type TimeSeriesPoint
} from "@clusterdata/analysis-service";
import {
  buildEChartsOption,
  chooseChartKind,
  recommendChartsFromProfile
} from "@clusterdata/chart-engine";
import {
  PostgresReadOnlyQueryExecutor,
  summarizeDatabaseConfig,
  type ReadOnlyQueryExecutor
} from "@clusterdata/database";
import {
  InMemoryMetadataCache,
  PrismaMetadataCatalogService,
  loadPostgresSchemaCatalog,
  searchMetadataCatalog,
  type PrismaSchemaCatalog
} from "@clusterdata/metadata-engine";
import {
  assertAccessRequestInput,
  assertChartRequestSecurity,
  assertChatRequestSecurity,
  assertDatasetProfileRequestSecurity,
  assertMetadataSearchRequestSecurity,
  assertSeriesRequestSecurity,
  assertSqlRequestSecurity,
  assertSqlSuggestionRequestSecurity,
  assertTimeSeriesRequestSecurity,
  authorizeAccess,
  buildRequestSecurityPolicy
} from "@clusterdata/security";
import { createLogger, safeErrorMessage, AppError } from "@clusterdata/shared";
import {
  buildMetadataAwareSelectQuery as buildSqlAwareSelectQuery,
  buildSafeLimitClause,
  validateSqlStatement
} from "@clusterdata/sql-agent";
import { ToolRegistry, type ToolRegistryOptions } from "@clusterdata/tool-system";
import { loadApiConfig, type ApiConfig } from "./config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(moduleDir, "../../../packages/database/prisma/schema.prisma");
const DEFAULT_SQL_LIMIT = 500;

export interface BuildApiOptions {
  readonly agentExecutor?: AgentExecutor;
  readonly queryExecutor?: ReadOnlyQueryExecutor;
  readonly sessionStore?: SessionStore;
  readonly toolRegistry?: ToolRegistry;
  readonly metadataCatalog?: PrismaSchemaCatalog;
  readonly metadataService?: PrismaMetadataCatalogService;
  readonly metadataCatalogLoader?: (config: ApiConfig) => Promise<PrismaSchemaCatalog>;
}

export async function buildApi(options: BuildApiOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    logger: true
  });
  const config = loadApiConfig(process.env);
  const logger = createLogger("api");
  const requestSecurityPolicy = buildRequestSecurityPolicy(config.requestSecurity);
  const metadataService =
    options.metadataService ??
    new PrismaMetadataCatalogService({
      sourcePath: schemaPath,
      cache: new InMemoryMetadataCache(),
      initialCatalog: options.metadataCatalog,
      logger
    });
  let metadataCatalog =
    options.metadataCatalog ??
    (await loadConfiguredMetadataCatalog(
      config,
      metadataService,
      logger,
      options.metadataCatalogLoader
    ));
  const queryExecutor = options.queryExecutor ?? createQueryExecutor(config, logger);
  const toolRegistry =
    options.toolRegistry ?? buildToolRegistry(() => metadataCatalog, queryExecutor);
  const sessionStore = options.sessionStore ?? createSessionStore(config, logger);
  const agentExecutor =
    options.agentExecutor ??
    (config.openAiApiKey.trim().length > 0
      ? new AgentExecutor({
          toolRegistry,
          sessionStore,
          config: {
            apiKey: config.openAiApiKey,
            apiEndpoint: config.openAiEndpoint,
            defaultModel: config.openAiModel,
            requestTimeoutMs: config.openAiTimeoutMs,
            maxToolCalls: config.agentMaxToolCalls,
            maxRetries: 1
          },
          logger
        })
      : undefined);

  logger.info("metadata catalog loaded", {
    sourcePath: metadataCatalog.sourcePath,
    tableCount: metadataCatalog.summary.tableCount,
    relationCount: metadataCatalog.summary.relationCount
  });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : undefined;
    const statusCode = appError?.statusCode ?? 500;

    app.log.error(
      {
        err: error,
        code: appError?.code
      },
      "request failed"
    );

    reply.status(statusCode).send({
      ok: false,
      error: safeErrorMessage(error),
      code: appError?.code ?? "INTERNAL_ERROR"
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    timestamp: new Date().toISOString(),
    database: summarizeDatabaseConfig({
      databaseUrl: config.databaseUrl
    })
  }));

  app.get("/api/overview", async () => {
    const manifest = buildAgentManifest({
      projectName: "ClusterDataAgent",
      currentGoal: "Implement the phase 2 agent execution loop",
      priorities: [
        "agent-core",
        "tool-system",
        "metadata-engine",
        "sql-agent",
        "analysis-service",
        "chart-engine",
        "frontend",
        "security"
      ],
      rules: [
        "small commits",
        "tests first",
        "log everything",
        "handle errors explicitly"
      ]
    });

    return {
      ok: true,
      manifest,
      metadata: metadataCatalog.summary,
      relations: metadataCatalog.relations,
      tools: toolRegistry.list().map((tool) => ({
        name: tool.name,
        description: tool.description
      })),
      toolMetrics: toolRegistry.getMetrics(),
      agent: {
        configured: Boolean(agentExecutor),
        endpoint: config.openAiEndpoint,
        defaultModel: config.openAiModel,
        memoryLimit: config.agentMemoryLimit,
        memoryStore: getSessionStoreMode(config),
        memoryStorePath:
          config.agentMemoryStorePath.trim().length > 0
            ? config.agentMemoryStorePath
            : undefined,
        maxToolCalls: config.agentMaxToolCalls,
        streaming: true
      },
      requestSecurity: requestSecurityPolicy,
      security: authorizeAccess({
        role: "analyst",
        tenantId: "tenant-a",
        resourceTenantId: "tenant-a",
        action: "read"
      })
    };
  });

  app.get("/api/metadata/tables", async () => {
    app.log.info(
      {
        tableCount: metadataCatalog.summary.tableCount,
        loadedAt: metadataCatalog.loadedAt
      },
      "metadata tables listed"
    );

    return {
      ok: true,
      sourcePath: metadataCatalog.sourcePath,
      loadedAt: metadataCatalog.loadedAt,
      summary: metadataCatalog.summary,
      tables: metadataCatalog.tables
    };
  });

  app.get("/api/metadata/tables/:tableName", async (request) => {
    const params = request.params as { tableName?: string };

    if (typeof params.tableName !== "string") {
      throw new AppError("tableName is required", "METADATA_TABLE_NAME_REQUIRED", 400);
    }

    const table = findCatalogTable(metadataCatalog, params.tableName);

    if (!table) {
      throw new AppError(
        `Unknown metadata table: ${params.tableName}`,
        "METADATA_TABLE_NOT_FOUND",
        404,
        {
          tableName: params.tableName
        }
      );
    }

    const relations = filterCatalogRelations(metadataCatalog, table.name);

    app.log.info(
      {
        tableName: table.name,
        columnCount: table.columns.length,
        relationCount: relations.length
      },
      "metadata table returned"
    );

    return {
      ok: true,
      table,
      relations
    };
  });

  app.get("/api/metadata/relations", async (request) => {
    const query = request.query as { tableName?: string };
    const relations =
      typeof query.tableName === "string" && query.tableName.trim().length > 0
        ? filterCatalogRelations(metadataCatalog, query.tableName)
        : metadataCatalog.relations;

    app.log.info(
      {
        tableName: query.tableName,
        relationCount: relations.length
      },
      "metadata relations listed"
    );

    return {
      ok: true,
      relations
    };
  });

  app.get("/api/metadata/search", async (request) => {
    const query = request.query as { q?: string; query?: string; limit?: string | number };
    const searchQuery = query.q ?? query.query;

    if (typeof searchQuery !== "string") {
      throw new AppError("metadata search query is required", "METADATA_SEARCH_QUERY_REQUIRED", 400);
    }

    const limit =
      typeof query.limit === "undefined" ? 10 : Number.parseInt(String(query.limit), 10);

    assertMetadataSearchRequestSecurity(
      {
        query: searchQuery,
        limit
      },
      requestSecurityPolicy
    );

    const results = searchMetadataCatalog(metadataCatalog, searchQuery, limit);

    app.log.info(
      {
        query: searchQuery,
        limit,
        resultCount: results.length
      },
      "metadata search completed"
    );

    return {
      ok: true,
      query: searchQuery,
      results
    };
  });

  app.post("/api/metadata/refresh", async () => {
    metadataCatalog = await refreshConfiguredMetadataCatalog(
      config,
      metadataService,
      logger,
      options.metadataCatalogLoader
    );

    app.log.info(
      {
        sourcePath: metadataCatalog.sourcePath,
        tableCount: metadataCatalog.summary.tableCount,
        relationCount: metadataCatalog.summary.relationCount,
        loadedAt: metadataCatalog.loadedAt
      },
      "metadata catalog refreshed"
    );

    return {
      ok: true,
      sourcePath: metadataCatalog.sourcePath,
      loadedAt: metadataCatalog.loadedAt,
      summary: metadataCatalog.summary,
      relations: metadataCatalog.relations
    };
  });

  app.post("/api/chat", async (request) => {
    const body = request.body as AgentTurnRequest | undefined;
    const executor = getAgentExecutor(agentExecutor);

    if (typeof body?.sessionId !== "string" || typeof body.message !== "string") {
      throw new AppError("sessionId and message are required", "INVALID_CHAT_REQUEST", 400);
    }

    assertChatRequestSecurity(body, requestSecurityPolicy);

    const result = await executor.executeTurn(body);

    return {
      ok: true,
      sessionId: result.sessionId,
      outputText: result.outputText,
      toolCalls: result.toolCalls,
      usage: result.usage
    };
  });

  app.post("/api/chat/stream", async (request, reply) => {
    const body = request.body as AgentTurnRequest | undefined;
    const executor = getAgentExecutor(agentExecutor);

    if (typeof body?.sessionId !== "string" || typeof body.message !== "string") {
      throw new AppError("sessionId and message are required", "INVALID_CHAT_REQUEST", 400);
    }

    assertChatRequestSecurity(body, requestSecurityPolicy);

    applySseCorsHeaders(request, reply);
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.hijack();
    reply.raw.flushHeaders?.();
    let emittedFailureEvent = false;

    try {
      for await (const event of executor.streamTurn(body)) {
        if (event.type === "response.failed") {
          emittedFailureEvent = true;
        }

        reply.raw.write(serializeSseEvent(event.type, event));
      }
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError("Stream execution failed", "STREAM_EXECUTION_FAILED", 500, {
              error: safeErrorMessage(error)
            });

      if (!emittedFailureEvent) {
        reply.raw.write(
          serializeSseEvent("response.failed", {
            type: "response.failed",
            sessionId: body.sessionId,
            error: appError.message,
            code: appError.code
          })
        );
      }
    } finally {
      reply.raw.end();
    }
  });

  app.post("/api/sql/validate", async (request) => {
    const body = request.body as { sql?: string };

    if (typeof body?.sql !== "string") {
      throw new AppError("sql is required", "SQL_REQUIRED", 400);
    }

    assertSqlRequestSecurity(body, requestSecurityPolicy);

    const result = validateSqlStatement(body.sql, {
      tables: metadataCatalog.tables,
      maxLimit: DEFAULT_SQL_LIMIT
    });

    app.log.info(
      {
        allowed: result.allowed,
        referencedTables: result.referencedTables,
        limit: result.limit
      },
      "sql validation completed"
    );

    return result;
  });

  app.post("/api/sql/query", async (request) => {
    const body = request.body as { sql?: string };

    if (typeof body?.sql !== "string") {
      throw new AppError("sql is required", "SQL_REQUIRED", 400);
    }

    assertSqlRequestSecurity(body, requestSecurityPolicy);

    const result = await executeValidatedSqlQuery(
      body.sql,
      metadataCatalog,
      getReadOnlyQueryExecutor(queryExecutor)
    );

    app.log.info(
      {
        rowCount: result.rowCount,
        columnCount: result.columns.length,
        durationMs: result.durationMs
      },
      "sql query executed"
    );

    return result;
  });

  app.post("/api/sql/limit", async (request) => {
    const body = request.body as { limit?: number };

    if (typeof body?.limit !== "number") {
      throw new AppError("limit is required", "LIMIT_REQUIRED", 400);
    }

    return {
      clause: buildSafeLimitClause(body.limit)
    };
  });

  app.post("/api/sql/suggest", async (request) => {
    const body = request.body as {
      tableName?: string;
      columns?: readonly string[];
      limit?: number;
    };

    if (typeof body?.tableName !== "string") {
      throw new AppError("tableName is required", "TABLE_NAME_REQUIRED", 400);
    }

    assertSqlSuggestionRequestSecurity(body, requestSecurityPolicy);

    const sql = buildSqlAwareSelectQuery(
      {
        tableName: body.tableName,
        columns: body.columns,
        limit: body.limit
      },
      {
        tables: metadataCatalog.tables,
        maxLimit: DEFAULT_SQL_LIMIT
      }
    );

    app.log.info(
      {
        tableName: body.tableName,
        columnCount: body.columns?.length ?? 0,
        limit: body.limit
      },
      "sql suggestion generated"
    );

    return { sql };
  });

  app.post("/api/analysis/series", async (request) => {
    const body = request.body as { points?: readonly number[] };

    if (!Array.isArray(body?.points)) {
      throw new AppError("points are required", "POINTS_REQUIRED", 400);
    }

    assertSeriesRequestSecurity(body, requestSecurityPolicy);

    return {
      summary: summarizeSeries(body.points)
    };
  });

  app.post("/api/analysis/time-series", async (request) => {
    const body = request.body as {
      points?: readonly TimeSeriesPoint[];
      movingAverageWindow?: number;
      anomalyThreshold?: number;
    };

    if (!Array.isArray(body?.points)) {
      throw new AppError("points are required", "POINTS_REQUIRED", 400);
    }

    assertTimeSeriesRequestSecurity(body, requestSecurityPolicy);

    const analysis = analyzeTimeSeries({
      points: body.points,
      movingAverageWindow: body.movingAverageWindow,
      anomalyThreshold: body.anomalyThreshold
    });

    app.log.info(
      {
        pointCount: analysis.pointCount,
        anomalyCount: analysis.anomalies.length,
        movingAverageWindow: analysis.movingAverageWindow,
        intervalUnit: analysis.interval.unit
      },
      "time series analysis generated"
    );

    return {
      analysis
    };
  });

  app.post("/api/analysis/profile", async (request) => {
    const body = request.body as {
      rows?: readonly DatasetRow[];
      maxCategoryValues?: number;
      outlierThreshold?: number;
    };

    if (!Array.isArray(body?.rows)) {
      throw new AppError("rows are required", "ROWS_REQUIRED", 400);
    }

    assertDatasetProfileRequestSecurity(body, requestSecurityPolicy);

    const profile = profileDataset({
      rows: body.rows,
      maxCategoryValues: body.maxCategoryValues,
      outlierThreshold: body.outlierThreshold
    });

    app.log.info(
      {
        rowCount: profile.rowCount,
        fieldCount: profile.fieldCount,
        warningCount: profile.quality.warnings.length
      },
      "dataset profile generated"
    );

    return {
      profile
    };
  });

  app.post("/api/charts/suggest", async (request) => {
    const body = request.body as {
      title?: string;
      labels?: readonly string[];
      values?: readonly number[];
      hasTimeAxis?: boolean;
      profile?: ReturnType<typeof profileDataset>;
      maxRecommendations?: number;
    };

    assertChartRequestSecurity(body, requestSecurityPolicy);

    if (body?.profile) {
      const recommendations = recommendChartsFromProfile({
        profile: body.profile,
        maxRecommendations: body.maxRecommendations
      });

      app.log.info(
        {
          recommendationCount: recommendations.length,
          profileFieldCount: body.profile.fieldCount
        },
        "profile-aware chart recommendations generated"
      );

      return {
        recommendations
      };
    }

    if (
      typeof body?.title !== "string" ||
      !Array.isArray(body.labels) ||
      !Array.isArray(body.values) ||
      typeof body.hasTimeAxis !== "boolean"
    ) {
      throw new AppError("Invalid chart request", "INVALID_CHART_REQUEST", 400);
    }

    const kind = chooseChartKind({
      dimensions: body.labels.length > 0 ? ["category"] : [],
      metrics: ["value"],
      hasTimeAxis: body.hasTimeAxis
    });

    return {
      kind,
      option: buildEChartsOption(body.title, body.labels, body.values, kind)
    };
  });

  app.post("/api/security/check", async (request) => {
    const body = request.body as {
      role?: "admin" | "analyst" | "viewer";
      tenantId?: string;
      resourceTenantId?: string;
      action?: "read" | "write" | "delete";
    };

    if (
      typeof body?.role !== "string" ||
      typeof body.tenantId !== "string" ||
      typeof body.resourceTenantId !== "string" ||
      typeof body.action !== "string"
    ) {
      throw new AppError("Invalid security request", "INVALID_SECURITY_REQUEST", 400);
    }

    assertAccessRequestInput(body, requestSecurityPolicy);

    return {
      decision: authorizeAccess({
        role: body.role,
        tenantId: body.tenantId,
        resourceTenantId: body.resourceTenantId,
        action: body.action
      })
    };
  });

  app.log.info(
    {
      host: config.host,
      port: config.port
    },
    "api configured"
  );
  logger.info("API app constructed", { host: config.host, port: config.port });

  return app;
}

function buildToolRegistry(
  getMetadataCatalog: () => PrismaSchemaCatalog,
  queryExecutor?: ReadOnlyQueryExecutor,
  options: ToolRegistryOptions = {}
): ToolRegistry {
  const toolRegistry = new ToolRegistry(options);

  toolRegistry.register({
    name: "validate-sql",
    description: "Validate a SQL statement for safe execution",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" }
      },
      required: ["sql"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: { sql: string }) =>
      validateSqlStatement(input.sql, {
        tables: getMetadataCatalog().tables,
        maxLimit: DEFAULT_SQL_LIMIT
      })
  });

  toolRegistry.register({
    name: "generate-sql",
    description: "Generate a metadata-aware safe select statement",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        columns: {
          type: "array",
          items: { type: "string" }
        },
        limit: { type: "integer" }
      },
      required: ["tableName"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      tableName: string;
      columns?: readonly string[];
      limit?: number;
    }) =>
      buildSqlAwareSelectQuery(
        {
          tableName: input.tableName,
          columns: input.columns,
          limit: input.limit
        },
        {
          tables: getMetadataCatalog().tables,
          maxLimit: DEFAULT_SQL_LIMIT
        }
      )
  });

  if (queryExecutor) {
    toolRegistry.register({
      name: "query-sql",
      description: "Execute a validated read-only SQL statement and return rows",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"],
        additionalProperties: false
      },
      execution: {
        timeoutMs: 15_000,
        retries: 0
      },
      execute: async (input: { sql: string }) =>
        await executeValidatedSqlQuery(input.sql, getMetadataCatalog(), queryExecutor)
    });
  }

  toolRegistry.register({
    name: "summarize-series",
    description: "Summarize a numeric series",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: { type: "number" }
        }
      },
      required: ["points"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: { points: readonly number[] }) => summarizeSeries(input.points)
  });

  toolRegistry.register({
    name: "profile-dataset",
    description: "Profile tabular JSON rows for BI field statistics and quality warnings",
    inputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true
          }
        },
        maxCategoryValues: { type: "integer" },
        outlierThreshold: { type: "number" }
      },
      required: ["rows"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      rows: readonly DatasetRow[];
      maxCategoryValues?: number;
      outlierThreshold?: number;
    }) =>
      profileDataset({
        rows: input.rows,
        maxCategoryValues: input.maxCategoryValues,
        outlierThreshold: input.outlierThreshold
      })
  });

  toolRegistry.register({
    name: "analyze-time-series",
    description: "Analyze time series points for trend, cadence, moving average, and anomalies",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              value: { type: "number" }
            },
            required: ["timestamp", "value"],
            additionalProperties: false
          }
        },
        movingAverageWindow: { type: "integer" },
        anomalyThreshold: { type: "number" }
      },
      required: ["points"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      points: readonly TimeSeriesPoint[];
      movingAverageWindow?: number;
      anomalyThreshold?: number;
    }) =>
      analyzeTimeSeries({
        points: input.points,
        movingAverageWindow: input.movingAverageWindow,
        anomalyThreshold: input.anomalyThreshold
      })
  });

  toolRegistry.register({
    name: "suggest-chart",
    description: "Suggest a chart type and build chart option metadata",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" }
        },
        values: {
          type: "array",
          items: { type: "number" }
        },
        hasTimeAxis: { type: "boolean" }
      },
      required: ["title", "labels", "values", "hasTimeAxis"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      title: string;
      labels: readonly string[];
      values: readonly number[];
      hasTimeAxis: boolean;
    }) => {
      const kind = chooseChartKind({
        dimensions: input.labels.length > 0 ? ["category"] : [],
        metrics: ["value"],
        hasTimeAxis: input.hasTimeAxis
      });

      return {
        kind,
        option: buildEChartsOption(input.title, input.labels, input.values, kind)
      };
    }
  });

  toolRegistry.register({
    name: "recommend-charts",
    description: "Recommend charts from a dataset profile",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          additionalProperties: true
        },
        maxRecommendations: { type: "integer" }
      },
      required: ["profile"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      profile: ReturnType<typeof profileDataset>;
      maxRecommendations?: number;
    }) =>
      recommendChartsFromProfile({
        profile: input.profile,
        maxRecommendations: input.maxRecommendations
      })
  });

  toolRegistry.register({
    name: "check-access",
    description: "Check whether an action is permitted for a tenant-scoped user",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["admin", "analyst", "viewer"]
        },
        tenantId: { type: "string" },
        resourceTenantId: { type: "string" },
        action: {
          type: "string",
          enum: ["read", "write", "delete"]
        }
      },
      required: ["role", "tenantId", "resourceTenantId", "action"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: {
      role: "admin" | "analyst" | "viewer";
      tenantId: string;
      resourceTenantId: string;
      action: "read" | "write" | "delete";
    }) => authorizeAccess(input)
  });

  return toolRegistry;
}

function createQueryExecutor(
  config: ApiConfig,
  logger: ReturnType<typeof createLogger>
): ReadOnlyQueryExecutor | undefined {
  if (config.databaseUrl.trim().length === 0) {
    return undefined;
  }

  logger.info("using postgres read-only query executor", {
    host: config.host
  });

  return new PostgresReadOnlyQueryExecutor({
    databaseUrl: config.databaseUrl,
    logger
  });
}

function createSessionStore(
  config: ApiConfig,
  logger: ReturnType<typeof createLogger>
): SessionStore {
  if (getSessionStoreMode(config) === "file") {
    logger.info("using file-backed agent session store", {
      filePath: config.agentMemoryStorePath,
      memoryLimit: config.agentMemoryLimit
    });

    return new FileSessionStore({
      filePath: config.agentMemoryStorePath,
      maxMessages: config.agentMemoryLimit,
      logger
    });
  }

  logger.info("using in-memory agent session store", {
    memoryLimit: config.agentMemoryLimit
  });

  return new InMemorySessionStore(config.agentMemoryLimit);
}

function getSessionStoreMode(config: ApiConfig): "memory" | "file" {
  return config.agentMemoryStorePath.trim().length > 0 ? "file" : "memory";
}

function getReadOnlyQueryExecutor(
  queryExecutor?: ReadOnlyQueryExecutor
): ReadOnlyQueryExecutor {
  if (!queryExecutor) {
    throw new AppError(
      "Database query execution is not configured. Set DATABASE_URL to enable SQL query execution.",
      "DATABASE_QUERY_NOT_CONFIGURED",
      503
    );
  }

  return queryExecutor;
}

async function executeValidatedSqlQuery(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  queryExecutor: ReadOnlyQueryExecutor
): Promise<{
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly durationMs: number;
  readonly validation: ReturnType<typeof validateSqlStatement>;
}> {
  const validation = validateSqlStatement(sql, {
    tables: metadataCatalog.tables,
    maxLimit: DEFAULT_SQL_LIMIT
  });

  if (!validation.allowed) {
    throw new AppError(validation.reason ?? "SQL is not allowed", "SQL_NOT_ALLOWED", 400, {
      validation
    });
  }

  const result = await queryExecutor.executeReadOnlyQuery(validation.normalizedSql);

  return {
    ...result,
    validation
  };
}

async function loadConfiguredMetadataCatalog(
  config: ApiConfig,
  metadataService: PrismaMetadataCatalogService,
  logger: ReturnType<typeof createLogger>,
  metadataCatalogLoader?: (config: ApiConfig) => Promise<PrismaSchemaCatalog>
): Promise<PrismaSchemaCatalog> {
  if (metadataCatalogLoader) {
    return await metadataCatalogLoader(config);
  }

  if (config.metadataSource === "postgres") {
    return await loadPostgresSchemaCatalog({
      databaseUrl: config.databaseUrl,
      schemaName: config.postgresSchema,
      logger
    });
  }

  return await metadataService.getCatalog();
}

async function refreshConfiguredMetadataCatalog(
  config: ApiConfig,
  metadataService: PrismaMetadataCatalogService,
  logger: ReturnType<typeof createLogger>,
  metadataCatalogLoader?: (config: ApiConfig) => Promise<PrismaSchemaCatalog>
): Promise<PrismaSchemaCatalog> {
  if (metadataCatalogLoader) {
    return await metadataCatalogLoader(config);
  }

  if (config.metadataSource === "postgres") {
    return await loadPostgresSchemaCatalog({
      databaseUrl: config.databaseUrl,
      schemaName: config.postgresSchema,
      logger
    });
  }

  return await metadataService.refresh();
}

function getAgentExecutor(agentExecutor?: AgentExecutor): AgentExecutor {
  if (!agentExecutor) {
    throw new AppError(
      "Agent is not configured. Set OPENAI_API_KEY to enable chat endpoints.",
      "AGENT_NOT_CONFIGURED",
      503
    );
  }

  return agentExecutor;
}

function serializeSseEvent(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function applySseCorsHeaders(
  request: {
    headers: {
      origin?: string;
    };
  },
  reply: {
    raw: {
      setHeader(name: string, value: string): void;
    };
  }
): void {
  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  reply.raw.setHeader("Access-Control-Allow-Origin", origin);
  reply.raw.setHeader("Vary", "Origin");
}

function findCatalogTable(
  catalog: PrismaSchemaCatalog,
  tableName: string
): PrismaSchemaCatalog["tables"][number] | undefined {
  const normalized = normalizeMetadataName(tableName);

  return catalog.tables.find((table) => normalizeMetadataName(table.name) === normalized);
}

function filterCatalogRelations(
  catalog: PrismaSchemaCatalog,
  tableName: string
): PrismaSchemaCatalog["relations"] {
  const normalized = normalizeMetadataName(tableName);

  return catalog.relations.filter(
    (relation) =>
      normalizeMetadataName(relation.fromTable) === normalized ||
      normalizeMetadataName(relation.toTable) === normalized
  );
}

function normalizeMetadataName(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

