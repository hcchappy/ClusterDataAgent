import { AppError, createLogger } from "@clusterdata/shared";

export type UserRole = "admin" | "analyst" | "viewer";
export type AccessAction = "read" | "write" | "delete";

const logger = createLogger("security");
const USER_ROLES = ["admin", "analyst", "viewer"] as const;
const ACCESS_ACTIONS = ["read", "write", "delete"] as const;

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
  },
  policy = DEFAULT_REQUEST_SECURITY_POLICY
): void {
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

