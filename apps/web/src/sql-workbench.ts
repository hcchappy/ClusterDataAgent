import type { SqlQueryResult, SqlValidationResult, UserRole } from "./api.js";

export interface SqlHistoryEntry {
  readonly id: string;
  readonly sql: string;
  readonly executedAt: string;
  readonly role?: UserRole;
  readonly result: SqlQueryResult;
}

export const SQL_HISTORY_STORAGE_KEY = "clusterdata.sql-history.v1";
export const MAX_SQL_HISTORY_ENTRIES = 6;

export function createSqlHistoryEntry(
  sql: string,
  result: SqlQueryResult,
  options: {
    readonly id?: string;
    readonly executedAt?: string;
    readonly role?: UserRole;
  } = {}
): SqlHistoryEntry {
  return {
    id: options.id ?? createHistoryEntryId(),
    sql: sql.trim(),
    executedAt: options.executedAt ?? new Date().toISOString(),
    role: options.role,
    result
  };
}

export function upsertSqlHistory(
  entries: readonly SqlHistoryEntry[],
  nextEntry: SqlHistoryEntry,
  maxEntries = MAX_SQL_HISTORY_ENTRIES
): readonly SqlHistoryEntry[] {
  const normalizedNextSql = normalizeSqlHistoryValue(nextEntry.sql);

  return [
    nextEntry,
    ...entries.filter(
      (entry) =>
        entry.id !== nextEntry.id &&
        normalizeSqlHistoryValue(entry.sql) !== normalizedNextSql
    )
  ].slice(0, maxEntries);
}

export function serializeSqlHistory(entries: readonly SqlHistoryEntry[]): string {
  return JSON.stringify({
    version: 1,
    entries
  });
}

export function parseSqlHistory(
  rawValue: string | null | undefined,
  maxEntries = MAX_SQL_HISTORY_ENTRIES
): readonly SqlHistoryEntry[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("SQL history is not valid JSON");
  }

  if (!isSqlHistoryPayload(parsed)) {
    throw new Error("SQL history payload is invalid");
  }

  return parsed.entries.slice(0, maxEntries);
}

export function buildSqlPreview(sql: string, maxLength = 84): string {
  const normalized = sql.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function convertSqlResultToCsv(result: SqlQueryResult): string {
  const lines = [
    result.columns.map((column) => escapeCsvCell(column)).join(","),
    ...result.rows.map((row) =>
      result.columns.map((column) => escapeCsvCell(row[column])).join(",")
    )
  ];

  return `${lines.join("\n")}\n`;
}

export function buildSqlExportFileName(executedAt: string): string {
  const safeTimestamp = executedAt.replace(/[:.]/g, "-");

  return `clusterdata-query-${safeTimestamp}.csv`;
}

export function getValidationBadgeState(
  validation: SqlValidationResult
): "is-ok" | "is-bad" {
  return validation.allowed ? "is-ok" : "is-bad";
}

function createHistoryEntryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sql-history-${Date.now()}`;
}

function normalizeSqlHistoryValue(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeCsvCell(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  const normalized =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);

  const escaped = normalized.replace(/"/g, "\"\"");

  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function isSqlHistoryPayload(
  value: unknown
): value is {
  readonly version: 1;
  readonly entries: readonly SqlHistoryEntry[];
} {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.every(isSqlHistoryEntry)
  );
}

function isSqlHistoryEntry(value: unknown): value is SqlHistoryEntry {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    typeof value.sql === "string" &&
    typeof value.executedAt === "string" &&
    (typeof value.role === "undefined" || isUserRole(value.role)) &&
    isSqlQueryResult(value.result)
  );
}

function isSqlQueryResult(value: unknown): value is SqlQueryResult {
  return (
    isPlainObject(value) &&
    Array.isArray(value.columns) &&
    value.columns.every((column) => typeof column === "string") &&
    Array.isArray(value.rows) &&
    typeof value.rowCount === "number" &&
    typeof value.durationMs === "number" &&
    isSqlValidationResult(value.validation)
  );
}

function isSqlValidationResult(value: unknown): value is SqlValidationResult {
  return (
    isPlainObject(value) &&
    typeof value.allowed === "boolean" &&
    typeof value.normalizedSql === "string" &&
    (typeof value.reason === "undefined" || typeof value.reason === "string") &&
    (typeof value.limit === "undefined" || typeof value.limit === "number") &&
    (typeof value.referencedTables === "undefined" ||
      (Array.isArray(value.referencedTables) &&
        value.referencedTables.every((item) => typeof item === "string"))) &&
    (typeof value.referencedColumns === "undefined" ||
      (Array.isArray(value.referencedColumns) &&
        value.referencedColumns.every((item) => typeof item === "string")))
  );
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "analyst" || value === "viewer";
}
