import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import {
  AgentExecutor,
  FileSessionStore,
  InMemorySessionStore,
  buildAgentManifest,
  type AgentEvaluationCase,
  type AgentEvaluationSuiteResult,
  type AgentTurnRequest,
  type SessionStore
} from "@clusterdata/agent-core";
import {
  analyzeTimeSeries,
  generateDatasetInsights,
  profileDataset,
  summarizeSeries,
  type DatasetRow,
  type TimeSeriesPoint
} from "@clusterdata/analysis-service";
import {
  buildEChartsOption,
  chooseChartKind,
  recommendChartsFromProfile,
  type ChartTheme
} from "@clusterdata/chart-engine";
import {
  buildQueryResultCacheKey,
  InMemoryAsyncQueryJobManager,
  InMemoryQueryResultCache,
  paginateReadOnlyQueryResult,
  PostgresReadOnlyQueryExecutor,
  summarizeDatabaseConfig,
  type ReadOnlyQueryExecutor
} from "@clusterdata/database";
import {
  buildSemanticCatalogFromMetadata,
  buildMetadataCatalogInsights,
  InMemoryMetadataCache,
  InMemorySemanticCatalogCache,
  PrismaMetadataCatalogService,
  SemanticCatalogService,
  buildSemanticCatalogInsights,
  buildSemanticMetricQuery,
  loadPostgresSchemaCatalog,
  searchMetadataCatalog,
  searchSemanticCatalog,
  type PrismaSchemaCatalog,
  type SemanticCatalog,
  type SemanticMetricFilterDefinition,
  type SemanticMetricQueryRequest,
  type SemanticTimeGrain
} from "@clusterdata/metadata-engine";
import {
  assertAccessRequestInput,
  assertChartRequestSecurity,
  assertChatRequestSecurity,
  assertDatasetProfileRequestSecurity,
  assertMetadataSearchRequestSecurity,
  assertSessionIdInput,
  assertSessionMetadataInput,
  assertSqlReadAccess,
  assertSqlRoleRequestInput,
  assertSeriesRequestSecurity,
  assertSqlRequestSecurity,
  assertSqlSuggestionRequestSecurity,
  assertTimeSeriesRequestSecurity,
  authorizeAccess,
  authorizeSqlReadAccess,
  buildRequestSecurityPolicy,
  writeSecurityAuditEvent,
  type SecurityAuditStatus,
  type SqlReadAccessPolicy,
  type UserRole
} from "@clusterdata/security";
import {
  buildErrorResponse,
  createLogger,
  safeErrorMessage,
  AppError
} from "@clusterdata/shared";
import {
  buildMetadataAwareSelectQuery as buildSqlAwareSelectQuery,
  buildSafeLimitClause,
  collectSqlReadTargets,
  validateSqlStatement
} from "@clusterdata/sql-agent";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistryOptions
} from "@clusterdata/tool-system";
import { loadApiConfig, type ApiConfig } from "./config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(moduleDir, "../../../packages/database/prisma/schema.prisma");
const defaultSemanticCatalogPath = resolve(
  moduleDir,
  "../../../packages/database/semantic/catalog.json"
);
const DEFAULT_SQL_LIMIT = 500;
const DEFAULT_SEMANTIC_QUERY_LIMIT = 500;

type SqlStatementValidation = ReturnType<typeof validateSqlStatement>;

interface ValidatedSqlQueryExecutionResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly durationMs: number;
  readonly validation: SqlStatementValidation;
}

interface SqlQueryCacheMetadata {
  readonly key: string;
  readonly hit: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface SqlQueryExecutionPayload {
  readonly result: ValidatedSqlQueryExecutionResult;
  readonly cache: SqlQueryCacheMetadata;
}

interface SqlQueryPageRequest {
  readonly offset: number;
  readonly pageLimit?: number;
}

interface SqlAsyncQueryJobSummary {
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

export interface BuildApiOptions {
  readonly agentExecutor?: AgentExecutor;
  readonly analysisAgentEvaluationCases?: readonly AgentEvaluationCase[];
  readonly queryExecutor?: ReadOnlyQueryExecutor;
  readonly sessionStore?: SessionStore;
  readonly toolRegistry?: ToolRegistry;
  readonly metadataCatalog?: PrismaSchemaCatalog;
  readonly metadataService?: PrismaMetadataCatalogService;
  readonly metadataCatalogLoader?: (config: ApiConfig) => Promise<PrismaSchemaCatalog>;
  readonly semanticCatalog?: SemanticCatalog;
  readonly semanticService?: SemanticCatalogService;
  readonly semanticCatalogLoader?: (
    config: ApiConfig,
    metadataCatalog: PrismaSchemaCatalog
  ) => Promise<SemanticCatalog>;
}

interface RuntimeRouteCount {
  readonly route: string;
  readonly requests: number;
}

interface RuntimePublicSnapshot {
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly activeRequests: number;
  readonly activeChatStreams: number;
  readonly totalRequests: number;
  readonly rateLimitedRequests: number;
  readonly lastMetadataRefreshAt: string;
}

interface RuntimeOperatorSnapshot extends RuntimePublicSnapshot {
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
  readonly routes: readonly RuntimeRouteCount[];
}

class RuntimeTelemetry {
  private readonly startedAt = new Date().toISOString();
  private readonly startedAtMs = Date.now();
  private activeRequests = 0;
  private activeChatStreams = 0;
  private totalRequests = 0;
  private successRequests = 0;
  private clientErrorRequests = 0;
  private serverErrorRequests = 0;
  private totalChatStreams = 0;
  private completedChatStreams = 0;
  private abortedChatStreams = 0;
  private failedChatStreams = 0;
  private rateLimitedRequests = 0;
  private lastMetadataRefreshAt: string;
  private readonly routeCounts = new Map<string, number>();

  public constructor(initialMetadataLoadedAt: string) {
    this.lastMetadataRefreshAt = initialMetadataLoadedAt;
  }

  public onRequest(route: string): void {
    this.activeRequests += 1;
    this.totalRequests += 1;
    this.routeCounts.set(route, (this.routeCounts.get(route) ?? 0) + 1);
  }

  public onResponse(statusCode: number): void {
    this.activeRequests = Math.max(this.activeRequests - 1, 0);

    if (statusCode >= 500) {
      this.serverErrorRequests += 1;
      return;
    }

    if (statusCode >= 400) {
      this.clientErrorRequests += 1;
      return;
    }

    this.successRequests += 1;
  }

  public onChatStreamStarted(): void {
    this.activeChatStreams += 1;
    this.totalChatStreams += 1;
  }

  public onChatStreamCompleted(): void {
    this.activeChatStreams = Math.max(this.activeChatStreams - 1, 0);
    this.completedChatStreams += 1;
  }

  public onChatStreamAborted(): void {
    this.activeChatStreams = Math.max(this.activeChatStreams - 1, 0);
    this.abortedChatStreams += 1;
  }

  public onChatStreamFailed(): void {
    this.activeChatStreams = Math.max(this.activeChatStreams - 1, 0);
    this.failedChatStreams += 1;
  }

  public onRateLimited(): void {
    this.rateLimitedRequests += 1;
  }

  public setLastMetadataRefreshAt(value: string): void {
    this.lastMetadataRefreshAt = value;
  }

  public getPublicSnapshot(): RuntimePublicSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAtMs,
      activeRequests: this.activeRequests,
      activeChatStreams: this.activeChatStreams,
      totalRequests: this.totalRequests,
      rateLimitedRequests: this.rateLimitedRequests,
      lastMetadataRefreshAt: this.lastMetadataRefreshAt
    };
  }

  public getOperatorSnapshot(): RuntimeOperatorSnapshot {
    return {
      ...this.getPublicSnapshot(),
      statusCounts: {
        success: this.successRequests,
        clientError: this.clientErrorRequests,
        serverError: this.serverErrorRequests
      },
      chatStreams: {
        started: this.totalChatStreams,
        completed: this.completedChatStreams,
        aborted: this.abortedChatStreams,
        failed: this.failedChatStreams
      },
      routes: Array.from(this.routeCounts.entries())
        .map(([route, requests]) => ({ route, requests }))
        .sort((left, right) => right.requests - left.requests || left.route.localeCompare(right.route))
    };
  }
}

class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  public take(
    key: string,
    policy: {
      readonly limit: number;
      readonly windowMs: number;
    }
  ): {
    readonly allowed: boolean;
    readonly remaining: number;
    readonly retryAfterMs: number;
  } {
    const now = Date.now();
    const current = this.buckets.get(key);

    if (!current || current.resetAtMs <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAtMs: now + policy.windowMs
      });

      return {
        allowed: true,
        remaining: Math.max(policy.limit - 1, 0),
        retryAfterMs: policy.windowMs
      };
    }

    if (current.count >= policy.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(current.resetAtMs - now, 0)
      };
    }

    current.count += 1;

    return {
      allowed: true,
      remaining: Math.max(policy.limit - current.count, 0),
      retryAfterMs: Math.max(current.resetAtMs - now, 0)
    };
  }
}

export async function buildApi(options: BuildApiOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-operator-api-key"]'
      ]
    }
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
  const shouldUseGeneratedSemanticCatalog =
    !options.semanticCatalog &&
    !options.semanticService &&
    !options.semanticCatalogLoader &&
    config.semanticCatalogPath.trim().length === 0 &&
    (Boolean(options.metadataCatalog) ||
      Boolean(options.metadataService) ||
      Boolean(options.metadataCatalogLoader));
  const semanticService =
    options.semanticService ??
    new SemanticCatalogService({
      sourcePath: resolveSemanticCatalogPath(config),
      getMetadataCatalog: () => metadataCatalog,
      cache: new InMemorySemanticCatalogCache(),
      initialCatalog: options.semanticCatalog,
      logger
    });
  let semanticCatalog =
    options.semanticCatalog ??
    (shouldUseGeneratedSemanticCatalog
      ? buildSemanticCatalogFromMetadata(metadataCatalog, {
          sourcePath: `generated://${metadataCatalog.sourcePath}`,
          loadedAt: metadataCatalog.loadedAt
        })
      : await loadConfiguredSemanticCatalog(
          config,
          metadataCatalog,
          semanticService,
          logger,
          options.semanticCatalogLoader
        ));
  const queryExecutor = options.queryExecutor ?? createQueryExecutor(config, logger);
  const sqlQueryResultCache = new InMemoryQueryResultCache<SqlQueryExecutionPayload>({
    ttlMs: config.sqlQueryExecution.cacheTtlMs,
    maxEntries: config.sqlQueryExecution.cacheMaxEntries,
    logger
  });
  const sqlAsyncQueryJobs = new InMemoryAsyncQueryJobManager<SqlQueryExecutionPayload>({
    ttlMs: config.sqlQueryExecution.asyncJobTtlMs,
    maxEntries: config.sqlQueryExecution.asyncJobMaxEntries,
    logger
  });
  const runtimeTelemetry = new RuntimeTelemetry(metadataCatalog.loadedAt);
  const rateLimiter = new InMemoryRateLimiter();
  const toolRegistry =
    options.toolRegistry ??
    buildToolRegistry(
      () => metadataCatalog,
      queryExecutor,
      {
        governance: {
          allowedTools: config.agentAllowedTools,
          blockedTools: config.agentBlockedTools
        }
      },
      {
        sqlAccessPolicy: config.sqlAccess,
        sqlRole: config.sqlAccess.defaultRole
      },
      () => semanticCatalog
    );
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
            maxRetries: 1,
            maxToolResultChars: config.agentMaxToolResultChars
          },
          logger
        })
      : undefined);
  const defaultAnalysisAgentEvaluationCases =
    options.analysisAgentEvaluationCases ??
    buildDefaultAnalysisAgentEvaluationCases(toolRegistry.list().map((tool) => tool.name));
  let latestAnalysisAgentEvaluation: AgentEvaluationSuiteResult | undefined;

  logger.info("metadata catalog loaded", {
    sourcePath: metadataCatalog.sourcePath,
    tableCount: metadataCatalog.summary.tableCount,
    relationCount: metadataCatalog.summary.relationCount
  });
  logger.info("semantic catalog loaded", {
    sourcePath: semanticCatalog.sourcePath,
    modelCount: semanticCatalog.summary.modelCount,
    metricCount: semanticCatalog.summary.metricCount,
    dimensionCount: semanticCatalog.summary.dimensionCount
  });

  app.addHook("onRequest", async (request) => {
    runtimeTelemetry.onRequest(request.routeOptions?.url ?? request.url);
  });

  app.addHook("onResponse", async (_request, reply) => {
    runtimeTelemetry.onResponse(reply.statusCode);
  });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, _request, reply) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(safeErrorMessage(error), "INTERNAL_ERROR", 500);
    const statusCode = appError.statusCode;

    app.log.error(
      {
        err: error,
        code: appError.code
      },
      "request failed"
    );

    if (
      appError.statusCode === 429 &&
      typeof appError.details?.retryAfterMs === "number"
    ) {
      reply.header("retry-after", Math.max(1, Math.ceil(appError.details.retryAfterMs / 1000)));
    }

    reply.status(statusCode).send(buildErrorResponse(appError, _request.id));
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    timestamp: new Date().toISOString(),
    database: summarizeDatabaseConfig({
      databaseUrl: config.databaseUrl
    })
  }));

  app.get("/health/ready", async () => ({
    ok: true,
    ready: true,
    checks: {
      metadataLoaded: true,
      semanticLoaded: true,
      sessionStoreReady: true,
      toolsRegistered: toolRegistry.list().length > 0,
      chatConfigured: Boolean(agentExecutor),
      databaseQueryConfigured: Boolean(queryExecutor)
    },
    runtime: runtimeTelemetry.getPublicSnapshot()
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
      semantic: semanticCatalog.summary,
      tools: toolRegistry.list().map((tool) => ({
        name: tool.name,
        description: tool.description
      })),
      toolMetrics: toolRegistry.getMetrics(),
      toolGovernance: {
        ...toolRegistry.getGovernanceSummary(),
        maxToolResultChars: config.agentMaxToolResultChars
      },
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
        sessionCount: sessionStore.list().length,
        maxToolCalls: config.agentMaxToolCalls,
        streaming: true
      },
      runtime: runtimeTelemetry.getPublicSnapshot(),
      requestSecurity: requestSecurityPolicy,
      sqlAccess: {
        defaultRole: config.sqlAccess.defaultRole,
        roles: config.sqlAccess.roles
      },
      security: authorizeAccess({
        role: "analyst",
        tenantId: "tenant-a",
        resourceTenantId: "tenant-a",
        action: "read"
      })
    };
  });

  app.get("/api/agent/sessions", async (request) =>
    await runAuditedRequest(
      request,
      "agent.sessions.list",
      undefined,
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);
        const sessions = sessionStore.list();

        app.log.info(
          {
            sessionCount: sessions.length
          },
          "agent sessions listed"
        );

        return {
          ok: true,
          sessions
        };
      },
      (result) => ({
        sessionCount: result.sessions.length
      })
    )
  );

  app.get("/api/agent/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId?: string };
    const sessionId =
      typeof params.sessionId === "string" && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "agent.sessions.get",
      {
        sessionId
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);

        if (!sessionId) {
          throw new AppError("sessionId is required", "AGENT_SESSION_ID_REQUIRED", 400);
        }

        assertSessionIdInput(sessionId, requestSecurityPolicy);

        const session = sessionStore.read(sessionId);

        if (!session || session.messages.length === 0) {
          throw new AppError(
            `Unknown agent session: ${sessionId}`,
            "AGENT_SESSION_NOT_FOUND",
            404,
            {
              sessionId
            }
          );
        }

        app.log.info(
          {
            sessionId,
            messageCount: session.messages.length
          },
          "agent session returned"
        );

        return {
          ok: true,
          session
        };
      },
      (result) => ({
        messageCount: result.session.messages.length,
        updatedAt: result.session.updatedAt
      })
    );
  });

  app.patch("/api/agent/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId?: string };
    const body = request.body as {
      title?: string | null;
      tags?: readonly string[] | null;
    };
    const sessionId =
      typeof params.sessionId === "string" && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "agent.sessions.update",
      {
        sessionId
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);

        if (!sessionId) {
          throw new AppError("sessionId is required", "AGENT_SESSION_ID_REQUIRED", 400);
        }

        assertSessionIdInput(sessionId, requestSecurityPolicy);
        assertSessionMetadataInput(body, requestSecurityPolicy);

        const session = sessionStore.updateMetadata(sessionId, {
          title: body?.title,
          tags: body?.tags
        });

        if (!session || session.messages.length === 0) {
          throw new AppError(
            `Unknown agent session: ${sessionId}`,
            "AGENT_SESSION_NOT_FOUND",
            404,
            {
              sessionId
            }
          );
        }

        app.log.info(
          {
            sessionId,
            title: session.title,
            tagCount: session.tags?.length ?? 0
          },
          "agent session metadata updated"
        );

        return {
          ok: true,
          session
        };
      },
      (result) => ({
        title: result.session.title,
        tagCount: result.session.tags?.length ?? 0
      })
    );
  });

  app.post("/api/agent/sessions/:sessionId/fork", async (request) => {
    const params = request.params as { sessionId?: string };
    const body = request.body as {
      sessionId?: string;
      title?: string | null;
      tags?: readonly string[] | null;
    };
    const sessionId =
      typeof params.sessionId === "string" && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "agent.sessions.fork",
      {
        sessionId
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);

        if (!sessionId) {
          throw new AppError("sessionId is required", "AGENT_SESSION_ID_REQUIRED", 400);
        }

        assertSessionIdInput(sessionId, requestSecurityPolicy);
        assertSessionMetadataInput(body, requestSecurityPolicy);

        const forkSessionId =
          typeof body?.sessionId === "string" && body.sessionId.trim().length > 0
            ? body.sessionId.trim()
            : `fork-${randomUUID()}`;

        assertSessionIdInput(forkSessionId, requestSecurityPolicy);

        const session = sessionStore.fork(sessionId, forkSessionId, {
          title: body?.title,
          tags: body?.tags
        });

        app.log.info(
          {
            sessionId,
            forkSessionId,
            messageCount: session.messageCount
          },
          "agent session forked"
        );

        return {
          ok: true,
          sourceSessionId: sessionId,
          session
        };
      },
      (result) => ({
        forkSessionId: result.session.sessionId,
        messageCount: result.session.messageCount
      })
    );
  });

  app.delete("/api/agent/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId?: string };
    const sessionId =
      typeof params.sessionId === "string" && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "agent.sessions.delete",
      {
        sessionId
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);

        if (!sessionId) {
          throw new AppError("sessionId is required", "AGENT_SESSION_ID_REQUIRED", 400);
        }

        assertSessionIdInput(sessionId, requestSecurityPolicy);

        const deleted = sessionStore.delete(sessionId);

        app.log.info(
          {
            sessionId,
            deleted
          },
          "agent session deleted"
        );

        return {
          ok: true,
          sessionId,
          deleted
        };
      },
      (result) => ({
        deleted: result.deleted
      })
    );
  });

  app.delete("/api/agent/sessions", async (request) =>
    await runAuditedRequest(
      request,
      "agent.sessions.clear",
      undefined,
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator session requests"
        );
        assertOperatorRequestAuthorized(request, config);
        const deletedCount = sessionStore.clear();

        app.log.info(
          {
            deletedCount
          },
          "agent sessions cleared"
        );

        return {
          ok: true,
          deletedCount
        };
      },
      (result) => ({
        deletedCount: result.deletedCount
      })
    )
  );

  app.get("/api/ops/runtime", async (request) =>
    await runAuditedRequest(
      request,
      "ops.runtime.get",
      undefined,
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator requests"
        );
        assertOperatorRequestAuthorized(request, config);

        const runtime = runtimeTelemetry.getOperatorSnapshot();

        app.log.info(
          {
            uptimeMs: runtime.uptimeMs,
            activeRequests: runtime.activeRequests,
            activeChatStreams: runtime.activeChatStreams
          },
          "ops runtime returned"
        );

        return {
          ok: true,
          runtime,
          sessionCount: sessionStore.list().length,
          toolCount: toolRegistry.list().length,
          toolMetrics: toolRegistry.getMetrics()
        };
      },
      (result) => ({
        uptimeMs: result.runtime.uptimeMs,
        activeRequests: result.runtime.activeRequests
      })
    )
  );

  app.get("/api/ops/analysis-agent", async (request) =>
    await runAuditedRequest(
      request,
      "ops.analysis-agent.get",
      undefined,
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator requests"
        );
        assertOperatorRequestAuthorized(request, config);

        const executor = getAgentExecutor(agentExecutor);
        const observability = executor.getObservabilitySnapshot();

        app.log.info(
          {
            totalTurns: observability.summary.totalTurns,
            activeTurnCount: observability.summary.activeTurnCount,
            retainedTurnCount: observability.summary.retainedTurnCount,
            hasLatestEvaluation: Boolean(latestAnalysisAgentEvaluation)
          },
          "analysis agent observability returned"
        );

        return {
          ok: true,
          observability,
          latestEvaluation: latestAnalysisAgentEvaluation
        };
      },
      (result) => ({
        totalTurns: result.observability.summary.totalTurns,
        hasLatestEvaluation: Boolean(result.latestEvaluation)
      })
    )
  );

  app.post("/api/ops/analysis-agent/evals", async (request) =>
    await runAuditedRequest(
      request,
      "ops.analysis-agent.eval",
      undefined,
      async () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "operator",
          config.rateLimit.maxOperatorRequests,
          config.rateLimit.windowMs,
          "OPERATOR_RATE_LIMITED",
          "Too many operator requests"
        );
        assertOperatorRequestAuthorized(request, config);

        const executor = getAgentExecutor(agentExecutor);
        const evaluationRequest = parseAnalysisAgentEvaluationRequest(
          request.body,
          requestSecurityPolicy,
          defaultAnalysisAgentEvaluationCases
        );

        latestAnalysisAgentEvaluation = await executor.runEvaluationSuite(evaluationRequest);

        app.log.info(
          {
            runId: latestAnalysisAgentEvaluation.runId,
            totalCases: latestAnalysisAgentEvaluation.totalCases,
            passedCases: latestAnalysisAgentEvaluation.passedCases,
            failedCases: latestAnalysisAgentEvaluation.failedCases
          },
          "analysis agent evaluation completed"
        );

        return {
          ok: true,
          evaluation: latestAnalysisAgentEvaluation,
          observability: executor.getObservabilitySnapshot()
        };
      },
      (result) => ({
        runId: result.evaluation.runId,
        totalCases: result.evaluation.totalCases,
        failedCases: result.evaluation.failedCases
      })
    )
  );

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

  app.get("/api/metadata/insights", async (request) => {
    const query = request.query as {
      limit?: string | number;
    };
    const parsedLimit =
      typeof query.limit === "number"
        ? query.limit
        : typeof query.limit === "string" && query.limit.trim().length > 0
          ? Number.parseInt(query.limit, 10)
          : undefined;
    const insights = buildMetadataCatalogInsights(metadataCatalog, {
      tableLimit: parsedLimit
    });

    app.log.info(
      {
        tableCount: insights.tables.length,
        relationHotspotCount: insights.relationHotspots.length
      },
      "metadata insights returned"
    );

    return {
      ok: true,
      sourcePath: metadataCatalog.sourcePath,
      loadedAt: metadataCatalog.loadedAt,
      insights
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

  app.post("/api/metadata/refresh", async (request) =>
    await runAuditedRequest(
      request,
      "metadata.refresh",
      undefined,
      async () => {
        metadataCatalog = await refreshConfiguredMetadataCatalog(
          config,
          metadataService,
          logger,
          options.metadataCatalogLoader
        );
        semanticCatalog = shouldUseGeneratedSemanticCatalog
          ? buildSemanticCatalogFromMetadata(metadataCatalog, {
              sourcePath: `generated://${metadataCatalog.sourcePath}`,
              loadedAt: metadataCatalog.loadedAt
            })
          : await refreshConfiguredSemanticCatalog(
              config,
              metadataCatalog,
              semanticService,
              logger,
              options.semanticCatalogLoader
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
        app.log.info(
          {
            sourcePath: semanticCatalog.sourcePath,
            modelCount: semanticCatalog.summary.modelCount,
            metricCount: semanticCatalog.summary.metricCount,
            loadedAt: semanticCatalog.loadedAt
          },
          "semantic catalog refreshed"
        );
        runtimeTelemetry.setLastMetadataRefreshAt(metadataCatalog.loadedAt);

        return {
          ok: true,
          sourcePath: metadataCatalog.sourcePath,
          loadedAt: metadataCatalog.loadedAt,
          summary: metadataCatalog.summary,
          relations: metadataCatalog.relations,
          semantic: semanticCatalog.summary
        };
      },
      (result) => ({
        tableCount: result.summary.tableCount,
        relationCount: result.summary.relationCount,
        loadedAt: result.loadedAt
      })
    )
  );

  app.get("/api/semantic/catalog", async () => {
    app.log.info(
      {
        modelCount: semanticCatalog.summary.modelCount,
        metricCount: semanticCatalog.summary.metricCount,
        dimensionCount: semanticCatalog.summary.dimensionCount
      },
      "semantic catalog returned"
    );

    return {
      ok: true,
      sourcePath: semanticCatalog.sourcePath,
      loadedAt: semanticCatalog.loadedAt,
      summary: semanticCatalog.summary,
      models: semanticCatalog.models,
      metrics: semanticCatalog.metrics
    };
  });

  app.get("/api/semantic/insights", async (request) => {
    const query = request.query as {
      modelLimit?: string | number;
      metricLimit?: string | number;
    };
    const modelLimit = parseOptionalInteger(query.modelLimit);
    const metricLimit = parseOptionalInteger(query.metricLimit);
    const insights = buildSemanticCatalogInsights(semanticCatalog, {
      modelLimit,
      metricLimit
    });

    app.log.info(
      {
        modelCount: insights.models.length,
        metricCount: insights.metrics.length,
        ownerCount: insights.owners.length
      },
      "semantic insights returned"
    );

    return {
      ok: true,
      sourcePath: semanticCatalog.sourcePath,
      loadedAt: semanticCatalog.loadedAt,
      insights
    };
  });

  app.get("/api/semantic/search", async (request) => {
    const query = request.query as { q?: string; query?: string; limit?: string | number };
    const searchQuery = query.q ?? query.query;

    if (typeof searchQuery !== "string") {
      throw new AppError("semantic search query is required", "SEMANTIC_SEARCH_QUERY_REQUIRED", 400);
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

    const results = searchSemanticCatalog(semanticCatalog, searchQuery, limit);

    app.log.info(
      {
        query: searchQuery,
        limit,
        resultCount: results.length
      },
      "semantic search completed"
    );

    return {
      ok: true,
      query: searchQuery,
      results
    };
  });

  app.post("/api/semantic/sql", async (request) => {
    const body = request.body as SemanticMetricQueryRequest & { role?: UserRole };

    assertSemanticMetricRequestSecurity(body, requestSecurityPolicy);
    assertSqlRoleRequestInput(body);

    const role = resolveSqlReadRole(body.role, config.sqlAccess);
    const metricQuery = buildSemanticMetricQuery(semanticCatalog, body, {
      maxLimit: DEFAULT_SEMANTIC_QUERY_LIMIT
    });

    assertSqlStatementAccess(metricQuery.sql, metadataCatalog, role, config.sqlAccess);

    app.log.info(
      {
        role,
        metricIds: metricQuery.metricIds,
        dimensionIds: metricQuery.dimensionIds,
        limit: metricQuery.limit
      },
      "semantic sql generated"
    );

    return {
      ok: true,
      query: metricQuery,
      sql: metricQuery.sql
    };
  });

  app.post("/api/semantic/query", async (request) =>
    await runAuditedRequest(
      request,
      "semantic.query",
      undefined,
      async () => {
        const body = request.body as SemanticMetricQueryRequest & { role?: UserRole };

        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "sql",
          config.rateLimit.maxSqlRequests,
          config.rateLimit.windowMs,
          "SQL_RATE_LIMITED",
          "Too many SQL requests"
        );
        assertSemanticMetricRequestSecurity(body, requestSecurityPolicy);
        assertSqlRoleRequestInput(body);

        const role = resolveSqlReadRole(body.role, config.sqlAccess);
        const metricQuery = buildSemanticMetricQuery(semanticCatalog, body, {
          maxLimit: DEFAULT_SEMANTIC_QUERY_LIMIT
        });
        const result = await executeValidatedSqlQuery(
          metricQuery.sql,
          metadataCatalog,
          getReadOnlyQueryExecutor(queryExecutor),
          role,
          config.sqlAccess
        );

        app.log.info(
          {
            role,
            metricIds: metricQuery.metricIds,
            dimensionIds: metricQuery.dimensionIds,
            rowCount: result.rowCount,
            durationMs: result.durationMs
          },
          "semantic query executed"
        );

        return {
          ok: true,
          query: metricQuery,
          sql: metricQuery.sql,
          ...result
        };
      },
      (result) => ({
        metricIds: result.query.metricIds,
        dimensionIds: result.query.dimensionIds,
        rowCount: result.rowCount,
        durationMs: result.durationMs
      })
    )
  );

  app.post("/api/chat", async (request) => {
    const body = request.body as AgentTurnRequest | undefined;
    const executor = getAgentExecutor(agentExecutor);

    return await runAuditedRequest(
      request,
      "chat.request",
      {
        sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
        model: typeof body?.model === "string" ? body.model : config.openAiModel,
        messageChars: typeof body?.message === "string" ? body.message.length : undefined
      },
      async () => {
        if (typeof body?.sessionId !== "string" || typeof body.message !== "string") {
          throw new AppError("sessionId and message are required", "INVALID_CHAT_REQUEST", 400);
        }

        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "chat",
          config.rateLimit.maxChatRequests,
          config.rateLimit.windowMs,
          "CHAT_RATE_LIMITED",
          "Too many chat requests"
        );
        assertChatRequestSecurity(body, requestSecurityPolicy);

        const result = await executor.executeTurn(body);

        return {
          ok: true,
          sessionId: result.sessionId,
          outputText: result.outputText,
          toolCalls: result.toolCalls,
          usage: result.usage
        };
      },
      (result) => ({
        outputChars: result.outputText.length,
        toolCallCount: result.toolCalls.length
      })
    );
  });

  app.post("/api/chat/stream", async (request, reply) => {
    const body = request.body as AgentTurnRequest | undefined;
    const executor = getAgentExecutor(agentExecutor);
    const streamAbortController = new AbortController();
    const auditDetails = {
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
      model: typeof body?.model === "string" ? body.model : config.openAiModel,
      messageChars: typeof body?.message === "string" ? body.message.length : undefined
    };

    if (typeof body?.sessionId !== "string" || typeof body.message !== "string") {
      writeRequestAuditEvent(request, "chat.stream", "blocked", {
        ...auditDetails,
        code: "INVALID_CHAT_REQUEST",
        reason: "sessionId and message are required"
      });
      throw new AppError("sessionId and message are required", "INVALID_CHAT_REQUEST", 400);
    }

    try {
      assertRequestRateLimit(
        request,
        rateLimiter,
        runtimeTelemetry,
        "chat",
        config.rateLimit.maxChatRequests,
        config.rateLimit.windowMs,
        "CHAT_RATE_LIMITED",
        "Too many chat requests"
      );
      assertChatRequestSecurity(body, requestSecurityPolicy);
    } catch (error) {
      writeRequestAuditEvent(request, "chat.stream", getSecurityAuditStatus(error), {
        ...auditDetails,
        code: error instanceof AppError ? error.code : undefined,
        reason: safeErrorMessage(error)
      });
      throw error;
    }

    applySseCorsHeaders(request, reply);
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.hijack();
    reply.raw.flushHeaders?.();
    request.raw.once("close", () => {
      streamAbortController.abort();
      app.log.info(
        {
          sessionId: body.sessionId
        },
        "chat stream client disconnected"
      );
    });
    let emittedFailureEvent = false;
    let outputChars = 0;
    let toolCallCount = 0;
    let failureCode: string | undefined;
    let failureReason: string | undefined;
    let streamCompleted = false;
    let streamFailed = false;

    runtimeTelemetry.onChatStreamStarted();

    try {
      for await (const event of executor.streamTurn({
        ...body,
        signal: streamAbortController.signal
      })) {
        if (event.type === "response.failed") {
          emittedFailureEvent = true;
          failureCode = "code" in event && typeof event.code === "string" ? event.code : undefined;
          failureReason =
            "error" in event && typeof event.error === "string" ? event.error : undefined;
        }

        if (
          event.type === "response.output_text.delta" &&
          "delta" in event &&
          typeof event.delta === "string"
        ) {
          outputChars += event.delta.length;
        }

        if (event.type === "tool.call.started") {
          toolCallCount += 1;
        }

        reply.raw.write(serializeSseEvent(event.type, event));
      }

      writeRequestAuditEvent(
        request,
        "chat.stream",
        emittedFailureEvent ? "failed" : "completed",
        {
          ...auditDetails,
          outputChars,
          toolCallCount,
          code: failureCode,
          reason: failureReason
        }
      );
      runtimeTelemetry.onChatStreamCompleted();
      streamCompleted = true;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError("Stream execution failed", "STREAM_EXECUTION_FAILED", 500, {
              error: safeErrorMessage(error)
            });

      if (!emittedFailureEvent && !streamAbortController.signal.aborted) {
        reply.raw.write(
          serializeSseEvent("response.failed", {
            type: "response.failed",
            sessionId: body.sessionId,
            error: appError.message,
            code: appError.code
          })
        );
      }

      writeRequestAuditEvent(request, "chat.stream", getSecurityAuditStatus(appError), {
        ...auditDetails,
        outputChars,
        toolCallCount,
        code: appError.code,
        reason: appError.message
      });
      runtimeTelemetry.onChatStreamFailed();
      streamFailed = true;
    } finally {
      if (!streamCompleted && !streamFailed && streamAbortController.signal.aborted) {
        runtimeTelemetry.onChatStreamAborted();
      }
      reply.raw.end();
    }
  });

  app.post("/api/sql/validate", async (request) => {
    const body = request.body as { sql?: string; role?: UserRole };

    return await runAuditedRequest(
      request,
      "sql.validate",
      {
        sqlChars: typeof body?.sql === "string" ? body.sql.length : undefined,
        role: body?.role
      },
      () => {
        if (typeof body?.sql !== "string") {
          throw new AppError("sql is required", "SQL_REQUIRED", 400);
        }

        assertSqlRequestSecurity(body, requestSecurityPolicy);
        assertSqlRoleRequestInput(body);

        const validation = validateSqlStatement(body.sql, {
          tables: metadataCatalog.tables,
          maxLimit: DEFAULT_SQL_LIMIT
        });
        const role = resolveSqlReadRole(body.role, config.sqlAccess);
        const accessDecision = validation.allowed
          ? authorizeSqlStatementAccess(
              validation.normalizedSql,
              metadataCatalog,
              role,
              config.sqlAccess
            )
          : undefined;
        const result =
          validation.allowed && accessDecision && !accessDecision.allowed
            ? {
                ...validation,
                allowed: false,
                reason: accessDecision.reason ?? validation.reason
              }
            : validation;

        app.log.info(
          {
            allowed: result.allowed,
            role,
            referencedTables: result.referencedTables,
            limit: result.limit
          },
          "sql validation completed"
        );

        return result;
      },
      (result) => ({
        allowed: result.allowed,
        referencedTables: result.referencedTables,
        limit: result.limit
      }),
      (result) => !result.allowed
    );
  });

  app.post("/api/sql/query", async (request) => {
    const body = request.body as {
      sql?: string;
      role?: UserRole;
      offset?: number;
      pageLimit?: number;
      useCache?: boolean;
    };

    return await runAuditedRequest(
      request,
      "sql.query",
      {
        sqlChars: typeof body?.sql === "string" ? body.sql.length : undefined,
        role: body?.role,
        offset: body?.offset,
        pageLimit: body?.pageLimit,
        useCache: body?.useCache
      },
      async () => {
        if (typeof body?.sql !== "string") {
          throw new AppError("sql is required", "SQL_REQUIRED", 400);
        }

        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "sql",
          config.rateLimit.maxSqlRequests,
          config.rateLimit.windowMs,
          "SQL_RATE_LIMITED",
          "Too many SQL execution requests"
        );
        assertSqlRequestSecurity(body, requestSecurityPolicy);
        assertSqlRoleRequestInput(body);
        const pagination = parseSqlQueryPageRequest(body);
        const role = resolveSqlReadRole(body.role, config.sqlAccess);
        const payload = await executeCachedValidatedSqlQuery(
          body.sql,
          metadataCatalog,
          getReadOnlyQueryExecutor(queryExecutor),
          sqlQueryResultCache,
          role,
          config.sqlAccess,
          {
            useCache: body.useCache !== false
          }
        );
        const result = buildSqlQueryResponse(payload, pagination);

        app.log.info(
          {
            role,
            rowCount: result.rowCount,
            columnCount: result.columns.length,
            durationMs: result.durationMs,
            offset: result.page.offset,
            pageLimit: result.page.limit,
            cacheHit: result.cache.hit
          },
          "sql query executed"
        );

        return result;
      },
      (result) => ({
        rowCount: result.rowCount,
        columnCount: result.columns.length,
        durationMs: result.durationMs,
        referencedTables: result.validation.referencedTables,
        limit: result.validation.limit,
        offset: result.page.offset,
        pageLimit: result.page.limit,
        cacheHit: result.cache.hit
      })
    );
  });

  app.post("/api/sql/query/async", async (request) => {
    const body = request.body as {
      sql?: string;
      role?: UserRole;
      useCache?: boolean;
    };

    return await runAuditedRequest(
      request,
      "sql.query.async.start",
      {
        sqlChars: typeof body?.sql === "string" ? body.sql.length : undefined,
        role: body?.role,
        useCache: body?.useCache
      },
      async () => {
        if (typeof body?.sql !== "string") {
          throw new AppError("sql is required", "SQL_REQUIRED", 400);
        }

        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "sql",
          config.rateLimit.maxSqlRequests,
          config.rateLimit.windowMs,
          "SQL_RATE_LIMITED",
          "Too many SQL execution requests"
        );
        assertSqlRequestSecurity(body, requestSecurityPolicy);
        assertSqlRoleRequestInput(body);
        const role = resolveSqlReadRole(body.role, config.sqlAccess);
        const validation = validateAuthorizedSqlStatement(
          body.sql,
          metadataCatalog,
          role,
          config.sqlAccess
        );
        const cacheKey = buildSqlQueryExecutionCacheKey(validation.normalizedSql, role);

        if (body.useCache !== false) {
          const cached = sqlQueryResultCache.get(cacheKey);

          if (cached) {
            const cachedJob = sqlAsyncQueryJobs.createCompleted(
              {
                ...cached.value,
                cache: {
                  key: cacheKey,
                  hit: true,
                  createdAt: cached.createdAt,
                  expiresAt: cached.expiresAt
                }
              },
              {
              cacheKey,
              metadata: {
                role,
                sqlChars: body.sql.length
              }
            });

            app.log.info(
              {
                role,
                jobId: cachedJob.jobId,
                cacheKey
              },
              "sql async query served from cache"
            );

            return {
              ok: true,
              job: buildSqlAsyncQueryJobSummary(cachedJob)
            };
          }
        }

        const job = sqlAsyncQueryJobs.start(
          async () =>
            await executeCachedValidatedSqlQueryFromValidation(
              validation,
              getReadOnlyQueryExecutor(queryExecutor),
              sqlQueryResultCache,
              role,
              {
                useCache: false
              }
            ),
          {
            cacheKey,
            metadata: {
              role,
              sqlChars: body.sql.length
            }
          }
        );

        app.log.info(
          {
            role,
            jobId: job.jobId,
            cacheKey
          },
          "sql async query started"
        );

        return {
          ok: true,
          job: buildSqlAsyncQueryJobSummary(job)
        };
      },
      (result) => ({
        jobId: result.job.jobId,
        status: result.job.status,
        cacheKey: result.job.cacheKey
      })
    );
  });

  app.get("/api/sql/query/jobs/:jobId", async (request) => {
    const params = request.params as { jobId?: string };
    const jobId =
      typeof params.jobId === "string" && params.jobId.trim().length > 0
        ? params.jobId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "sql.query.async.status",
      {
        jobId
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "sql",
          config.rateLimit.maxSqlRequests,
          config.rateLimit.windowMs,
          "SQL_RATE_LIMITED",
          "Too many SQL execution requests"
        );

        const job = getSqlAsyncQueryJobOrThrow(sqlAsyncQueryJobs, jobId);

        app.log.info(
          {
            jobId: job.jobId,
            status: job.status
          },
          "sql async query status returned"
        );

        return {
          ok: true,
          job: buildSqlAsyncQueryJobSummary(job)
        };
      },
      (result) => ({
        jobId: result.job.jobId,
        status: result.job.status
      })
    );
  });

  app.get("/api/sql/query/jobs/:jobId/result", async (request) => {
    const params = request.params as { jobId?: string };
    const query = request.query as {
      offset?: string | number;
      pageLimit?: string | number;
    };
    const jobId =
      typeof params.jobId === "string" && params.jobId.trim().length > 0
        ? params.jobId.trim()
        : undefined;

    return await runAuditedRequest(
      request,
      "sql.query.async.result",
      {
        jobId,
        offset: query?.offset,
        pageLimit: query?.pageLimit
      },
      () => {
        assertRequestRateLimit(
          request,
          rateLimiter,
          runtimeTelemetry,
          "sql",
          config.rateLimit.maxSqlRequests,
          config.rateLimit.windowMs,
          "SQL_RATE_LIMITED",
          "Too many SQL execution requests"
        );

        const pagination = parseSqlQueryPageRequest(query);
        const job = getSqlAsyncQueryJobOrThrow(sqlAsyncQueryJobs, jobId);

        if (job.status === "failed") {
          throw new AppError(
            job.error?.message ?? "SQL query job failed",
            "SQL_QUERY_JOB_FAILED",
            409,
            {
              jobId: job.jobId,
              error: job.error
            }
          );
        }

        if (job.status !== "completed" || !job.result) {
          throw new AppError("SQL query job is still running", "SQL_QUERY_JOB_NOT_READY", 409, {
            jobId: job.jobId,
            status: job.status
          });
        }

        const result = buildSqlQueryResponse(job.result, pagination);

        app.log.info(
          {
            jobId: job.jobId,
            rowCount: result.rowCount,
            offset: result.page.offset,
            pageLimit: result.page.limit
          },
          "sql async query result returned"
        );

        return {
          ok: true,
          job: buildSqlAsyncQueryJobSummary(job),
          result
        };
      },
      (result) => ({
        jobId: result.job.jobId,
        status: result.job.status,
        rowCount: result.result.rowCount,
        offset: result.result.page.offset,
        pageLimit: result.result.page.limit
      })
    );
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
      role?: UserRole;
    };

    if (typeof body?.tableName !== "string") {
      throw new AppError("tableName is required", "TABLE_NAME_REQUIRED", 400);
    }

    assertSqlSuggestionRequestSecurity(body, requestSecurityPolicy);
    assertSqlRoleRequestInput(body);

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
    const role = resolveSqlReadRole(body.role, config.sqlAccess);

    assertSqlStatementAccess(sql, metadataCatalog, role, config.sqlAccess);

    app.log.info(
      {
        role,
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

  app.post("/api/analysis/insights", async (request) => {
    const body = request.body as {
      rows?: readonly DatasetRow[];
      maxCategoryValues?: number;
      outlierThreshold?: number;
      maxInsights?: number;
    };

    assertDatasetProfileRequestSecurity(body, requestSecurityPolicy);

    const result = generateDatasetInsights({
      rows: body.rows ?? [],
      maxCategoryValues: body.maxCategoryValues,
      outlierThreshold: body.outlierThreshold,
      maxInsights: body.maxInsights
    });

    app.log.info(
      {
        rowCount: result.profile.rowCount,
        fieldCount: result.profile.fieldCount,
        insightCount: result.insights.length
      },
      "dataset insights generated"
    );

    return {
      ok: true,
      profile: result.profile,
      insights: result.insights
    };
  });

  app.post("/api/charts/suggest", async (request) => {
    const body = request.body as {
      title?: string;
      labels?: readonly string[];
      values?: readonly number[];
      hasTimeAxis?: boolean;
      theme?: ChartTheme;
      profile?: ReturnType<typeof profileDataset>;
      maxRecommendations?: number;
    };

    assertChartRequestSecurity(body, requestSecurityPolicy);

    if (body?.profile) {
      const recommendations = recommendChartsFromProfile({
        profile: body.profile,
        maxRecommendations: body.maxRecommendations,
        theme: body.theme
      });

      app.log.info(
        {
          recommendationCount: recommendations.length,
          profileFieldCount: body.profile.fieldCount,
          theme: body.theme ?? "dark"
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
      option: buildEChartsOption(body.title, body.labels, body.values, kind, {
        theme: body.theme
      })
    };
  });

  app.post("/api/security/check", async (request) => {
    const body = request.body as {
      role?: "admin" | "analyst" | "viewer";
      tenantId?: string;
      resourceTenantId?: string;
      action?: "read" | "write" | "delete";
    };

    return await runAuditedRequest(
      request,
      "security.check",
      {
        role: body?.role,
        action: body?.action,
        tenantId: body?.tenantId,
        resourceTenantId: body?.resourceTenantId
      },
      () => {
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
      },
      (result) => ({
        allowed: result.decision.allowed,
        decisionCode: result.decision.code,
        decisionReason: result.decision.reason
      }),
      (result) => !result.decision.allowed
    );
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

export function buildToolRegistry(
  getMetadataCatalog: () => PrismaSchemaCatalog,
  queryExecutor?: ReadOnlyQueryExecutor,
  options: ToolRegistryOptions = {},
  securityOptions: {
    readonly sqlAccessPolicy?: SqlReadAccessPolicy;
    readonly sqlRole?: UserRole;
  } = {},
  getSemanticCatalog?: () => SemanticCatalog
): ToolRegistry {
  const toolRegistry = new ToolRegistry(options);
  const sqlAccessPolicy = securityOptions.sqlAccessPolicy;
  const sqlRole = securityOptions.sqlRole ?? sqlAccessPolicy?.defaultRole ?? "analyst";
  const builtInTools: ToolDefinition[] = [];

  builtInTools.push({
    name: "search-metadata",
    description:
      "Search the active schema catalog for tables, columns, and relations. Use this before SQL generation when a user asks a natural-language data question, including business terms such as order, customer, or event.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Business term, table name, or column name to search for"
        },
        limit: {
          type: "integer",
          description: "Maximum metadata matches to return"
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    execution: {
      timeoutMs: 2_000,
      retries: 0
    },
    execute: (input: { query: string; limit?: number }, context) => {
      const catalog = getMetadataCatalog();
      const limit = input.limit ?? 10;
      const searchedQueries = expandMetadataSearchQueries(input.query);
      const rankedResults = new Map<
        string,
        ReturnType<typeof searchMetadataCatalog>[number]
      >();

      for (const query of searchedQueries) {
        const queryResults = searchMetadataCatalog(catalog, query, limit);

        for (const result of queryResults) {
          const key = [
            result.type,
            result.tableName,
            result.columnName ?? "",
            result.relation
              ? `${result.relation.fromTable}.${result.relation.fromColumn}.${result.relation.toTable}.${result.relation.toColumn}`
              : ""
          ].join(":");
          const previous = rankedResults.get(key);

          if (!previous || previous.score < result.score) {
            rankedResults.set(key, result);
          }
        }
      }

      const results = [...rankedResults.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
      const matchedTableNames = new Set(results.map((result) => result.tableName));
      const tables = catalog.tables
        .filter((table) => matchedTableNames.has(table.name))
        .map((table) => ({
          name: table.name,
          columns: table.columns
        }));

      context?.logger?.info("metadata search tool completed", {
        query: input.query,
        searchedQueries,
        limit,
        resultCount: results.length,
        tableCount: tables.length
      });

      return {
        query: input.query,
        searchedQueries,
        results,
        tables
      };
    }
  });

  if (getSemanticCatalog) {
    builtInTools.push({
      name: "search-semantics",
      description:
        "Search the semantic layer for business-ready models, metrics, and dimensions. Use this before metric SQL generation when the user asks for KPI, trend, or grouped analysis by name.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Metric, dimension, or business KPI term to search for"
          },
          limit: {
            type: "integer",
            description: "Maximum semantic matches to return"
          }
        },
        required: ["query"],
        additionalProperties: false
      },
      execution: {
        timeoutMs: 2_000,
        retries: 0
      },
      execute: (input: { query: string; limit?: number }, context) => {
        const catalog = getSemanticCatalog();
        const limit = input.limit ?? 10;
        const results = searchSemanticCatalog(catalog, input.query, limit);

        context?.logger?.info("semantic search tool completed", {
          query: input.query,
          limit,
          resultCount: results.length
        });

        return {
          query: input.query,
          results
        };
      }
    });

    builtInTools.push({
      name: "generate-metric-sql",
      description:
        "Generate SQL from the semantic layer for one or more business metrics, optional grouping dimensions, optional time grain, and filters.",
      inputSchema: {
        type: "object",
        properties: {
          metricIds: {
            type: "array",
            items: { type: "string" }
          },
          dimensionIds: {
            type: "array",
            items: { type: "string" }
          },
          timeDimensionId: { type: "string" },
          timeGrain: {
            type: "string",
            enum: ["raw", "day", "week", "month"]
          },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimensionId: { type: "string" },
                operator: {
                  type: "string",
                  enum: ["=", "!=", ">", ">=", "<", "<=", "in"]
                },
                values: {
                  type: "array",
                  items: { type: "string" }
                }
              },
              required: ["dimensionId", "operator", "values"],
              additionalProperties: false
            }
          },
          limit: { type: "integer" }
        },
        required: ["metricIds"],
        additionalProperties: false
      },
      execution: {
        timeoutMs: 2_000,
        retries: 0
      },
      execute: (input: SemanticMetricQueryRequest, context) => {
        const metricQuery = buildSemanticMetricQuery(getSemanticCatalog(), input, {
          maxLimit: DEFAULT_SEMANTIC_QUERY_LIMIT
        });

        if (sqlAccessPolicy) {
          assertSqlStatementAccess(metricQuery.sql, getMetadataCatalog(), sqlRole, sqlAccessPolicy);
        }

        context?.logger?.info("semantic metric sql tool completed", {
          metricIds: metricQuery.metricIds,
          dimensionIds: metricQuery.dimensionIds,
          limit: metricQuery.limit
        });

        return metricQuery;
      }
    });

    if (queryExecutor) {
      builtInTools.push({
        name: "query-metric",
        description:
          "Execute a semantic metric query and return rows for KPI, grouped, and time-series answers.",
        inputSchema: {
          type: "object",
          properties: {
            metricIds: {
              type: "array",
              items: { type: "string" }
            },
            dimensionIds: {
              type: "array",
              items: { type: "string" }
            },
            timeDimensionId: { type: "string" },
            timeGrain: {
              type: "string",
              enum: ["raw", "day", "week", "month"]
            },
            filters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  dimensionId: { type: "string" },
                  operator: {
                    type: "string",
                    enum: ["=", "!=", ">", ">=", "<", "<=", "in"]
                  },
                  values: {
                    type: "array",
                    items: { type: "string" }
                  }
                },
                required: ["dimensionId", "operator", "values"],
                additionalProperties: false
              }
            },
            limit: { type: "integer" }
          },
          required: ["metricIds"],
          additionalProperties: false
        },
        execution: {
          timeoutMs: 15_000,
          retries: 0
        },
        execute: async (input: SemanticMetricQueryRequest) => {
          const metricQuery = buildSemanticMetricQuery(getSemanticCatalog(), input, {
            maxLimit: DEFAULT_SEMANTIC_QUERY_LIMIT
          });

          return {
            query: metricQuery,
            ...(await executeValidatedSqlQuery(
              metricQuery.sql,
              getMetadataCatalog(),
              queryExecutor,
              sqlRole,
              sqlAccessPolicy
            ))
          };
        }
      });
    }
  }

  builtInTools.push({
    name: "validate-sql",
    description:
      "Validate a SQL statement for safe execution against the active metadata catalog",
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
    execute: (input: { sql: string }) => {
      const validation = validateSqlStatement(input.sql, {
        tables: getMetadataCatalog().tables,
        maxLimit: DEFAULT_SQL_LIMIT
      });

      if (!validation.allowed || !sqlAccessPolicy) {
        return validation;
      }

      const accessDecision = authorizeSqlStatementAccess(
        validation.normalizedSql,
        getMetadataCatalog(),
        sqlRole,
        sqlAccessPolicy
      );

      if (!accessDecision.allowed) {
        return {
          ...validation,
          allowed: false,
          reason: accessDecision.reason ?? validation.reason
        };
      }

      return validation;
    }
  });

  builtInTools.push({
    name: "generate-sql",
    description:
      "Generate a metadata-aware safe SELECT statement for an explicit table and optional columns. Use search-metadata first when the table name is uncertain.",
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
    }) => {
      const sql = buildSqlAwareSelectQuery(
        {
          tableName: input.tableName,
          columns: input.columns,
          limit: input.limit
        },
        {
          tables: getMetadataCatalog().tables,
          maxLimit: DEFAULT_SQL_LIMIT
        }
      );

      if (sqlAccessPolicy) {
        assertSqlStatementAccess(sql, getMetadataCatalog(), sqlRole, sqlAccessPolicy);
      }

      return sql;
    }
  });

  if (queryExecutor) {
    builtInTools.push({
      name: "query-sql",
      description:
        "Execute a validated read-only SQL statement and return rows. Use this for factual database answers, including record counts such as select count(*) as count from table limit 1.",
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
        await executeValidatedSqlQuery(
          input.sql,
          getMetadataCatalog(),
          queryExecutor,
          sqlRole,
          sqlAccessPolicy
        )
    });
  }

  builtInTools.push({
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

  builtInTools.push({
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

  builtInTools.push({
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

  builtInTools.push({
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
        hasTimeAxis: { type: "boolean" },
        theme: {
          type: "string",
          enum: ["dark", "light"],
          description: "Chart theme used for generated option styling"
        }
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
      theme?: ChartTheme;
    }) => {
      const kind = chooseChartKind({
        dimensions: input.labels.length > 0 ? ["category"] : [],
        metrics: ["value"],
        hasTimeAxis: input.hasTimeAxis
      });

      return {
        kind,
        option: buildEChartsOption(input.title, input.labels, input.values, kind, {
          theme: input.theme
        })
      };
    }
  });

  builtInTools.push({
    name: "recommend-charts",
    description: "Recommend charts from a dataset profile",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          additionalProperties: true
        },
        maxRecommendations: { type: "integer" },
        theme: {
          type: "string",
          enum: ["dark", "light"],
          description: "Chart theme used for generated recommendation options"
        }
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
      theme?: ChartTheme;
    }) =>
      recommendChartsFromProfile({
        profile: input.profile,
        maxRecommendations: input.maxRecommendations,
        theme: input.theme
      })
  });

  builtInTools.push({
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

  toolRegistry.registerDiscovered(builtInTools, {
    sourceName: "api-builtins"
  });

  return toolRegistry;
}

interface AuditedRequestLike {
  readonly id: string;
  readonly url: string;
  readonly ip?: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions?: {
    readonly url?: string;
  };
}

async function runAuditedRequest<T>(
  request: AuditedRequestLike,
  action: string,
  details: Readonly<Record<string, unknown>> | undefined,
  operation: () => Promise<T> | T,
  summarizeResult?: (result: T) => Readonly<Record<string, unknown>> | undefined,
  isBlockedResult?: (result: T) => boolean
): Promise<T> {
  try {
    const result = await operation();

    writeRequestAuditEvent(
      request,
      action,
      isBlockedResult?.(result) ? "blocked" : "completed",
      {
        ...details,
        ...summarizeResult?.(result)
      }
    );

    return result;
  } catch (error) {
    writeRequestAuditEvent(request, action, getSecurityAuditStatus(error), {
      ...details,
      code: error instanceof AppError ? error.code : undefined,
      reason: safeErrorMessage(error)
    });
    throw error;
  }
}

function writeRequestAuditEvent(
  request: AuditedRequestLike,
  action: string,
  status: SecurityAuditStatus,
  details?: Readonly<Record<string, unknown>>
): void {
  writeSecurityAuditEvent({
    action,
    status,
    requestId: request.id,
    route: request.routeOptions?.url ?? request.url,
    details
  });
}

function getSecurityAuditStatus(error: unknown): SecurityAuditStatus {
  if (error instanceof AppError && error.statusCode < 500) {
    return "blocked";
  }

  return "failed";
}

function assertRequestRateLimit(
  request: AuditedRequestLike,
  rateLimiter: InMemoryRateLimiter,
  runtimeTelemetry: RuntimeTelemetry,
  bucket: "chat" | "operator" | "sql",
  limit: number,
  windowMs: number,
  code: string,
  message: string
): void {
  const route = request.routeOptions?.url ?? request.url;
  const requester = buildRequesterKey(request);
  const result = rateLimiter.take(`${bucket}:${requester}:${route}`, {
    limit,
    windowMs
  });

  if (result.allowed) {
    return;
  }

  runtimeTelemetry.onRateLimited();

  throw new AppError(message, code, 429, {
    bucket,
    limit,
    windowMs,
    retryAfterMs: result.retryAfterMs
  });
}

function buildRequesterKey(request: AuditedRequestLike): string {
  const headerValue = request.headers?.["x-forwarded-for"];

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.split(",")[0]!.trim();
  }

  if (Array.isArray(headerValue) && typeof headerValue[0] === "string" && headerValue[0].trim().length > 0) {
    return headerValue[0].split(",")[0]!.trim();
  }

  return request.ip?.trim() || "unknown";
}

function expandMetadataSearchQueries(query: string): readonly string[] {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    return [normalizedQuery];
  }

  const expansions = new Set<string>([normalizedQuery]);
  const lowerQuery = normalizedQuery.toLowerCase();
  const termExpansions: readonly [RegExp, readonly string[]][] = [
    [/订单|order|orders/i, ["order", "orders", "cda_orders"]],
    [/客户|customer|customers/i, ["customer", "customers", "cda_customers"]],
    [/事件|event|events/i, ["event", "events", "cda_order_events"]]
  ];

  for (const [pattern, terms] of termExpansions) {
    if (!pattern.test(lowerQuery)) {
      continue;
    }

    for (const term of terms) {
      expansions.add(term);
    }
  }

  return [...expansions];
}

function parseOptionalInteger(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function parseSqlQueryPageRequest(input: {
  readonly offset?: string | number;
  readonly pageLimit?: string | number;
}): SqlQueryPageRequest {
  const offset = parseOptionalInteger(input.offset);
  const pageLimit = parseOptionalInteger(input.pageLimit);

  if (typeof offset !== "undefined" && (!Number.isInteger(offset) || offset < 0)) {
    throw new AppError("offset must be a non-negative integer", "INVALID_SQL_QUERY_OFFSET", 400, {
      offset: input.offset
    });
  }

  if (
    typeof pageLimit !== "undefined" &&
    (!Number.isInteger(pageLimit) || pageLimit <= 0 || pageLimit > DEFAULT_SQL_LIMIT)
  ) {
    throw new AppError(
      `pageLimit must be between 1 and ${DEFAULT_SQL_LIMIT}`,
      "INVALID_SQL_QUERY_PAGE_LIMIT",
      400,
      {
        pageLimit: input.pageLimit
      }
    );
  }

  return {
    offset: offset ?? 0,
    pageLimit
  };
}

function assertSemanticMetricRequestSecurity(
  input: SemanticMetricQueryRequest | undefined,
  policy: ApiConfig["requestSecurity"]
): asserts input is SemanticMetricQueryRequest {
  if (!input || !Array.isArray(input.metricIds) || input.metricIds.length === 0) {
    throw new AppError("metricIds are required", "SEMANTIC_METRIC_IDS_REQUIRED", 400);
  }

  if (input.metricIds.length > 8) {
    throw new AppError("Too many semantic metrics requested", "SEMANTIC_METRIC_LIMIT_EXCEEDED", 400, {
      count: input.metricIds.length,
      limit: 8
    });
  }

  for (const metricId of input.metricIds) {
    assertBoundedSemanticText(metricId, "metricId", policy.maxIdentifierChars, "SEMANTIC_METRIC_ID_TOO_LARGE");
  }

  if (typeof input.timeDimensionId !== "undefined") {
    assertBoundedSemanticText(
      input.timeDimensionId,
      "timeDimensionId",
      policy.maxIdentifierChars,
      "SEMANTIC_TIME_DIMENSION_ID_TOO_LARGE"
    );
  }

  if (typeof input.timeGrain !== "undefined") {
    assertSemanticTimeGrain(input.timeGrain);
  }

  if (typeof input.limit !== "undefined") {
    if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > DEFAULT_SEMANTIC_QUERY_LIMIT) {
      throw new AppError(
        `Semantic query limit must be between 1 and ${DEFAULT_SEMANTIC_QUERY_LIMIT}`,
        "INVALID_SEMANTIC_QUERY_LIMIT",
        400,
        {
          limit: input.limit
        }
      );
    }
  }

  if (typeof input.dimensionIds !== "undefined") {
    if (!Array.isArray(input.dimensionIds)) {
      throw new AppError("dimensionIds must be an array", "INVALID_SEMANTIC_DIMENSIONS", 400);
    }

    if (input.dimensionIds.length > 12) {
      throw new AppError("Too many semantic dimensions requested", "SEMANTIC_DIMENSION_LIMIT_EXCEEDED", 400, {
        count: input.dimensionIds.length,
        limit: 12
      });
    }

    for (const dimensionId of input.dimensionIds) {
      assertBoundedSemanticText(
        dimensionId,
        "dimensionId",
        policy.maxIdentifierChars,
        "SEMANTIC_DIMENSION_ID_TOO_LARGE"
      );
    }
  }

  if (typeof input.filters !== "undefined") {
    if (!Array.isArray(input.filters)) {
      throw new AppError("filters must be an array", "INVALID_SEMANTIC_FILTERS", 400);
    }

    if (input.filters.length > 12) {
      throw new AppError("Too many semantic filters requested", "SEMANTIC_FILTER_LIMIT_EXCEEDED", 400, {
        count: input.filters.length,
        limit: 12
      });
    }

    for (const filter of input.filters) {
      assertSemanticFilterSecurity(filter, policy);
    }
  }
}

function assertSemanticFilterSecurity(
  filter: SemanticMetricFilterDefinition,
  policy: ApiConfig["requestSecurity"]
): void {
  assertBoundedSemanticText(
    filter.dimensionId,
    "filter.dimensionId",
    policy.maxIdentifierChars,
    "SEMANTIC_FILTER_DIMENSION_ID_TOO_LARGE"
  );
  assertSemanticFilterOperator(filter.operator);

  if (!Array.isArray(filter.values) || filter.values.length === 0) {
    throw new AppError("Semantic filter values are required", "INVALID_SEMANTIC_FILTER_VALUES", 400, {
      dimensionId: filter.dimensionId
    });
  }

  if (filter.values.length > 20) {
    throw new AppError("Too many semantic filter values requested", "SEMANTIC_FILTER_VALUE_LIMIT_EXCEEDED", 400, {
      dimensionId: filter.dimensionId,
      count: filter.values.length,
      limit: 20
    });
  }

  for (const value of filter.values) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new AppError("Semantic filter values must be finite", "INVALID_SEMANTIC_FILTER_VALUE", 400, {
          dimensionId: filter.dimensionId
        });
      }

      continue;
    }

    if (typeof value === "boolean") {
      continue;
    }

    assertBoundedSemanticText(
      value,
      "filter.value",
      policy.maxDatasetCellChars,
      "SEMANTIC_FILTER_VALUE_TOO_LARGE"
    );
  }
}

function assertSemanticFilterOperator(operator: SemanticMetricFilterDefinition["operator"]): void {
  if (
    operator !== "=" &&
    operator !== "!=" &&
    operator !== ">" &&
    operator !== ">=" &&
    operator !== "<" &&
    operator !== "<=" &&
    operator !== "in"
  ) {
    throw new AppError("Semantic filter operator is invalid", "INVALID_SEMANTIC_FILTER_OPERATOR", 400, {
      operator
    });
  }
}

function assertSemanticTimeGrain(timeGrain: SemanticTimeGrain): void {
  if (timeGrain !== "raw" && timeGrain !== "day" && timeGrain !== "week" && timeGrain !== "month") {
    throw new AppError("Semantic timeGrain is invalid", "INVALID_SEMANTIC_TIME_GRAIN", 400, {
      timeGrain
    });
  }
}

function assertBoundedSemanticText(
  value: unknown,
  name: string,
  maxChars: number,
  code: string
): asserts value is string {
  if (typeof value !== "string") {
    throw new AppError(`${name} must be a string`, `INVALID_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, 400);
  }

  if (value.length === 0) {
    throw new AppError(`${name} cannot be empty`, `EMPTY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, 400);
  }

  if (value.length > maxChars) {
    throw new AppError(`${name} is too large`, code, 400, {
      name,
      length: value.length,
      limit: maxChars
    });
  }
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

function resolveSqlReadRole(
  requestedRole: UserRole | undefined,
  sqlAccessPolicy: SqlReadAccessPolicy
): UserRole {
  return requestedRole ?? sqlAccessPolicy.defaultRole;
}

function authorizeSqlStatementAccess(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  role: UserRole,
  sqlAccessPolicy: SqlReadAccessPolicy
) {
  const readTargets = collectSqlReadTargets(sql, {
    tables: metadataCatalog.tables,
    maxLimit: DEFAULT_SQL_LIMIT
  });

  return authorizeSqlReadAccess(
    {
      role,
      referencedTables: readTargets.referencedTables,
      referencedColumns: readTargets.resolvedColumns
    },
    sqlAccessPolicy
  );
}

function assertSqlStatementAccess(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  role: UserRole,
  sqlAccessPolicy: SqlReadAccessPolicy
): void {
  const readTargets = collectSqlReadTargets(sql, {
    tables: metadataCatalog.tables,
    maxLimit: DEFAULT_SQL_LIMIT
  });

  assertSqlReadAccess(
    {
      role,
      referencedTables: readTargets.referencedTables,
      referencedColumns: readTargets.resolvedColumns
    },
    sqlAccessPolicy
  );
}

function validateAuthorizedSqlStatement(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  role?: UserRole,
  sqlAccessPolicy?: SqlReadAccessPolicy
): SqlStatementValidation {
  const validation = validateSqlStatement(sql, {
    tables: metadataCatalog.tables,
    maxLimit: DEFAULT_SQL_LIMIT
  });

  if (!validation.allowed) {
    throw new AppError(validation.reason ?? "SQL is not allowed", "SQL_NOT_ALLOWED", 400, {
      validation
    });
  }

  if (role && sqlAccessPolicy) {
    const accessDecision = authorizeSqlStatementAccess(
      validation.normalizedSql,
      metadataCatalog,
      role,
      sqlAccessPolicy
    );

    if (!accessDecision.allowed) {
      throw new AppError(
        accessDecision.reason ?? "SQL read access denied",
        accessDecision.code ?? "SQL_ACCESS_DENIED",
        403,
        {
          validation,
          accessDecision
        }
      );
    }
  }

  return validation;
}

async function executeValidatedSqlQuery(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  queryExecutor: ReadOnlyQueryExecutor,
  role?: UserRole,
  sqlAccessPolicy?: SqlReadAccessPolicy
) : Promise<ValidatedSqlQueryExecutionResult> {
  const validation = validateAuthorizedSqlStatement(
    sql,
    metadataCatalog,
    role,
    sqlAccessPolicy
  );
  const result = await queryExecutor.executeReadOnlyQuery(validation.normalizedSql);

  return {
    ...result,
    validation
  };
}

async function executeCachedValidatedSqlQuery(
  sql: string,
  metadataCatalog: PrismaSchemaCatalog,
  queryExecutor: ReadOnlyQueryExecutor,
  queryResultCache: InMemoryQueryResultCache<SqlQueryExecutionPayload>,
  role?: UserRole,
  sqlAccessPolicy?: SqlReadAccessPolicy,
  options: {
    readonly useCache?: boolean;
  } = {}
): Promise<SqlQueryExecutionPayload> {
  const validation = validateAuthorizedSqlStatement(
    sql,
    metadataCatalog,
    role,
    sqlAccessPolicy
  );

  return await executeCachedValidatedSqlQueryFromValidation(
    validation,
    queryExecutor,
    queryResultCache,
    role,
    options
  );
}

async function executeCachedValidatedSqlQueryFromValidation(
  validation: SqlStatementValidation,
  queryExecutor: ReadOnlyQueryExecutor,
  queryResultCache: InMemoryQueryResultCache<SqlQueryExecutionPayload>,
  role?: UserRole,
  options: {
    readonly useCache?: boolean;
  } = {}
): Promise<SqlQueryExecutionPayload> {
  const cacheKey = buildSqlQueryExecutionCacheKey(validation.normalizedSql, role);

  if (options.useCache !== false) {
    const cached = queryResultCache.get(cacheKey);

    if (cached) {
      return {
        ...cached.value,
        cache: {
          key: cacheKey,
          hit: true,
          createdAt: cached.createdAt,
          expiresAt: cached.expiresAt
        }
      };
    }
  }

  const result = await queryExecutor.executeReadOnlyQuery(validation.normalizedSql);
  const payload: SqlQueryExecutionPayload = {
    result: {
      ...result,
      validation
    },
    cache: {
      key: cacheKey,
      hit: false,
      createdAt: "",
      expiresAt: ""
    }
  };
  const stored = queryResultCache.set(cacheKey, payload);

  return {
    ...stored.value,
    cache: {
      key: cacheKey,
      hit: false,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    }
  };
}

function buildSqlQueryExecutionCacheKey(
  normalizedSql: string,
  role: UserRole | undefined
): string {
  return buildQueryResultCacheKey(["sql.query", role ?? "", normalizedSql]);
}

function buildSqlAsyncQueryJobSummary(job: {
  readonly jobId: string;
  readonly status: "running" | "completed" | "failed";
  readonly submittedAt: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
  readonly cacheKey?: string;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
  readonly result?: SqlQueryExecutionPayload;
}): SqlAsyncQueryJobSummary {
  return {
    jobId: job.jobId,
    status: job.status,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt,
    cacheKey: job.cacheKey,
    rowCount: job.result?.result.rowCount,
    durationMs: job.result?.result.durationMs,
    referencedTables: job.result?.result.validation.referencedTables,
    limit: job.result?.result.validation.limit,
    error: job.error
  };
}

function buildSqlQueryResponse(
  payload: SqlQueryExecutionPayload,
  pageRequest: SqlQueryPageRequest
): ValidatedSqlQueryExecutionResult & {
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly returnedRows: number;
    readonly hasMore: boolean;
  };
  readonly cache: SqlQueryCacheMetadata;
} {
  const pagedResult = paginateReadOnlyQueryResult(payload.result, {
    offset: pageRequest.offset,
    limit: pageRequest.pageLimit
  });

  return {
    ...payload.result,
    rows: pagedResult.rows,
    page: pagedResult.page,
    cache: payload.cache
  };
}

function getSqlAsyncQueryJobOrThrow(
  jobManager: InMemoryAsyncQueryJobManager<SqlQueryExecutionPayload>,
  jobId: string | undefined
) {
  if (!jobId) {
    throw new AppError("jobId is required", "SQL_QUERY_JOB_ID_REQUIRED", 400);
  }

  const job = jobManager.get(jobId);

  if (!job) {
    throw new AppError(`Unknown SQL query job: ${jobId}`, "SQL_QUERY_JOB_NOT_FOUND", 404, {
      jobId
    });
  }

  return job;
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

async function loadConfiguredSemanticCatalog(
  config: ApiConfig,
  metadataCatalog: PrismaSchemaCatalog,
  semanticService: SemanticCatalogService,
  logger: ReturnType<typeof createLogger>,
  semanticCatalogLoader?: (
    config: ApiConfig,
    metadataCatalog: PrismaSchemaCatalog
  ) => Promise<SemanticCatalog>
): Promise<SemanticCatalog> {
  if (semanticCatalogLoader) {
    return await semanticCatalogLoader(config, metadataCatalog);
  }

  logger.info("loading semantic catalog", {
    semanticCatalogPath: resolveSemanticCatalogPath(config)
  });

  return await semanticService.getCatalog();
}

async function refreshConfiguredSemanticCatalog(
  config: ApiConfig,
  metadataCatalog: PrismaSchemaCatalog,
  semanticService: SemanticCatalogService,
  logger: ReturnType<typeof createLogger>,
  semanticCatalogLoader?: (
    config: ApiConfig,
    metadataCatalog: PrismaSchemaCatalog
  ) => Promise<SemanticCatalog>
): Promise<SemanticCatalog> {
  if (semanticCatalogLoader) {
    return await semanticCatalogLoader(config, metadataCatalog);
  }

  logger.info("refreshing semantic catalog", {
    semanticCatalogPath: resolveSemanticCatalogPath(config)
  });

  return await semanticService.refresh();
}

function resolveSemanticCatalogPath(config: ApiConfig): string {
  if (config.semanticCatalogPath.trim().length === 0) {
    return config.metadataSource === "postgres"
      ? resolve(moduleDir, "../../../packages/database/semantic/postgres-catalog.json")
      : defaultSemanticCatalogPath;
  }

  return resolve(config.semanticCatalogPath);
}

function buildDefaultAnalysisAgentEvaluationCases(
  registeredToolNames: readonly string[]
): readonly AgentEvaluationCase[] {
  const tools = new Set(registeredToolNames);
  const cases: AgentEvaluationCase[] = [];

  if (tools.has("search-metadata") && tools.has("query-sql")) {
    cases.push({
      id: "metadata-record-count",
      message: "订单中有多少记录？",
      expected: {
        requiredToolNames: ["search-metadata", "query-sql"],
        minToolCalls: 2
      }
    });
  } else if (tools.has("validate-sql")) {
    cases.push({
      id: "sql-safety-validation",
      message: "Can I safely run select id, tenantId from AuditLog limit 20?",
      expected: {
        requiredToolNames: ["validate-sql"],
        minToolCalls: 1
      }
    });
  }

  if (tools.has("search-semantics") && tools.has("query-metric")) {
    cases.push({
      id: "semantic-metric-query",
      message: "按租户名称统计租户数",
      expected: {
        requiredToolNames: ["search-semantics", "query-metric"],
        minToolCalls: 2
      }
    });
  } else if (tools.has("search-semantics") && tools.has("generate-metric-sql")) {
    cases.push({
      id: "semantic-sql-generation",
      message: "Generate SQL for tenant count grouped by tenant name",
      expected: {
        requiredToolNames: ["search-semantics", "generate-metric-sql"],
        minToolCalls: 2
      }
    });
  }

  if (cases.length === 0) {
    cases.push({
      id: "assistant-readiness",
      message: "Reply with a short readiness summary for the analysis agent.",
      expected: {
        maxToolCalls: 0
      }
    });
  }

  return cases;
}

function parseAnalysisAgentEvaluationRequest(
  body: unknown,
  policy: ReturnType<typeof buildRequestSecurityPolicy>,
  defaultCases: readonly AgentEvaluationCase[]
): {
  readonly name?: string;
  readonly sessionIdPrefix?: string;
  readonly cases: readonly AgentEvaluationCase[];
} {
  if (typeof body === "undefined" || body === null) {
    return {
      cases: defaultCases
    };
  }

  if (!isRecordLike(body)) {
    throw new AppError(
      "Analysis agent evaluation request must be an object",
      "INVALID_ANALYSIS_AGENT_EVALUATION_REQUEST",
      400
    );
  }

  const name = readOptionalBoundedText(
    body.name,
    "name",
    policy.maxSessionTitleChars,
    "ANALYSIS_AGENT_EVALUATION_NAME_TOO_LARGE"
  );
  const sessionIdPrefix = readOptionalBoundedText(
    body.sessionIdPrefix,
    "sessionIdPrefix",
    policy.maxSessionIdChars,
    "ANALYSIS_AGENT_EVALUATION_SESSION_PREFIX_TOO_LARGE"
  );

  if (typeof body.cases === "undefined") {
    return {
      ...(name ? { name } : {}),
      ...(sessionIdPrefix ? { sessionIdPrefix } : {}),
      cases: defaultCases
    };
  }

  if (!Array.isArray(body.cases) || body.cases.length === 0) {
    throw new AppError(
      "Analysis agent evaluation cases must be a non-empty array",
      "INVALID_ANALYSIS_AGENT_EVALUATION_CASES",
      400
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(sessionIdPrefix ? { sessionIdPrefix } : {}),
    cases: body.cases.map((value, index) =>
      parseAnalysisAgentEvaluationCase(value, index, policy)
    )
  };
}

function parseAnalysisAgentEvaluationCase(
  value: unknown,
  index: number,
  policy: ReturnType<typeof buildRequestSecurityPolicy>
): AgentEvaluationCase {
  if (!isRecordLike(value)) {
    throw new AppError(
      "Analysis agent evaluation case must be an object",
      "INVALID_ANALYSIS_AGENT_EVALUATION_CASE",
      400,
      {
        index
      }
    );
  }

  const id = readRequiredBoundedText(
    value.id,
    "id",
    policy.maxSessionIdChars,
    "ANALYSIS_AGENT_EVALUATION_CASE_ID_TOO_LARGE"
  );
  const message = readRequiredBoundedText(
    value.message,
    "message",
    policy.maxChatMessageChars,
    "ANALYSIS_AGENT_EVALUATION_CASE_MESSAGE_TOO_LARGE"
  );
  const model = readOptionalBoundedText(
    value.model,
    "model",
    policy.maxModelChars,
    "ANALYSIS_AGENT_EVALUATION_CASE_MODEL_TOO_LARGE"
  );
  const sessionId = readOptionalBoundedText(
    value.sessionId,
    "sessionId",
    policy.maxSessionIdChars,
    "ANALYSIS_AGENT_EVALUATION_CASE_SESSION_ID_TOO_LARGE"
  );

  return {
    id,
    message,
    ...(model ? { model } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(typeof value.expected !== "undefined"
      ? {
          expected: parseAnalysisAgentEvaluationExpectations(value.expected, index)
        }
      : {})
  };
}

function parseAnalysisAgentEvaluationExpectations(
  value: unknown,
  index: number
): AgentEvaluationCase["expected"] {
  if (!isRecordLike(value)) {
    throw new AppError(
      "Analysis agent evaluation expectations must be an object",
      "INVALID_ANALYSIS_AGENT_EVALUATION_EXPECTATIONS",
      400,
      {
        index
      }
    );
  }

  const minToolCalls = readOptionalNonNegativeInteger(
    value.minToolCalls,
    "minToolCalls",
    "ANALYSIS_AGENT_EVALUATION_MIN_TOOL_CALLS_INVALID"
  );
  const maxToolCalls = readOptionalNonNegativeInteger(
    value.maxToolCalls,
    "maxToolCalls",
    "ANALYSIS_AGENT_EVALUATION_MAX_TOOL_CALLS_INVALID"
  );

  if (
    typeof minToolCalls === "number" &&
    typeof maxToolCalls === "number" &&
    minToolCalls > maxToolCalls
  ) {
    throw new AppError(
      "Analysis agent evaluation minToolCalls cannot exceed maxToolCalls",
      "ANALYSIS_AGENT_EVALUATION_TOOL_CALL_RANGE_INVALID",
      400,
      {
        index,
        minToolCalls,
        maxToolCalls
      }
    );
  }

  return {
    outputIncludes: readOptionalStringArray(
      value.outputIncludes,
      "outputIncludes",
      "ANALYSIS_AGENT_EVALUATION_OUTPUT_INCLUDES_INVALID"
    ),
    outputExcludes: readOptionalStringArray(
      value.outputExcludes,
      "outputExcludes",
      "ANALYSIS_AGENT_EVALUATION_OUTPUT_EXCLUDES_INVALID"
    ),
    requiredToolNames: readOptionalStringArray(
      value.requiredToolNames,
      "requiredToolNames",
      "ANALYSIS_AGENT_EVALUATION_REQUIRED_TOOLS_INVALID"
    ),
    forbiddenToolNames: readOptionalStringArray(
      value.forbiddenToolNames,
      "forbiddenToolNames",
      "ANALYSIS_AGENT_EVALUATION_FORBIDDEN_TOOLS_INVALID"
    ),
    ...(typeof minToolCalls === "number" ? { minToolCalls } : {}),
    ...(typeof maxToolCalls === "number" ? { maxToolCalls } : {})
  };
}

function readOptionalBoundedText(
  value: unknown,
  name: string,
  maxChars: number,
  code: string
): string | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  return readRequiredBoundedText(value, name, maxChars, code);
}

function readRequiredBoundedText(
  value: unknown,
  name: string,
  maxChars: number,
  code: string
): string {
  assertBoundedSemanticText(value, name, maxChars, code);
  return value.trim();
}

function readOptionalNonNegativeInteger(
  value: unknown,
  name: string,
  code: string
): number | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  const parsedValue = typeof value === "number" ? value : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, code, 400, {
      name,
      value
    });
  }

  return parsedValue;
}

function readOptionalStringArray(
  value: unknown,
  name: string,
  code: string
): readonly string[] | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${name} must be an array`, code, 400, {
      name
    });
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new AppError(`${name} contains an invalid value`, code, 400, {
        name,
        index
      });
    }

    return entry.trim();
  });
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assertOperatorRequestAuthorized(
  request: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
  },
  config: ApiConfig
): void {
  if (config.operatorApiKey.trim().length === 0) {
    throw new AppError(
      "Operator session endpoints are not configured. Set OPERATOR_API_KEY to enable them.",
      "OPERATOR_API_KEY_NOT_CONFIGURED",
      503
    );
  }

  const headerValue = request.headers["x-operator-api-key"];
  const providedKey =
    typeof headerValue === "string"
      ? headerValue
      : Array.isArray(headerValue)
        ? headerValue[0]
        : undefined;

  if (!providedKey || providedKey.trim().length === 0) {
    throw new AppError(
      "Operator API key is required",
      "OPERATOR_API_KEY_REQUIRED",
      403
    );
  }

  if (!secureTextEquals(providedKey, config.operatorApiKey)) {
    throw new AppError(
      "Operator API key is invalid",
      "INVALID_OPERATOR_API_KEY",
      403
    );
  }
}

function secureTextEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
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

