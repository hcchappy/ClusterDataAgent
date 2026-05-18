import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.js";

describe("api config", () => {
  it("loads chat endpoint settings from the environment", () => {
    const config = loadApiConfig({
      API_HOST: "0.0.0.0",
      API_PORT: "3100",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/clusterdata",
      METADATA_SOURCE: "postgres",
      POSTGRES_SCHEMA: "analytics",
      SEMANTIC_CATALOG_PATH: "packages/database/semantic/postgres-catalog.json",
      OPENAI_API_KEY: "test-key",
      OPENAI_ENDPOINT: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "openai/gpt-4.1-mini",
      OPENAI_TIMEOUT_MS: "45000",
      AGENT_MAX_TOOL_CALLS: "8",
      AGENT_ALLOWED_TOOLS: "search-metadata,query-sql",
      AGENT_BLOCKED_TOOLS: "suggest-chart",
      AGENT_MAX_TOOL_RESULT_CHARS: "16000",
      AGENT_MEMORY_LIMIT: "24",
      AGENT_MEMORY_STORE_PATH: ".codex/data/sessions.json",
      OPERATOR_API_KEY: "secret-operator",
      SQL_ACCESS_DEFAULT_ROLE: "viewer",
      SQL_VIEWER_ALLOWED_TABLES: "Tenant,AuditLog",
      SQL_VIEWER_BLOCKED_COLUMNS: "AuditLog.action",
      SQL_QUERY_CACHE_TTL_MS: "450000",
      SQL_QUERY_CACHE_MAX_ENTRIES: "44",
      SQL_ASYNC_JOB_TTL_MS: "1200000",
      SQL_ASYNC_JOB_MAX_ENTRIES: "55",
      API_MAX_SESSION_TITLE_CHARS: "80",
      API_MAX_SESSION_TAGS: "4",
      API_MAX_SESSION_TAG_CHARS: "20",
      API_MAX_CHAT_MESSAGE_CHARS: "9000",
      API_MAX_DATASET_ROWS: "250",
      API_MAX_SQL_CHARS: "12000",
      API_RATE_LIMIT_WINDOW_MS: "30000",
      API_RATE_LIMIT_MAX_CHAT_REQUESTS: "12",
      API_RATE_LIMIT_MAX_OPERATOR_REQUESTS: "8",
      API_RATE_LIMIT_MAX_SQL_REQUESTS: "5"
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3100);
    expect(config.metadataSource).toBe("postgres");
    expect(config.postgresSchema).toBe("analytics");
    expect(config.semanticCatalogPath).toBe("packages/database/semantic/postgres-catalog.json");
    expect(config.openAiApiKey).toBe("test-key");
    expect(config.openAiEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(config.openAiModel).toBe("openai/gpt-4.1-mini");
    expect(config.openAiTimeoutMs).toBe(45_000);
    expect(config.agentMaxToolCalls).toBe(8);
    expect(config.agentAllowedTools).toEqual(["search-metadata", "query-sql"]);
    expect(config.agentBlockedTools).toEqual(["suggest-chart"]);
    expect(config.agentMaxToolResultChars).toBe(16_000);
    expect(config.agentMemoryLimit).toBe(24);
    expect(config.agentMemoryStorePath).toBe(".codex/data/sessions.json");
    expect(config.operatorApiKey).toBe("secret-operator");
    expect(config.sqlAccess.defaultRole).toBe("viewer");
    expect(config.sqlAccess.roles.viewer).toEqual({
      allowedTables: ["Tenant", "AuditLog"],
      blockedColumns: ["AuditLog.action"]
    });
    expect(config.sqlQueryExecution).toEqual({
      cacheTtlMs: 450_000,
      cacheMaxEntries: 44,
      asyncJobTtlMs: 1_200_000,
      asyncJobMaxEntries: 55
    });
    expect(config.requestSecurity.maxSessionTitleChars).toBe(80);
    expect(config.requestSecurity.maxSessionTags).toBe(4);
    expect(config.requestSecurity.maxSessionTagChars).toBe(20);
    expect(config.requestSecurity.maxChatMessageChars).toBe(9_000);
    expect(config.requestSecurity.maxDatasetRows).toBe(250);
    expect(config.requestSecurity.maxSqlChars).toBe(12_000);
    expect(config.rateLimit).toEqual({
      windowMs: 30_000,
      maxChatRequests: 12,
      maxOperatorRequests: 8,
      maxSqlRequests: 5
    });
  });

  it("falls back to default endpoint values", () => {
    const config = loadApiConfig({});

    expect(config.openAiEndpoint).toBe("https://kuangquanshui.work.gd/v1/");
    expect(config.openAiModel).toBe("gpt-5.4");
    expect(config.openAiTimeoutMs).toBe(30_000);
    expect(config.metadataSource).toBe("prisma");
    expect(config.postgresSchema).toBe("public");
    expect(config.semanticCatalogPath).toBe("");
    expect(config.agentAllowedTools).toEqual([]);
    expect(config.agentBlockedTools).toEqual([]);
    expect(config.agentMaxToolResultChars).toBe(12_000);
    expect(config.agentMemoryStorePath).toBe("");
    expect(config.operatorApiKey).toBe("");
    expect(config.sqlAccess.defaultRole).toBe("analyst");
    expect(config.sqlAccess.roles.viewer).toEqual({
      allowedTables: ["Tenant"],
      blockedColumns: ["Tenant.createdAt"]
    });
    expect(config.sqlQueryExecution).toEqual({
      cacheTtlMs: 300_000,
      cacheMaxEntries: 100,
      asyncJobTtlMs: 900_000,
      asyncJobMaxEntries: 100
    });
    expect(config.requestSecurity.maxSessionTitleChars).toBe(120);
    expect(config.requestSecurity.maxSessionTags).toBe(8);
    expect(config.requestSecurity.maxSessionTagChars).toBe(32);
    expect(config.requestSecurity.maxChatMessageChars).toBe(8_000);
    expect(config.requestSecurity.maxDatasetRows).toBe(1_000);
    expect(config.requestSecurity.maxSqlChars).toBe(20_000);
    expect(config.rateLimit).toEqual({
      windowMs: 60_000,
      maxChatRequests: 20,
      maxOperatorRequests: 30,
      maxSqlRequests: 15
    });
  });
});
