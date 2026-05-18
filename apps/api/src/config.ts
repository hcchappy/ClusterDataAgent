import { z } from "zod";
import {
  DEFAULT_REQUEST_SECURITY_POLICY,
  DEFAULT_SQL_READ_ACCESS_POLICY,
  buildSqlReadAccessPolicy,
  type SqlReadAccessPolicy,
  type UserRole
} from "@clusterdata/security";
import { AppError } from "@clusterdata/shared";

const ConfigSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().optional().default(""),
  METADATA_SOURCE: z.enum(["prisma", "postgres"]).default("prisma"),
  POSTGRES_SCHEMA: z.string().min(1).default("public"),
  SEMANTIC_CATALOG_PATH: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_ENDPOINT: z.string().min(1).default("https://kuangquanshui.work.gd/v1/"),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(6),
  AGENT_ALLOWED_TOOLS: z.string().optional().default(""),
  AGENT_BLOCKED_TOOLS: z.string().optional().default(""),
  AGENT_MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().default(12_000),
  AGENT_MEMORY_LIMIT: z.coerce.number().int().positive().default(20),
  AGENT_MEMORY_STORE_PATH: z.string().optional().default(""),
  OPERATOR_API_KEY: z.string().optional().default(""),
  SQL_ACCESS_DEFAULT_ROLE: z
    .enum(["admin", "analyst", "viewer"])
    .default(DEFAULT_SQL_READ_ACCESS_POLICY.defaultRole),
  SQL_ADMIN_ALLOWED_TABLES: z.string().default("*"),
  SQL_ANALYST_ALLOWED_TABLES: z
    .string()
    .default(defaultAllowedTablesValue(DEFAULT_SQL_READ_ACCESS_POLICY.roles.analyst.allowedTables)),
  SQL_VIEWER_ALLOWED_TABLES: z
    .string()
    .default(defaultAllowedTablesValue(DEFAULT_SQL_READ_ACCESS_POLICY.roles.viewer.allowedTables)),
  SQL_ADMIN_BLOCKED_COLUMNS: z.string().default(""),
  SQL_ANALYST_BLOCKED_COLUMNS: z.string().default(""),
  SQL_VIEWER_BLOCKED_COLUMNS: z
    .string()
    .default(DEFAULT_SQL_READ_ACCESS_POLICY.roles.viewer.blockedColumns.join(",")),
  SQL_QUERY_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  SQL_QUERY_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(100),
  SQL_ASYNC_JOB_TTL_MS: z.coerce.number().int().positive().default(900_000),
  SQL_ASYNC_JOB_MAX_ENTRIES: z.coerce.number().int().positive().default(100),
  API_MAX_SESSION_ID_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSessionIdChars),
  API_MAX_SESSION_TITLE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSessionTitleChars),
  API_MAX_SESSION_TAGS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSessionTags),
  API_MAX_SESSION_TAG_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSessionTagChars),
  API_MAX_CHAT_MESSAGE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxChatMessageChars),
  API_MAX_MODEL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxModelChars),
  API_MAX_SQL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSqlChars),
  API_MAX_IDENTIFIER_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxIdentifierChars),
  API_MAX_SQL_SUGGEST_COLUMNS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSuggestedColumns),
  API_MAX_SERIES_POINTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxSeriesPoints),
  API_MAX_DATASET_ROWS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxDatasetRows),
  API_MAX_DATASET_FIELDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxDatasetFields),
  API_MAX_DATASET_CELL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxDatasetCellChars),
  API_MAX_CHART_DATA_POINTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxChartDataPoints),
  API_MAX_METADATA_SEARCH_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxMetadataSearchChars),
  API_MAX_METADATA_SEARCH_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxMetadataSearchLimit),
  API_MAX_CHART_RECOMMENDATIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_SECURITY_POLICY.maxChartRecommendations),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_RATE_LIMIT_MAX_CHAT_REQUESTS: z.coerce.number().int().positive().default(20),
  API_RATE_LIMIT_MAX_OPERATOR_REQUESTS: z.coerce.number().int().positive().default(30),
  API_RATE_LIMIT_MAX_SQL_REQUESTS: z.coerce.number().int().positive().default(15)
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly metadataSource: "prisma" | "postgres";
  readonly postgresSchema: string;
  readonly semanticCatalogPath: string;
  readonly openAiApiKey: string;
  readonly openAiEndpoint: string;
  readonly openAiModel: string;
  readonly openAiTimeoutMs: number;
  readonly agentMaxToolCalls: number;
  readonly agentAllowedTools: readonly string[];
  readonly agentBlockedTools: readonly string[];
  readonly agentMaxToolResultChars: number;
  readonly agentMemoryLimit: number;
  readonly agentMemoryStorePath: string;
  readonly operatorApiKey: string;
  readonly sqlAccess: SqlReadAccessPolicy;
  readonly sqlQueryExecution: {
    readonly cacheTtlMs: number;
    readonly cacheMaxEntries: number;
    readonly asyncJobTtlMs: number;
    readonly asyncJobMaxEntries: number;
  };
  readonly requestSecurity: {
    readonly maxSessionIdChars: number;
    readonly maxSessionTitleChars: number;
    readonly maxSessionTags: number;
    readonly maxSessionTagChars: number;
    readonly maxChatMessageChars: number;
    readonly maxModelChars: number;
    readonly maxSqlChars: number;
    readonly maxIdentifierChars: number;
    readonly maxSuggestedColumns: number;
    readonly maxSeriesPoints: number;
    readonly maxDatasetRows: number;
    readonly maxDatasetFields: number;
    readonly maxDatasetCellChars: number;
    readonly maxChartDataPoints: number;
    readonly maxMetadataSearchChars: number;
    readonly maxMetadataSearchLimit: number;
    readonly maxChartRecommendations: number;
  };
  readonly rateLimit: {
    readonly windowMs: number;
    readonly maxChatRequests: number;
    readonly maxOperatorRequests: number;
    readonly maxSqlRequests: number;
  };
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = ConfigSchema.safeParse(env);

  if (!parsed.success) {
    throw new AppError("Invalid API configuration", "INVALID_API_CONFIG", 500, {
      issues: parsed.error.issues
    });
  }

  return {
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    metadataSource: parsed.data.METADATA_SOURCE,
    postgresSchema: parsed.data.POSTGRES_SCHEMA,
    semanticCatalogPath: parsed.data.SEMANTIC_CATALOG_PATH,
    openAiApiKey: parsed.data.OPENAI_API_KEY,
    openAiEndpoint: parsed.data.OPENAI_ENDPOINT,
    openAiModel: parsed.data.OPENAI_MODEL,
    openAiTimeoutMs: parsed.data.OPENAI_TIMEOUT_MS,
    agentMaxToolCalls: parsed.data.AGENT_MAX_TOOL_CALLS,
    agentAllowedTools: parseCsvList(parsed.data.AGENT_ALLOWED_TOOLS),
    agentBlockedTools: parseCsvList(parsed.data.AGENT_BLOCKED_TOOLS),
    agentMaxToolResultChars: parsed.data.AGENT_MAX_TOOL_RESULT_CHARS,
    agentMemoryLimit: parsed.data.AGENT_MEMORY_LIMIT,
    agentMemoryStorePath: parsed.data.AGENT_MEMORY_STORE_PATH,
    operatorApiKey: parsed.data.OPERATOR_API_KEY,
    sqlAccess: buildSqlReadAccessPolicy({
      defaultRole: parsed.data.SQL_ACCESS_DEFAULT_ROLE as UserRole,
      roles: {
        admin: {
          allowedTables: parseSqlAllowedTables(parsed.data.SQL_ADMIN_ALLOWED_TABLES),
          blockedColumns: parseSqlPermissionList(parsed.data.SQL_ADMIN_BLOCKED_COLUMNS)
        },
        analyst: {
          allowedTables: parseSqlAllowedTables(parsed.data.SQL_ANALYST_ALLOWED_TABLES),
          blockedColumns: parseSqlPermissionList(parsed.data.SQL_ANALYST_BLOCKED_COLUMNS)
        },
        viewer: {
          allowedTables: parseSqlAllowedTables(parsed.data.SQL_VIEWER_ALLOWED_TABLES),
          blockedColumns: parseSqlPermissionList(parsed.data.SQL_VIEWER_BLOCKED_COLUMNS)
        }
      }
    }),
    sqlQueryExecution: {
      cacheTtlMs: parsed.data.SQL_QUERY_CACHE_TTL_MS,
      cacheMaxEntries: parsed.data.SQL_QUERY_CACHE_MAX_ENTRIES,
      asyncJobTtlMs: parsed.data.SQL_ASYNC_JOB_TTL_MS,
      asyncJobMaxEntries: parsed.data.SQL_ASYNC_JOB_MAX_ENTRIES
    },
    requestSecurity: {
      maxSessionIdChars: parsed.data.API_MAX_SESSION_ID_CHARS,
      maxSessionTitleChars: parsed.data.API_MAX_SESSION_TITLE_CHARS,
      maxSessionTags: parsed.data.API_MAX_SESSION_TAGS,
      maxSessionTagChars: parsed.data.API_MAX_SESSION_TAG_CHARS,
      maxChatMessageChars: parsed.data.API_MAX_CHAT_MESSAGE_CHARS,
      maxModelChars: parsed.data.API_MAX_MODEL_CHARS,
      maxSqlChars: parsed.data.API_MAX_SQL_CHARS,
      maxIdentifierChars: parsed.data.API_MAX_IDENTIFIER_CHARS,
      maxSuggestedColumns: parsed.data.API_MAX_SQL_SUGGEST_COLUMNS,
      maxSeriesPoints: parsed.data.API_MAX_SERIES_POINTS,
      maxDatasetRows: parsed.data.API_MAX_DATASET_ROWS,
      maxDatasetFields: parsed.data.API_MAX_DATASET_FIELDS,
      maxDatasetCellChars: parsed.data.API_MAX_DATASET_CELL_CHARS,
      maxChartDataPoints: parsed.data.API_MAX_CHART_DATA_POINTS,
      maxMetadataSearchChars: parsed.data.API_MAX_METADATA_SEARCH_CHARS,
      maxMetadataSearchLimit: parsed.data.API_MAX_METADATA_SEARCH_LIMIT,
      maxChartRecommendations: parsed.data.API_MAX_CHART_RECOMMENDATIONS
    },
    rateLimit: {
      windowMs: parsed.data.API_RATE_LIMIT_WINDOW_MS,
      maxChatRequests: parsed.data.API_RATE_LIMIT_MAX_CHAT_REQUESTS,
      maxOperatorRequests: parsed.data.API_RATE_LIMIT_MAX_OPERATOR_REQUESTS,
      maxSqlRequests: parsed.data.API_RATE_LIMIT_MAX_SQL_REQUESTS
    }
  };
}

function parseSqlAllowedTables(value: string): "*" | readonly string[] {
  if (value.trim() === "*") {
    return "*";
  }

  return parseSqlPermissionList(value);
}

function parseSqlPermissionList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function defaultAllowedTablesValue(value: "*" | readonly string[]): string {
  return value === "*" ? "*" : value.join(",");
}

function parseCsvList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

