import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import { buildAgentManifest } from "@clusterdata/agent-core";
import { summarizeSeries } from "@clusterdata/analysis-service";
import { buildEChartsOption, chooseChartKind } from "@clusterdata/chart-engine";
import { summarizeDatabaseConfig } from "@clusterdata/database";
import { buildRelationGraph, summarizeMetadata } from "@clusterdata/metadata-engine";
import { authorizeAccess } from "@clusterdata/security";
import { createLogger, safeErrorMessage, AppError } from "@clusterdata/shared";
import { buildSafeLimitClause, validateSqlStatement } from "@clusterdata/sql-agent";
import { ToolRegistry } from "@clusterdata/tool-system";
import { loadApiConfig } from "./config.js";

const toolRegistry = new ToolRegistry();

toolRegistry.register({
  name: "validate-sql",
  description: "Validate a SQL statement for safe execution",
  execute: (input: { sql: string }) => validateSqlStatement(input.sql)
});

toolRegistry.register({
  name: "summarize-series",
  description: "Summarize a numeric series",
  execute: (input: { points: readonly number[] }) => summarizeSeries(input.points)
});

toolRegistry.register({
  name: "suggest-chart",
  description: "Suggest a chart type and build option metadata",
  execute: (input: {
    title: string;
    labels: readonly string[];
    values: readonly number[];
    hasTimeAxis: boolean;
  }) => {
    const kind = chooseChartKind({
      dimensions: input.labels,
      metrics: ["value"],
      hasTimeAxis: input.hasTimeAxis
    });

    return {
      kind,
      option: buildEChartsOption(input.title, input.labels, input.values, kind)
    };
  }
});

export async function buildApi(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true
  });
  const config = loadApiConfig(process.env);
  const logger = createLogger("api");

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
      currentGoal: "Initialize the monorepo foundation",
      priorities: [
        "monorepo",
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

    const metadata = summarizeMetadata([
      {
        name: "orders",
        columns: [
          { name: "id", dataType: "uuid" },
          { name: "customer_id", dataType: "uuid" }
        ]
      },
      {
        name: "customer",
        columns: [{ name: "id", dataType: "uuid" }]
      }
    ]);

    return {
      ok: true,
      manifest,
      metadata,
      relations: buildRelationGraph([
        {
          name: "orders",
          columns: [
            { name: "id", dataType: "uuid" },
            { name: "customer_id", dataType: "uuid" }
          ]
        },
        {
          name: "customer",
          columns: [{ name: "id", dataType: "uuid" }]
        }
      ]),
      tools: toolRegistry.list().map((tool) => ({
        name: tool.name,
        description: tool.description
      })),
      security: authorizeAccess({
        role: "analyst",
        tenantId: "tenant-a",
        resourceTenantId: "tenant-a",
        action: "read"
      })
    };
  });

  app.post("/api/sql/validate", async (request) => {
    const body = request.body as { sql?: string };

    if (typeof body?.sql !== "string") {
      throw new AppError("sql is required", "SQL_REQUIRED", 400);
    }

    return validateSqlStatement(body.sql);
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

  app.post("/api/analysis/series", async (request) => {
    const body = request.body as { points?: readonly number[] };

    if (!Array.isArray(body?.points)) {
      throw new AppError("points are required", "POINTS_REQUIRED", 400);
    }

    return {
      summary: summarizeSeries(body.points)
    };
  });

  app.post("/api/charts/suggest", async (request) => {
    const body = request.body as {
      title?: string;
      labels?: readonly string[];
      values?: readonly number[];
      hasTimeAxis?: boolean;
    };

    if (
      typeof body?.title !== "string" ||
      !Array.isArray(body.labels) ||
      !Array.isArray(body.values) ||
      typeof body.hasTimeAxis !== "boolean"
    ) {
      throw new AppError("Invalid chart request", "INVALID_CHART_REQUEST", 400);
    }

    const kind = chooseChartKind({
      dimensions: body.labels,
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

