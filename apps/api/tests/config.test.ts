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
      OPENAI_API_KEY: "test-key",
      OPENAI_ENDPOINT: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "openai/gpt-4.1-mini",
      OPENAI_TIMEOUT_MS: "45000",
      AGENT_MAX_TOOL_CALLS: "8",
      AGENT_MEMORY_LIMIT: "24",
      AGENT_MEMORY_STORE_PATH: ".codex/data/sessions.json",
      SQL_ACCESS_DEFAULT_ROLE: "viewer",
      SQL_VIEWER_ALLOWED_TABLES: "Tenant,AuditLog",
      SQL_VIEWER_BLOCKED_COLUMNS: "AuditLog.action",
      API_MAX_CHAT_MESSAGE_CHARS: "9000",
      API_MAX_DATASET_ROWS: "250",
      API_MAX_SQL_CHARS: "12000"
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3100);
    expect(config.metadataSource).toBe("postgres");
    expect(config.postgresSchema).toBe("analytics");
    expect(config.openAiApiKey).toBe("test-key");
    expect(config.openAiEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(config.openAiModel).toBe("openai/gpt-4.1-mini");
    expect(config.openAiTimeoutMs).toBe(45_000);
    expect(config.agentMaxToolCalls).toBe(8);
    expect(config.agentMemoryLimit).toBe(24);
    expect(config.agentMemoryStorePath).toBe(".codex/data/sessions.json");
    expect(config.sqlAccess.defaultRole).toBe("viewer");
    expect(config.sqlAccess.roles.viewer).toEqual({
      allowedTables: ["Tenant", "AuditLog"],
      blockedColumns: ["AuditLog.action"]
    });
    expect(config.requestSecurity.maxChatMessageChars).toBe(9_000);
    expect(config.requestSecurity.maxDatasetRows).toBe(250);
    expect(config.requestSecurity.maxSqlChars).toBe(12_000);
  });

  it("falls back to default endpoint values", () => {
    const config = loadApiConfig({});

    expect(config.openAiEndpoint).toBe("https://api.openai.com/v1");
    expect(config.openAiModel).toBe("gpt-4.1-mini");
    expect(config.openAiTimeoutMs).toBe(30_000);
    expect(config.metadataSource).toBe("prisma");
    expect(config.postgresSchema).toBe("public");
    expect(config.agentMemoryStorePath).toBe("");
    expect(config.sqlAccess.defaultRole).toBe("analyst");
    expect(config.sqlAccess.roles.viewer).toEqual({
      allowedTables: ["Tenant"],
      blockedColumns: ["Tenant.createdAt"]
    });
    expect(config.requestSecurity.maxChatMessageChars).toBe(8_000);
    expect(config.requestSecurity.maxDatasetRows).toBe(1_000);
    expect(config.requestSecurity.maxSqlChars).toBe(20_000);
  });
});
