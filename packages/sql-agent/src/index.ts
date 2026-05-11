import { AppError } from "@clusterdata/shared";

const DISALLOWED_SQL_PATTERNS = [
  /\b(drop|delete|truncate|alter|create|grant|revoke)\b/i,
  /--/,
  /\/\*/,
  /;.*\S/
];

export interface SqlValidationResult {
  readonly allowed: boolean;
  readonly normalizedSql: string;
  readonly reason?: string;
}

export function validateSqlStatement(sql: string): SqlValidationResult {
  const normalizedSql = sql.trim();

  if (normalizedSql.length === 0) {
    throw new AppError("SQL cannot be empty", "EMPTY_SQL", 400);
  }

  if (!/^\s*(select|with)\b/i.test(normalizedSql)) {
    return {
      allowed: false,
      normalizedSql,
      reason: "Only SELECT or WITH queries are allowed"
    };
  }

  for (const pattern of DISALLOWED_SQL_PATTERNS) {
    if (pattern.test(normalizedSql)) {
      return {
        allowed: false,
        normalizedSql,
        reason: "SQL contains a restricted pattern"
      };
    }
  }

  return {
    allowed: true,
    normalizedSql
  };
}

export function buildSafeLimitClause(limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new AppError("Limit must be between 1 and 1000", "INVALID_LIMIT", 400);
  }

  return `limit ${limit}`;
}

