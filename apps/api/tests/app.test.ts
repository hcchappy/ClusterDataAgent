import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@clusterdata/shared";
import { ToolRegistry } from "@clusterdata/tool-system";
import { type ReadOnlyQueryExecutor } from "@clusterdata/database";
import {
  PrismaMetadataCatalogService,
  type PrismaSchemaCatalog
} from "@clusterdata/metadata-engine";
import {
  AgentExecutor,
  InMemorySessionStore,
  type ResponsesTransport
} from "@clusterdata/agent-core";
import { profileDataset } from "@clusterdata/analysis-service";
import { buildApi } from "../src/app.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("api", () => {
  it("returns health information", async () => {
    vi.stubEnv("API_HOST", "127.0.0.1");
    vi.stubEnv("API_PORT", "3001");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@localhost:5432/clusterdata"
    );

    const app = await buildApi();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await app.close();
  });

  it("validates SQL statements", async () => {
    vi.stubEnv("API_HOST", "127.0.0.1");
    vi.stubEnv("API_PORT", "3001");

    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select id, name from Tenant limit 20"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowed).toBe(true);
    expect(response.json().referencedTables).toEqual(["Tenant"]);
    expect(response.json().referencedColumns).toEqual(["id", "name"]);

    await app.close();
  });

  it("rejects oversized SQL validation requests", async () => {
    vi.stubEnv("API_MAX_SQL_CHARS", "20");

    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select id, name from Tenant limit 20"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SQL_TOO_LARGE");

    await app.close();
  });

  it("rejects SQL that references tables outside the prisma catalog", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select id from Orders limit 20"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      reason: "Unknown table references: Orders"
    });

    await app.close();
  });

  it("validates SQL joins with aliases through the API", async () => {
    const app = await buildApi({
      metadataCatalog: createCatalogWithTables([
        {
          name: "cda_customers",
          columns: [
            { name: "id", dataType: "integer" },
            { name: "name", dataType: "text" }
          ]
        },
        {
          name: "cda_orders",
          columns: [
            { name: "id", dataType: "integer" },
            { name: "customer_id", dataType: "integer" },
            { name: "amount", dataType: "numeric" }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: true,
      referencedTables: ["cda_orders", "cda_customers"],
      referencedColumns: ["o.id", "c.name", "o.customer_id", "c.id"],
      limit: 20
    });

    await app.close();
  });

  it("rejects unknown SQL columns through the API", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select missingColumn from Tenant limit 20"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false
    });
    expect(response.json().reason).toContain("Unknown column");

    await app.close();
  });

  it("returns real schema metadata in the overview", async () => {
    const app = await buildApi();
    const response = await app.inject({ method: "GET", url: "/api/overview" });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.metadata).toMatchObject({
      tableCount: 2,
      relationCount: 1
    });
    expect(payload.relations).toContainEqual({
      fromTable: "AuditLog",
      fromColumn: "tenantId",
      toTable: "Tenant",
      toColumn: "id"
    });
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toContain(
      "generate-sql"
    );

    await app.close();
  });

  it("suggests metadata-aware SQL from the prisma catalog", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/suggest",
      payload: {
        tableName: "AuditLog",
        columns: ["id", "tenantId", "action"],
        limit: 25
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sql: "select id, tenantId, action from AuditLog limit 25"
    });

    await app.close();
  });

  it("profiles analysis datasets through the API", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/profile",
      payload: {
        rows: [
          { region: "north", amount: 10, active: true },
          { region: "south", amount: 20, active: false },
          { region: "north", amount: 30, active: true }
        ]
      }
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.profile).toMatchObject({
      rowCount: 3,
      fieldCount: 3
    });
    expect(payload.profile.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "amount",
          kind: "number",
          minimum: 10,
          maximum: 30
        }),
        expect.objectContaining({
          name: "region",
          kind: "string",
          topValues: [
            { value: "north", count: 2 },
            { value: "south", count: 1 }
          ]
        })
      ])
    );

    await app.close();
  });

  it("analyzes time series through the API", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/time-series",
      payload: {
        points: [
          { timestamp: "2026-01-01T00:00:00.000Z", value: 1 },
          { timestamp: "2026-01-02T00:00:00.000Z", value: 1 },
          { timestamp: "2026-01-03T00:00:00.000Z", value: 1 },
          { timestamp: "2026-01-04T00:00:00.000Z", value: 10 }
        ],
        movingAverageWindow: 2,
        anomalyThreshold: 1.5
      }
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.analysis).toMatchObject({
      pointCount: 4,
      movingAverageWindow: 2,
      interval: {
        unit: "day",
        regular: true
      },
      change: {
        absolute: 9,
        direction: "up"
      }
    });
    expect(payload.analysis.anomalies).toEqual([
      expect.objectContaining({
        index: 3,
        value: 10,
        timestamp: "2026-01-04T00:00:00.000Z"
      })
    ]);

    await app.close();
  });

  it("rejects oversized analysis profile requests", async () => {
    vi.stubEnv("API_MAX_DATASET_ROWS", "1");

    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/profile",
      payload: {
        rows: [{ region: "north" }, { region: "south" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("DATASET_ROW_LIMIT_EXCEEDED");

    await app.close();
  });

  it("recommends charts from analysis profiles through the API", async () => {
    const app = await buildApi();
    const profile = profileDataset({
      rows: [
        { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10, region: "north" },
        { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20, region: "south" },
        { createdAt: "2026-01-03T00:00:00.000Z", revenue: 30, region: "north" }
      ]
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/charts/suggest",
      payload: {
        profile,
        maxRecommendations: 3
      }
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "line",
          title: "revenue over createdAt"
        })
      ])
    );

    await app.close();
  });

  it("keeps legacy chart suggestions working", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/charts/suggest",
      payload: {
        title: "Revenue",
        labels: ["Jan", "Feb"],
        values: [10, 20],
        hasTimeAxis: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "pie",
      option: {
        title: { text: "Revenue" }
      }
    });

    await app.close();
  });

  it("optimizes large legacy chart suggestions", async () => {
    const app = await buildApi();
    const labels = Array.from({ length: 240 }, (_unused, index) => `Day ${index + 1}`);
    const values = labels.map((_label, index) => index + 1);
    const response = await app.inject({
      method: "POST",
      url: "/api/charts/suggest",
      payload: {
        title: "Revenue",
        labels,
        values,
        hasTimeAxis: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "line",
      option: {
        meta: {
          originalPointCount: 240,
          sampled: true,
          strategy: "stride",
          interactiveZoom: true,
          progressive: true
        }
      }
    });
    expect(response.json().option.xAxis.data.length).toBeLessThanOrEqual(120);

    await app.close();
  });

  it("rejects invalid profile requests", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/profile",
      payload: {
        rows: []
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("EMPTY_DATASET");

    await app.close();
  });

  it("lists metadata tables from the runtime catalog", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata/tables"
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.summary).toMatchObject({
      tableCount: 2,
      relationCount: 1
    });
    expect(payload.tables.map((table: { name: string }) => table.name)).toEqual([
      "Tenant",
      "AuditLog"
    ]);

    await app.close();
  });

  it("returns one metadata table with related edges", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata/tables/audit_log"
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.table.name).toBe("AuditLog");
    expect(payload.table.columns.map((column: { name: string }) => column.name)).toContain(
      "tenantId"
    );
    expect(payload.relations).toContainEqual({
      fromTable: "AuditLog",
      fromColumn: "tenantId",
      toTable: "Tenant",
      toColumn: "id"
    });

    await app.close();
  });

  it("searches metadata from the runtime catalog", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata/search?q=tenant&limit=5"
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "table",
          tableName: "Tenant"
        }),
        expect.objectContaining({
          type: "column",
          tableName: "AuditLog",
          columnName: "tenantId"
        })
      ])
    );

    await app.close();
  });

  it("refreshes metadata and keeps sql tools bound to the latest catalog", async () => {
    const initialCatalog = createCatalog("InitialTable");
    const refreshedCatalog = createCatalog("RefreshedTable");
    const metadataService = new PrismaMetadataCatalogService({
      sourcePath: "test-schema.prisma",
      initialCatalog
    });

    vi.spyOn(metadataService, "refresh").mockResolvedValue(refreshedCatalog);

    const app = await buildApi({
      metadataCatalog: initialCatalog,
      metadataService
    });
    const refreshResponse = await app.inject({
      method: "POST",
      url: "/api/metadata/refresh"
    });
    const suggestResponse = await app.inject({
      method: "POST",
      url: "/api/sql/suggest",
      payload: {
        tableName: "RefreshedTable",
        columns: ["id"],
        limit: 10
      }
    });

    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json().summary.tableCount).toBe(1);
    expect(suggestResponse.statusCode).toBe(200);
    expect(suggestResponse.json()).toEqual({
      sql: "select id from RefreshedTable limit 10"
    });

    await app.close();
  });

  it("loads postgres metadata source through the configured catalog loader", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:aa@127.0.0.1:5433/clusterdata");
    vi.stubEnv("METADATA_SOURCE", "postgres");
    vi.stubEnv("POSTGRES_SCHEMA", "public");

    const loader = vi.fn(async (config) => {
      expect(config.metadataSource).toBe("postgres");
      expect(config.databaseUrl).toContain("5433");
      expect(config.postgresSchema).toBe("public");

      return createCatalog("LivePostgresTable");
    });
    const app = await buildApi({
      metadataCatalogLoader: loader
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata/tables"
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.json().tables).toEqual([
      {
        name: "LivePostgresTable",
        columns: [{ name: "id", dataType: "String" }]
      }
    ]);

    await app.close();
  });

  it("returns chat responses from the configured agent executor", async () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-test");

    const app = await buildApi({
      agentExecutor: createAgentExecutor([
        {
          id: "resp_chat",
          output_text: "Hello from agent",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from agent" }]
            }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-1",
        message: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      sessionId: "session-1",
      outputText: "Hello from agent"
    });

    await app.close();
  });

  it("rejects oversized chat messages before invoking the agent", async () => {
    vi.stubEnv("API_MAX_CHAT_MESSAGE_CHARS", "4");
    const agentExecutor = createAgentExecutor([
      {
        id: "unused",
        output_text: "unused",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "unused" }]
          }
        ]
      }
    ]);
    const app = await buildApi({
      agentExecutor
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-guard",
        message: "hello"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("CHAT_MESSAGE_TOO_LARGE");

    await app.close();
  });

  it("rejects invalid chat requests", async () => {
    const app = await buildApi({
      agentExecutor: createAgentExecutor([
        {
          id: "unused",
          output_text: "unused",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "unused" }]
            }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        message: "missing session"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_CHAT_REQUEST");

    await app.close();
  });

  it("streams SSE chat events", async () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-test");

    const app = await buildApi({
      agentExecutor: createAgentExecutor([
        {
          id: "resp_stream",
          output_text: "Streamed answer",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Streamed answer" }]
            }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        sessionId: "session-stream",
        message: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: session.started");
    expect(response.body).toContain("event: response.output_text.delta");
    expect(response.body).toContain("event: response.completed");

    await app.close();
  });

  it("streams tool call lifecycle events", async () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-test");

    const app = await buildApi({
      agentExecutor: createAgentExecutor([
        {
          id: "resp_tool",
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "validate-sql",
              arguments: "{\"sql\":\"select * from orders\"}"
            }
          ]
        },
        {
          id: "resp_done",
          output_text: "Safe query",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Safe query" }]
            }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        sessionId: "session-tool",
        message: "check query"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: tool.call.started");
    expect(response.body).toContain("event: tool.call.completed");

    await app.close();
  });

  it("does not duplicate streaming failure events", async () => {
    const transport: ResponsesTransport = {
      createResponse: vi.fn(async () => {
        throw new AppError("upstream busy", "UPSTREAM_BUSY", 503);
      })
    };
    const app = await buildApi({
      agentExecutor: new AgentExecutor({
        toolRegistry: createApiToolRegistry(),
        sessionStore: new InMemorySessionStore(),
        config: {
          apiKey: "test-key",
          apiEndpoint: "https://api.openai.com/v1",
          defaultModel: "gpt-test",
          requestTimeoutMs: 1000,
          maxToolCalls: 4,
          maxRetries: 0
        },
        transport
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        sessionId: "session-fail-once",
        message: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.match(/event: response\.failed/g)).toHaveLength(1);

    await app.close();
  });

  it("preserves cors headers for streaming requests", async () => {
    const app = await buildApi({
      agentExecutor: createAgentExecutor([
        {
          id: "resp_stream_cors",
          output_text: "Hello from cors",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from cors" }]
            }
          ]
        }
      ])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      headers: {
        origin: "http://127.0.0.1:3000"
      },
      payload: {
        sessionId: "session-cors",
        message: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:3000"
    );

    await app.close();
  });

  it("rejects invalid security roles through the API", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/security/check",
      payload: {
        role: "owner",
        tenantId: "tenant-a",
        resourceTenantId: "tenant-a",
        action: "read"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_SECURITY_ROLE");

    await app.close();
  });

  it("reports request security policy in the overview", async () => {
    vi.stubEnv("API_MAX_DATASET_ROWS", "123");

    const app = await buildApi();
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json().requestSecurity).toMatchObject({
      maxDatasetRows: 123,
      maxChatMessageChars: 8000
    });

    await app.close();
  });

  it("rejects oversized time series analysis requests", async () => {
    vi.stubEnv("API_MAX_SERIES_POINTS", "1");

    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/time-series",
      payload: {
        points: [
          { timestamp: "2026-01-01T00:00:00.000Z", value: 1 },
          { timestamp: "2026-01-02T00:00:00.000Z", value: 2 }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("TIME_SERIES_POINT_LIMIT_EXCEEDED");

    await app.close();
  });

  it("executes validated SQL queries through the API", async () => {
    const queryExecutor = createQueryExecutor({
      columns: ["id", "name"],
      rows: [
        { id: "tenant-a", name: "Tenant A" },
        { id: "tenant-b", name: "Tenant B" }
      ],
      rowCount: 2,
      durationMs: 12
    });
    const app = await buildApi({
      metadataCatalog: createCatalogWithTables([
        {
          name: "Tenant",
          columns: [
            { name: "id", dataType: "String" },
            { name: "name", dataType: "String" }
          ]
        }
      ]),
      queryExecutor
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/query",
      payload: {
        sql: "select id, name from Tenant limit 2"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      columns: ["id", "name"],
      rows: [
        { id: "tenant-a", name: "Tenant A" },
        { id: "tenant-b", name: "Tenant B" }
      ],
      rowCount: 2,
      durationMs: 12,
      validation: {
        allowed: true,
        normalizedSql: "select id, name from Tenant limit 2",
        referencedTables: ["Tenant"],
        referencedColumns: ["id", "name"],
        limit: 2
      }
    });

    await app.close();
  });

  it("rejects unsafe SQL query execution requests", async () => {
    const app = await buildApi({
      queryExecutor: createQueryExecutor({
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 5
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/query",
      payload: {
        sql: "delete from Tenant"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SQL_NOT_ALLOWED");

    await app.close();
  });

  it("reports unavailable SQL query execution when no database is configured", async () => {
    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/query",
      payload: {
        sql: "select id from Tenant limit 1"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("DATABASE_QUERY_NOT_CONFIGURED");

    await app.close();
  });

  it("reports file-backed agent memory when configured", async () => {
    const directoryPath = mkdtempSync(join(tmpdir(), "clusterdata-api-"));
    const sessionStorePath = join(directoryPath, "sessions.json");

    vi.stubEnv("AGENT_MEMORY_STORE_PATH", sessionStorePath);

    try {
      const app = await buildApi();
      const response = await app.inject({ method: "GET", url: "/api/overview" });

      expect(response.statusCode).toBe(200);
      expect(response.json().agent).toMatchObject({
        memoryStore: "file",
        memoryStorePath: sessionStorePath
      });
      expect(existsSync(sessionStorePath)).toBe(true);
      expect(JSON.parse(readFileSync(sessionStorePath, "utf8"))).toEqual({
        version: 1,
        sessions: {}
      });

      await app.close();
    } finally {
      rmSync(directoryPath, { recursive: true, force: true });
    }
  });
});

function createAgentExecutor(responses: readonly object[]): AgentExecutor {
  const transport = createTransport(responses);

  return new AgentExecutor({
    toolRegistry: createApiToolRegistry(),
    sessionStore: new InMemorySessionStore(),
    config: {
      apiKey: "test-key",
      apiEndpoint: "https://api.openai.com/v1",
      defaultModel: "gpt-test",
      requestTimeoutMs: 1000,
      maxToolCalls: 4,
      maxRetries: 0
    },
    transport
  });
}

function createApiToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
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
    execute: ({ sql }: { sql: string }) => ({
      allowed: true,
      normalizedSql: sql
    })
  });

  return registry;
}

function createTransport(responses: readonly object[]): ResponsesTransport {
  const queue = [...responses];

  return {
    createResponse: vi.fn(async () => {
      const next = queue.shift();

      if (!next) {
        throw new AppError("no mocked response", "MOCK_TRANSPORT_EMPTY", 500);
      }

      return next as never;
    })
  };
}

function createQueryExecutor(
  result: Awaited<ReturnType<ReadOnlyQueryExecutor["executeReadOnlyQuery"]>>
): ReadOnlyQueryExecutor {
  return {
    executeReadOnlyQuery: vi.fn(async () => result)
  };
}

function createCatalog(tableName: string): PrismaSchemaCatalog {
  return createCatalogWithTables([
    {
      name: tableName,
      columns: [{ name: "id", dataType: "String" }]
    }
  ]);
}

function createCatalogWithTables(
  tables: PrismaSchemaCatalog["tables"]
): PrismaSchemaCatalog {
  return {
    sourcePath: "test-schema.prisma",
    loadedAt: new Date(0).toISOString(),
    models: tables.map((table) => ({
      name: table.name,
      fields: table.columns.map((column) => ({
        name: column.name,
        type: column.dataType,
        isOptional: false,
        isList: false
      }))
    })),
    tables,
    relations: [],
    summary: {
      tableCount: tables.length,
      columnCount: tables.reduce((total, table) => total + table.columns.length, 0),
      relationCount: 0
    }
  };
}

