import { AppError, createLogger } from "@clusterdata/shared";

export type UserRole = "admin" | "analyst" | "viewer";
export type AccessAction = "read" | "write" | "delete";
export type SecurityAuditStatus = "completed" | "blocked" | "failed";

const logger = createLogger("security");
const auditLogger = createLogger("security.audit");
const USER_ROLES = ["admin", "analyst", "viewer"] as const;
const ACCESS_ACTIONS = ["read", "write", "delete"] as const;
const PROMPT_INJECTION_RULES = [
  {
    code: "IGNORE_PRIOR_INSTRUCTIONS",
    pattern:
      /\bignore\b[\s\S]{0,40}\b(previous|prior|above|earlier)\b[\s\S]{0,20}\b(instructions?|prompts?|messages?)\b/i
  },
  {
    code: "REVEAL_SYSTEM_PROMPT",
    pattern:
      /\b(reveal|show|print|display|dump|expose)\b[\s\S]{0,50}\b(system|developer)\b[\s\S]{0,20}\b(prompt|message|instructions?)\b/i
  },
  {
    code: "BYPASS_GUARDRAILS",
    pattern:
      /\b(bypass|disable|override)\b[\s\S]{0,30}\b(guardrails?|filters?|safety|restrictions?)\b/i
  },
  {
    code: "ROLE_SYSTEM_OVERRIDE",
    pattern: /(^|[\s([{,])role\s*:\s*system\b/i
  },
  {
    code: "ACT_AS_SYSTEM",
    pattern: /\b(act as|pretend to be)\b[\s\S]{0,20}\b(system|developer)\b/i
  }
] as const;

export interface AccessRequest {
  readonly role: UserRole;
  readonly tenantId: string;
  readonly resourceTenantId: string;
  readonly action: AccessAction;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

export interface PromptInjectionAssessment {
  readonly blocked: boolean;
  readonly riskLevel: "none" | "high";
  readonly matchedSignals: readonly string[];
}

export interface SecurityAuditEvent {
  readonly action: string;
  readonly status: SecurityAuditStatus;
  readonly requestId?: string;
  readonly route?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SqlReadRolePolicy {
  readonly allowedTables: "*" | readonly string[];
  readonly blockedColumns: readonly string[];
}

export interface SqlReadAccessPolicy {
  readonly defaultRole: UserRole;
  readonly roles: Readonly<Record<UserRole, SqlReadRolePolicy>>;
}

export interface SqlReadAccessRequest {
  readonly role?: UserRole;
  readonly referencedTables: readonly string[];
  readonly referencedColumns?: readonly string[];
}

export interface SqlReadAccessDecision {
  readonly allowed: boolean;
  readonly role: UserRole;
  readonly reason?: string;
  readonly code?: string;
  readonly deniedTables?: readonly string[];
  readonly deniedColumns?: readonly string[];
}

export interface RequestSecurityPolicy {
  readonly maxSessionIdChars: number;
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
}

export const DEFAULT_REQUEST_SECURITY_POLICY: RequestSecurityPolicy = {
  maxSessionIdChars: 128,
  maxChatMessageChars: 8_000,
  maxModelChars: 128,
  maxSqlChars: 20_000,
  maxIdentifierChars: 128,
  maxSuggestedColumns: 100,
  maxSeriesPoints: 5_000,
  maxDatasetRows: 1_000,
  maxDatasetFields: 100,
  maxDatasetCellChars: 4_000,
  maxChartDataPoints: 5_000,
  maxMetadataSearchChars: 200,
  maxMetadataSearchLimit: 100,
  maxChartRecommendations: 20
};

export const DEFAULT_SQL_READ_ACCESS_POLICY: SqlReadAccessPolicy = {
  defaultRole: "analyst",
  roles: {
    admin: {
      allowedTables: "*",
      blockedColumns: []
    },
    analyst: {
      allowedTables: "*",
      blockedColumns: []
    },
    viewer: {
      allowedTables: ["Tenant"],
      blockedColumns: ["Tenant.createdAt"]
    }
  }
};

export function buildRequestSecurityPolicy(
  overrides: Partial<RequestSecurityPolicy> = {}
): RequestSecurityPolicy {
  const policy = {
    ...DEFAULT_REQUEST_SECURITY_POLICY,
    ...overrides
  };

  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AppError("Invalid request security policy", "INVALID_SECURITY_POLICY", 500, {
        name,
        value
      });
    }
  }

  return policy;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && USER_ROLES.includes(value as UserRole);
}

export function isAccessAction(value: unknown): value is AccessAction {
  return typeof value === "string" && ACCESS_ACTIONS.includes(value as AccessAction);
}

export function authorizeAccess(request: AccessRequest): AccessDecision {
  if (!isUserRole(request.role)) {
    return {
      allowed: false,
      reason: "Invalid user role",
      code: "INVALID_USER_ROLE"
    };
  }

  if (!isAccessAction(request.action)) {
    return {
      allowed: false,
      reason: "Invalid access action",
      code: "INVALID_ACCESS_ACTION"
    };
  }

  if (request.tenantId !== request.resourceTenantId) {
    return {
      allowed: false,
      reason: "Tenant isolation denied access",
      code: "TENANT_ISOLATION_DENIED"
    };
  }

  if (request.action !== "read" && request.role === "viewer") {
    return {
      allowed: false,
      reason: "Viewer role is read-only",
      code: "VIEWER_READ_ONLY"
    };
  }

  if (request.action === "delete" && request.role !== "admin") {
    return {
      allowed: false,
      reason: "Only admin can delete",
      code: "ADMIN_REQUIRED_FOR_DELETE"
    };
  }

  return { allowed: true };
}

export function assertAccess(request: AccessRequest): void {
  const decision = authorizeAccess(request);

  if (!decision.allowed) {
    const statusCode =
      decision.code === "INVALID_USER_ROLE" || decision.code === "INVALID_ACCESS_ACTION"
        ? 400
        : 403;

    logger.warn("access denied", {
      code: decision.code,
      role: request.role,
      action: request.action,
      tenantId: request.tenantId,
      resourceTenantId: request.resourceTenantId
    });

    throw new AppError(
      decision.reason ?? "Access denied",
      decision.code ?? "ACCESS_DENIED",
      statusCode
    );
  }
}

export function assertAccessRequestInput(
  input: {
    readonly role?: unknown;
    readonly tenantId?: unknown;
    readonly resourceTenantId?: unknown;
    readonly action?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): asserts input is AccessRequest {
  if (!isUserRole(input.role)) {
    rejectSecurityInput("Invalid security role", "INVALID_SECURITY_ROLE", {
      allowedRoles: USER_ROLES
    });
  }

  assertBoundedText(input.tenantId, "tenantId", policy.maxIdentifierChars);
  assertBoundedText(
    input.resourceTenantId,
    "resourceTenantId",
    policy.maxIdentifierChars
  );

  if (!isAccessAction(input.action)) {
    rejectSecurityInput("Invalid security action", "INVALID_SECURITY_ACTION", {
      allowedActions: ACCESS_ACTIONS
    });
  }
}

export function assertChatRequestSecurity(
  input: {
    readonly sessionId?: unknown;
    readonly message?: unknown;
    readonly model?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  assertBoundedText(input.sessionId, "sessionId", policy.maxSessionIdChars, "SESSION_ID_TOO_LARGE");
  assertBoundedText(input.message, "message", policy.maxChatMessageChars, "CHAT_MESSAGE_TOO_LARGE");

  if (typeof input.model !== "undefined") {
    assertBoundedText(input.model, "model", policy.maxModelChars, "MODEL_NAME_TOO_LARGE");
  }

  const promptInjectionAssessment = assessPromptInjection(String(input.message));

  if (promptInjectionAssessment.blocked) {
    rejectSecurityInput(
      "Chat message looks like a prompt injection attempt",
      "PROMPT_INJECTION_DETECTED",
      {
        matchedSignals: promptInjectionAssessment.matchedSignals,
        riskLevel: promptInjectionAssessment.riskLevel
      }
    );
  }
}

export function buildSqlReadAccessPolicy(
  overrides: Partial<{
    readonly defaultRole: UserRole;
    readonly roles: Partial<
      Record<
        UserRole,
        Partial<{
          readonly allowedTables: "*" | readonly string[];
          readonly blockedColumns: readonly string[];
        }>
      >
    >;
  }> = {}
): SqlReadAccessPolicy {
  const defaultRole = overrides.defaultRole ?? DEFAULT_SQL_READ_ACCESS_POLICY.defaultRole;

  if (!isUserRole(defaultRole)) {
    throw new AppError("Invalid SQL access default role", "INVALID_SQL_ACCESS_POLICY", 500, {
      defaultRole
    });
  }

  const roles = Object.fromEntries(
    USER_ROLES.map((role) => {
      const roleOverrides = overrides.roles?.[role] ?? {};
      const defaultPolicy = DEFAULT_SQL_READ_ACCESS_POLICY.roles[role];
      const allowedTables = roleOverrides.allowedTables ?? defaultPolicy.allowedTables;
      const blockedColumns = roleOverrides.blockedColumns ?? defaultPolicy.blockedColumns;

      return [
        role,
        {
          allowedTables: normalizeAllowedTablesPolicy(role, allowedTables),
          blockedColumns: normalizePermissionList(role, blockedColumns, "blockedColumns")
        }
      ];
    })
  ) as Record<UserRole, SqlReadRolePolicy>;

  return {
    defaultRole,
    roles
  };
}

export function authorizeSqlReadAccess(
  request: SqlReadAccessRequest,
  policy = DEFAULT_SQL_READ_ACCESS_POLICY
): SqlReadAccessDecision {
  const role = request.role ?? policy.defaultRole;

  if (!isUserRole(role)) {
    return {
      allowed: false,
      role: policy.defaultRole,
      reason: "Invalid SQL access role",
      code: "INVALID_SQL_ACCESS_ROLE"
    };
  }

  const rolePolicy = policy.roles[role];
  const normalizedAllowedTables =
    rolePolicy.allowedTables === "*"
      ? "*"
      : new Set(rolePolicy.allowedTables.map((tableName) => canonicalSqlPermissionName(tableName)));
  const deniedTables =
    normalizedAllowedTables === "*"
      ? []
      : dedupePermissionList(
          request.referencedTables.filter(
            (tableName) =>
              !normalizedAllowedTables.has(canonicalSqlPermissionName(tableName))
          )
        );

  if (deniedTables.length > 0) {
    return {
      allowed: false,
      role,
      reason: `Role ${role} cannot read tables: ${deniedTables.join(", ")}`,
      code: "SQL_TABLE_ACCESS_DENIED",
      deniedTables
    };
  }

  const blockedColumns = new Set(
    rolePolicy.blockedColumns.map((columnName) => canonicalSqlPermissionName(columnName))
  );
  const deniedColumns = dedupePermissionList(
    (request.referencedColumns ?? []).filter((columnName) =>
      blockedColumns.has(canonicalSqlPermissionName(columnName))
    )
  );

  if (deniedColumns.length > 0) {
    return {
      allowed: false,
      role,
      reason: `Role ${role} cannot read columns: ${deniedColumns.join(", ")}`,
      code: "SQL_COLUMN_ACCESS_DENIED",
      deniedColumns
    };
  }

  return {
    allowed: true,
    role
  };
}

export function assertSqlReadAccess(
  request: SqlReadAccessRequest,
  policy = DEFAULT_SQL_READ_ACCESS_POLICY
): void {
  const decision = authorizeSqlReadAccess(request, policy);

  if (decision.allowed) {
    return;
  }

  const statusCode = decision.code === "INVALID_SQL_ACCESS_ROLE" ? 400 : 403;

  logger.warn("sql read access denied", {
    code: decision.code,
    role: decision.role,
    deniedTables: decision.deniedTables,
    deniedColumns: decision.deniedColumns,
    referencedTables: request.referencedTables,
    referencedColumns: request.referencedColumns
  });

  throw new AppError(
    decision.reason ?? "SQL read access denied",
    decision.code ?? "SQL_ACCESS_DENIED",
    statusCode,
    {
      role: decision.role,
      deniedTables: decision.deniedTables,
      deniedColumns: decision.deniedColumns
    }
  );
}

export function assertSqlRoleRequestInput(input: {
  readonly role?: unknown;
}): asserts input is { readonly role?: UserRole } {
  if (typeof input.role === "undefined") {
    return;
  }

  if (!isUserRole(input.role)) {
    rejectSecurityInput("Invalid SQL access role", "INVALID_SQL_ACCESS_ROLE", {
      allowedRoles: USER_ROLES
    });
  }
}

export function assertSqlRequestSecurity(
  input: {
    readonly sql?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  assertBoundedText(input.sql, "sql", policy.maxSqlChars, "SQL_TOO_LARGE");

  if (typeof input.sql === "string" && input.sql.includes("\0")) {
    rejectSecurityInput("SQL cannot contain null bytes", "SQL_CONTAINS_NULL_BYTE");
  }
}

export function assertSqlSuggestionRequestSecurity(
  input: {
    readonly tableName?: unknown;
    readonly columns?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  assertBoundedText(input.tableName, "tableName", policy.maxIdentifierChars, "TABLE_NAME_TOO_LARGE");

  if (typeof input.columns === "undefined") {
    return;
  }

  if (!Array.isArray(input.columns)) {
    rejectSecurityInput("columns must be an array", "INVALID_COLUMNS");
  }

  if (input.columns.length > policy.maxSuggestedColumns) {
    rejectSecurityInput("Too many SQL columns requested", "SQL_COLUMN_LIMIT_EXCEEDED", {
      count: input.columns.length,
      limit: policy.maxSuggestedColumns
    });
  }

  for (const column of input.columns) {
    assertBoundedText(column, "column", policy.maxIdentifierChars, "COLUMN_NAME_TOO_LARGE");
  }
}

export function assertSeriesRequestSecurity(
  input: {
    readonly points?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  if (!Array.isArray(input.points)) {
    rejectSecurityInput("points must be an array", "INVALID_SERIES_POINTS");
  }

  if (input.points.length > policy.maxSeriesPoints) {
    rejectSecurityInput("Too many series points", "SERIES_POINT_LIMIT_EXCEEDED", {
      count: input.points.length,
      limit: policy.maxSeriesPoints
    });
  }

  for (const point of input.points) {
    if (typeof point !== "number" || !Number.isFinite(point)) {
      rejectSecurityInput("Series points must be finite numbers", "INVALID_SERIES_POINT");
    }
  }
}

export function assertTimeSeriesRequestSecurity(
  input: {
    readonly points?: unknown;
    readonly movingAverageWindow?: unknown;
    readonly anomalyThreshold?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  if (!Array.isArray(input.points)) {
    rejectSecurityInput("points must be an array", "INVALID_TIME_SERIES_POINTS");
  }

  if (input.points.length > policy.maxSeriesPoints) {
    rejectSecurityInput("Too many time series points", "TIME_SERIES_POINT_LIMIT_EXCEEDED", {
      count: input.points.length,
      limit: policy.maxSeriesPoints
    });
  }

  for (const point of input.points) {
    if (!isPlainObject(point)) {
      rejectSecurityInput("Time series points must be objects", "INVALID_TIME_SERIES_POINT");
    }

    assertBoundedText(
      point.timestamp,
      "timestamp",
      policy.maxDatasetCellChars,
      "TIME_SERIES_TIMESTAMP_TOO_LARGE"
    );

    if (typeof point.value !== "number" || !Number.isFinite(point.value)) {
      rejectSecurityInput(
        "Time series point values must be finite numbers",
        "INVALID_TIME_SERIES_POINT"
      );
    }
  }

  if (typeof input.movingAverageWindow !== "undefined") {
    assertPositiveIntegerLimit(
      input.movingAverageWindow,
      "movingAverageWindow",
      policy.maxSeriesPoints,
      "TIME_SERIES_WINDOW_LIMIT_EXCEEDED"
    );
  }

  if (
    typeof input.anomalyThreshold !== "undefined" &&
    (typeof input.anomalyThreshold !== "number" ||
      !Number.isFinite(input.anomalyThreshold) ||
      input.anomalyThreshold <= 0)
  ) {
    rejectSecurityInput(
      "anomalyThreshold must be a positive number",
      "INVALID_TIME_SERIES_THRESHOLD"
    );
  }
}

export function assertDatasetProfileRequestSecurity(
  input: {
    readonly rows?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  if (!Array.isArray(input.rows)) {
    rejectSecurityInput("rows must be an array", "INVALID_DATASET_ROWS");
  }

  if (input.rows.length > policy.maxDatasetRows) {
    rejectSecurityInput("Too many dataset rows", "DATASET_ROW_LIMIT_EXCEEDED", {
      count: input.rows.length,
      limit: policy.maxDatasetRows
    });
  }

  const fieldNames = new Set<string>();

  for (const row of input.rows) {
    if (!isPlainObject(row)) {
      rejectSecurityInput("Dataset rows must be objects", "INVALID_DATASET_ROW");
    }

    for (const [fieldName, value] of Object.entries(row)) {
      assertBoundedText(fieldName, "fieldName", policy.maxIdentifierChars, "FIELD_NAME_TOO_LARGE");
      assertCellSize(value, policy);
      fieldNames.add(fieldName);

      if (fieldNames.size > policy.maxDatasetFields) {
        rejectSecurityInput("Too many dataset fields", "DATASET_FIELD_LIMIT_EXCEEDED", {
          count: fieldNames.size,
          limit: policy.maxDatasetFields
        });
      }
    }
  }
}

export function assertChartRequestSecurity(
  input: {
    readonly title?: unknown;
    readonly labels?: unknown;
    readonly values?: unknown;
    readonly profile?: unknown;
    readonly maxRecommendations?: unknown;
    readonly theme?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  if (
    typeof input.theme !== "undefined" &&
    input.theme !== "dark" &&
    input.theme !== "light"
  ) {
    rejectSecurityInput("theme must be dark or light", "INVALID_CHART_THEME", {
      allowedThemes: ["dark", "light"]
    });
  }

  if (typeof input.maxRecommendations !== "undefined") {
    assertPositiveIntegerLimit(
      input.maxRecommendations,
      "maxRecommendations",
      policy.maxChartRecommendations,
      "CHART_RECOMMENDATION_LIMIT_EXCEEDED"
    );
  }

  if (typeof input.profile !== "undefined") {
    assertChartProfileSecurity(input.profile, policy);
    return;
  }

  assertBoundedText(input.title, "title", policy.maxDatasetCellChars, "CHART_TITLE_TOO_LARGE");
  assertStringArray(input.labels, "labels", policy.maxChartDataPoints, policy.maxDatasetCellChars);

  if (!Array.isArray(input.values)) {
    rejectSecurityInput("values must be an array", "INVALID_CHART_VALUES");
  }

  if (input.values.length > policy.maxChartDataPoints) {
    rejectSecurityInput("Too many chart values", "CHART_DATA_LIMIT_EXCEEDED", {
      count: input.values.length,
      limit: policy.maxChartDataPoints
    });
  }

  for (const value of input.values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      rejectSecurityInput("Chart values must be finite numbers", "INVALID_CHART_VALUE");
    }
  }

  if (Array.isArray(input.labels) && input.labels.length !== input.values.length) {
    rejectSecurityInput("labels and values must have the same length", "CHART_DATA_LENGTH_MISMATCH", {
      labelCount: input.labels.length,
      valueCount: input.values.length
    });
  }
}

export function assertMetadataSearchRequestSecurity(
  input: {
    readonly query?: unknown;
    readonly limit?: unknown;
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
  assertBoundedText(
    input.query,
    "query",
    policy.maxMetadataSearchChars,
    "METADATA_SEARCH_QUERY_TOO_LARGE"
  );

  if (typeof input.limit !== "undefined") {
    assertPositiveIntegerLimit(
      input.limit,
      "limit",
      policy.maxMetadataSearchLimit,
      "METADATA_SEARCH_LIMIT_EXCEEDED"
    );
  }
}

export function assessPromptInjection(message: string): PromptInjectionAssessment {
  const matchedSignals = PROMPT_INJECTION_RULES.filter((rule) => rule.pattern.test(message)).map(
    (rule) => rule.code
  );

  return {
    blocked: matchedSignals.length > 0,
    riskLevel: matchedSignals.length > 0 ? "high" : "none",
    matchedSignals
  };
}

export function writeSecurityAuditEvent(event: SecurityAuditEvent): void {
  const context = compactLogContext({
    action: event.action,
    status: event.status,
    requestId: event.requestId,
    route: event.route,
    details:
      typeof event.details === "undefined" ? undefined : compactLogContext(event.details)
  });

  if (event.status === "blocked" || event.status === "failed") {
    auditLogger.warn("security audit event", context);
    return;
  }

  auditLogger.info("security audit event", context);
}

function assertChartProfileSecurity(
  profile: unknown,
  policy: RequestSecurityPolicy
): void {
  if (!isPlainObject(profile)) {
    rejectSecurityInput("profile must be an object", "INVALID_CHART_PROFILE");
  }

  const fields = profile.fields;

  if (!Array.isArray(fields)) {
    rejectSecurityInput("profile.fields must be an array", "INVALID_CHART_PROFILE");
  }

  if (fields.length > policy.maxDatasetFields) {
    rejectSecurityInput("Too many profile fields", "DATASET_FIELD_LIMIT_EXCEEDED", {
      count: fields.length,
      limit: policy.maxDatasetFields
    });
  }

  for (const field of fields) {
    assertProfileFieldSecurity(field, policy);
  }
}

function assertProfileFieldSecurity(field: unknown, policy: RequestSecurityPolicy): void {
  if (!isPlainObject(field)) {
    rejectSecurityInput("Profile fields must be objects", "INVALID_PROFILE_FIELD");
  }

  assertBoundedText(field.name, "field.name", policy.maxIdentifierChars, "FIELD_NAME_TOO_LARGE");

  if (typeof field.kind !== "string") {
    rejectSecurityInput("Profile field kind is required", "INVALID_PROFILE_FIELD");
  }

  if (!Array.isArray(field.examples)) {
    rejectSecurityInput("Profile field examples must be an array", "INVALID_PROFILE_FIELD");
  }

  for (const example of field.examples) {
    assertCellSize(example, policy);
  }

  if (field.kind === "string") {
    if (!Array.isArray(field.topValues)) {
      rejectSecurityInput("String profile fields require topValues", "INVALID_PROFILE_FIELD");
    }

    for (const topValue of field.topValues) {
      if (!isPlainObject(topValue)) {
        rejectSecurityInput("topValues entries must be objects", "INVALID_PROFILE_FIELD");
      }

      assertCellSize(topValue.value, policy);
    }
  }

  if (field.kind === "number") {
    for (const numericKey of [
      "minimum",
      "maximum",
      "average",
      "median",
      "standardDeviation"
    ]) {
      if (typeof field[numericKey] !== "number" || !Number.isFinite(field[numericKey])) {
        rejectSecurityInput("Number profile fields require finite statistics", "INVALID_PROFILE_FIELD");
      }
    }

    if (!Array.isArray(field.outliers)) {
      rejectSecurityInput("Number profile fields require outliers", "INVALID_PROFILE_FIELD");
    }
  }
}

function assertStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxChars: number
): void {
  if (!Array.isArray(value)) {
    rejectSecurityInput(`${name} must be an array`, `INVALID_${name.toUpperCase()}`);
  }

  if (value.length > maxItems) {
    rejectSecurityInput(`${name} contains too many items`, "CHART_DATA_LIMIT_EXCEEDED", {
      name,
      count: value.length,
      limit: maxItems
    });
  }

  for (const item of value) {
    assertBoundedText(item, name, maxChars, `${name.toUpperCase()}_ITEM_TOO_LARGE`);
  }
}

function assertBoundedText(
  value: unknown,
  name: string,
  maxChars: number,
  code = `${name.toUpperCase()}_TOO_LARGE`
): void {
  if (typeof value !== "string") {
    rejectSecurityInput(`${name} must be a string`, `INVALID_${name.toUpperCase()}`);
  }

  if (value.length === 0) {
    rejectSecurityInput(`${name} cannot be empty`, `EMPTY_${name.toUpperCase()}`);
  }

  if (value.length > maxChars) {
    rejectSecurityInput(`${name} is too large`, code, {
      name,
      length: value.length,
      limit: maxChars
    });
  }
}

function assertPositiveIntegerLimit(
  value: unknown,
  name: string,
  maxValue: number,
  code: string
): void {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    rejectSecurityInput(`${name} must be a positive integer`, `INVALID_${name.toUpperCase()}`);
  }

  if (value > maxValue) {
    rejectSecurityInput(`${name} exceeds the configured limit`, code, {
      name,
      value,
      limit: maxValue
    });
  }
}

function assertCellSize(value: unknown, policy: RequestSecurityPolicy): void {
  if (typeof value === "string" && value.length > policy.maxDatasetCellChars) {
    rejectSecurityInput("Dataset cell is too large", "DATASET_CELL_TOO_LARGE", {
      length: value.length,
      limit: policy.maxDatasetCellChars
    });
  }
}

function rejectSecurityInput(
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>
): never {
  logger.warn("request security guard rejected input", {
    code,
    ...details
  });

  throw new AppError(message, code, 400, details);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactLogContext(
  context: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(context).filter(([_key, value]) => typeof value !== "undefined")
  );
}

function normalizeAllowedTablesPolicy(
  role: UserRole,
  value: "*" | readonly string[]
): "*" | readonly string[] {
  if (value === "*") {
    return value;
  }

  if (!Array.isArray(value)) {
    throw new AppError("Invalid SQL allowed tables policy", "INVALID_SQL_ACCESS_POLICY", 500, {
      role,
      value
    });
  }

  return normalizePermissionList(role, value, "allowedTables");
}

function normalizePermissionList(
  role: UserRole,
  values: readonly string[],
  fieldName: "allowedTables" | "blockedColumns"
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new AppError("Invalid SQL permission list", "INVALID_SQL_ACCESS_POLICY", 500, {
      role,
      fieldName,
      values
    });
  }

  return dedupePermissionList(
    values.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new AppError("Invalid SQL permission entry", "INVALID_SQL_ACCESS_POLICY", 500, {
          role,
          fieldName,
          value
        });
      }

      return value.trim();
    })
  );
}

function dedupePermissionList(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function canonicalSqlPermissionName(value: string): string {
  return value
    .split(".")
    .map((part) => part.replace(/["`]/g, "").trim().toLowerCase().replace(/[_\s-]/g, ""))
    .join(".");
}

