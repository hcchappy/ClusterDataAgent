import { createRequire } from "node:module";
import {
  type AST,
  type BaseFrom,
  type Column,
  type From,
  type Limit,
  type Select,
  type TableExpr
} from "node-sql-parser";
import { type TableDefinition } from "@clusterdata/metadata-engine";
import { AppError, createLogger, safeErrorMessage } from "@clusterdata/shared";

const require = createRequire(import.meta.url);
const { Parser } = require("node-sql-parser") as {
  Parser: new () => {
    astify(sql: string, opt?: { database?: string }): AST | AST[];
  };
};

const sqlParser = new Parser();
const logger = createLogger("sql-agent");
const SQL_DIALECT = "Postgresql";
const DEFAULT_METADATA_LIMIT = 500;
const DISALLOWED_SQL_PATTERNS = [
  /\b(drop|delete|truncate|alter|create|grant|revoke|insert|update|merge|call|copy|execute)\b/i,
  /--/,
  /\/\*/,
  /;.*\S/
];

export interface SqlMetadataContext {
  readonly tables: readonly TableDefinition[];
  readonly maxLimit?: number;
  readonly requireLimit?: boolean;
}

export interface SqlValidationResult {
  readonly allowed: boolean;
  readonly normalizedSql: string;
  readonly reason?: string;
  readonly referencedTables?: readonly string[];
  readonly referencedColumns?: readonly string[];
  readonly limit?: number;
}

export interface SafeSelectQueryRequest {
  readonly tableName: string;
  readonly columns?: readonly string[];
  readonly limit?: number;
}

interface ValidationFailureDetails {
  readonly normalizedSql: string;
  readonly reason: string;
  readonly referencedTables?: readonly string[];
  readonly referencedColumns?: readonly string[];
  readonly limit?: number;
}

interface TableBinding {
  readonly alias: string;
  readonly sourceName: string;
  readonly table?: TableDefinition;
  readonly source: "table" | "cte" | "subquery";
  readonly columns?: ReadonlyMap<string, string>;
}

interface ColumnReference {
  readonly tableAlias?: string;
  readonly columnName: string;
  readonly displayName: string;
}

interface QueryValidationContext {
  readonly metadata?: MetadataIndex;
  readonly referencedTables: Set<string>;
  readonly referencedColumns: Set<string>;
  readonly ctes: Map<string, CteDefinition>;
}

interface CteDefinition {
  readonly name: string;
  readonly columns: ReadonlyMap<string, string>;
}

interface MetadataIndex {
  readonly tables: ReadonlyMap<string, TableDefinition>;
}

interface SelectAnalysisResult {
  readonly columns: ReadonlyMap<string, string>;
}

export function validateSqlStatement(
  sql: string,
  context?: SqlMetadataContext
): SqlValidationResult {
  const normalizedSql = sql.trim();
  const startTime = Date.now();

  if (normalizedSql.length === 0) {
    throw new AppError("SQL cannot be empty", "EMPTY_SQL", 400);
  }

  logger.info("sql validation started", {
    hasMetadata: Boolean(context),
    sqlLength: normalizedSql.length
  });

  if (!/^\s*(select|with)\b/i.test(normalizedSql)) {
    return rejectSql({
      normalizedSql,
      reason: "Only SELECT or WITH queries are allowed"
    });
  }

  for (const pattern of DISALLOWED_SQL_PATTERNS) {
    if (pattern.test(normalizedSql)) {
      return rejectSql({
        normalizedSql,
        reason: "SQL contains a restricted pattern"
      });
    }
  }

  let ast: AST | AST[];

  try {
    ast = sqlParser.astify(normalizedSql, { database: SQL_DIALECT });
  } catch (error) {
    logger.warn("sql parsing failed", {
      error: safeErrorMessage(error)
    });

    return rejectSql({
      normalizedSql,
      reason: `SQL could not be parsed: ${safeErrorMessage(error)}`
    });
  }

  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      return rejectSql({
        normalizedSql,
        reason: "Only one SQL statement is allowed"
      });
    }

    ast = ast[0];
  }

  if (!isSelectAst(ast)) {
    return rejectSql({
      normalizedSql,
      reason: "Only SELECT or WITH queries are allowed"
    });
  }

  if (hasIntoClause(ast)) {
    return rejectSql({
      normalizedSql,
      reason: "SELECT INTO is not allowed"
    });
  }

  const metadata = context ? buildMetadataIndex(context.tables) : undefined;
  const validationContext: QueryValidationContext = {
    metadata,
    referencedTables: new Set<string>(),
    referencedColumns: new Set<string>(),
    ctes: new Map<string, CteDefinition>()
  };

  try {
    analyzeSelect(ast, validationContext);
  } catch (error) {
    if (error instanceof AppError) {
      logger.warn("sql validation rejected", {
        code: error.code,
        reason: error.message
      });

      return rejectSql({
        normalizedSql,
        reason: error.message,
        referencedTables: [...validationContext.referencedTables],
        referencedColumns: [...validationContext.referencedColumns],
        limit: extractAstLimit(ast)
      });
    }

    logger.error("sql validation failed unexpectedly", {
      error: safeErrorMessage(error)
    });

    throw error;
  }

  const limit = extractAstLimit(ast);
  const maxLimit = context?.maxLimit ?? DEFAULT_METADATA_LIMIT;

  if (typeof limit === "undefined" && (context?.requireLimit ?? Boolean(context))) {
    return rejectSql({
      normalizedSql,
      reason: "SELECT queries must include a LIMIT",
      referencedTables: [...validationContext.referencedTables],
      referencedColumns: [...validationContext.referencedColumns]
    });
  }

  if (typeof limit === "number" && limit > maxLimit) {
    return rejectSql({
      normalizedSql,
      reason: `LIMIT exceeds the configured maximum of ${maxLimit}`,
      referencedTables: [...validationContext.referencedTables],
      referencedColumns: [...validationContext.referencedColumns],
      limit
    });
  }

  logger.info("sql validation completed", {
    allowed: true,
    referencedTableCount: validationContext.referencedTables.size,
    referencedColumnCount: validationContext.referencedColumns.size,
    limit,
    durationMs: Date.now() - startTime
  });

  return {
    allowed: true,
    normalizedSql,
    referencedTables: [...validationContext.referencedTables],
    referencedColumns: [...validationContext.referencedColumns],
    limit
  };
}

export function buildSafeLimitClause(limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new AppError("Limit must be between 1 and 1000", "INVALID_LIMIT", 400);
  }

  return `limit ${limit}`;
}

export function buildMetadataAwareSelectQuery(
  request: SafeSelectQueryRequest,
  context: SqlMetadataContext
): string {
  const table = findTableDefinition(request.tableName, context.tables);

  if (!table) {
    throw new AppError(`Unknown table: ${request.tableName}`, "UNKNOWN_TABLE", 400);
  }

  const selectedColumns = resolveSelectedColumns(request.columns, table);
  const limitClause = buildSafeLimitClause(request.limit ?? context.maxLimit ?? 100);

  return `select ${selectedColumns.join(", ")} from ${table.name} ${limitClause}`;
}

function analyzeSelect(
  select: Select,
  validationContext: QueryValidationContext
): SelectAnalysisResult {
  registerCtes(select, validationContext);

  const tableBindings = buildTableBindings(select, validationContext);
  const bindingMap = new Map(tableBindings.map((binding) => [canonicalName(binding.alias), binding]));
  const projectionAliases = collectProjectionAliases(select);
  const columnReferences = collectColumnReferences(select);

  for (const columnReference of columnReferences) {
    validateColumnReference(columnReference, tableBindings, bindingMap, projectionAliases);
    validationContext.referencedColumns.add(columnReference.displayName);
  }

  const selectedColumns = inferSelectedColumns(select, tableBindings);

  return {
    columns: selectedColumns
  };
}

function registerCtes(select: Select, validationContext: QueryValidationContext): void {
  for (const rawCte of select.with ?? []) {
    const name = extractCteName(rawCte);
    const cteStatement = extractCteSelect(rawCte);

    if (!name || !cteStatement) {
      throw new AppError("Unsupported CTE shape", "UNSUPPORTED_CTE", 400);
    }

    const cteAnalysis = analyzeSelect(cteStatement, validationContext);

    validationContext.ctes.set(canonicalName(name), {
      name,
      columns: cteAnalysis.columns
    });
  }
}

function buildTableBindings(
  select: Select,
  validationContext: QueryValidationContext
): readonly TableBinding[] {
  const fromItems = normalizeFromItems(select.from);
  const bindings: TableBinding[] = [];

  for (const fromItem of fromItems) {
    if (isDualFrom(fromItem)) {
      continue;
    }

    if (isSubqueryFrom(fromItem)) {
      const alias = fromItem.as;

      if (!alias) {
        throw new AppError("Subqueries must have an alias", "SUBQUERY_ALIAS_REQUIRED", 400);
      }

      const subquery = extractSubquerySelect(fromItem);

      if (!subquery) {
        throw new AppError("Unsupported subquery source", "UNSUPPORTED_SUBQUERY", 400);
      }

      const subqueryAnalysis = analyzeSelect(subquery, validationContext);

      bindings.push({
        alias,
        sourceName: alias,
        source: "subquery",
        columns: subqueryAnalysis.columns
      });

      continue;
    }

    if (!isTableFrom(fromItem)) {
      throw new AppError("Unsupported FROM source", "UNSUPPORTED_FROM_SOURCE", 400);
    }

    const sourceName = stripQuotes(fromItem.table);
    const alias = stripQuotes(fromItem.as ?? fromItem.table);
    const cte = validationContext.ctes.get(canonicalName(sourceName));

    if (cte) {
      bindings.push({
        alias,
        sourceName: cte.name,
        source: "cte",
        columns: cte.columns
      });
      validationContext.referencedTables.add(cte.name);
      collectJoinUsingColumns(fromItem).forEach((columnName) => {
        validationContext.referencedColumns.add(`${alias}.${columnName}`);
      });
      continue;
    }

    const table = validationContext.metadata
      ? findTableDefinition(sourceName, [...validationContext.metadata.tables.values()])
      : undefined;

    if (validationContext.metadata && !table) {
      throw new AppError(`Unknown table references: ${sourceName}`, "UNKNOWN_TABLE", 400);
    }

    bindings.push({
      alias,
      sourceName,
      table,
      source: "table",
      columns: table ? buildColumnIndex(table).columns : undefined
    });
    validationContext.referencedTables.add(table?.name ?? sourceName);

    for (const columnName of collectJoinUsingColumns(fromItem)) {
      validateColumnOnBinding(columnName, bindings[bindings.length - 1]);
      validationContext.referencedColumns.add(`${alias}.${columnName}`);
    }
  }

  if (bindings.length === 0 && validationContext.metadata) {
    throw new AppError("SELECT queries must read from a known table", "TABLE_REQUIRED", 400);
  }

  return bindings;
}

function validateColumnReference(
  reference: ColumnReference,
  tableBindings: readonly TableBinding[],
  bindingMap: ReadonlyMap<string, TableBinding>,
  projectionAliases: ReadonlySet<string>
): void {
  if (reference.columnName === "*") {
    if (reference.tableAlias) {
      const binding = bindingMap.get(canonicalName(reference.tableAlias));

      if (!binding) {
        throw new AppError(
          `Unknown table or alias reference: ${reference.tableAlias}`,
          "UNKNOWN_TABLE_ALIAS",
          400
        );
      }
    }

    return;
  }

  if (reference.tableAlias) {
    const binding = bindingMap.get(canonicalName(reference.tableAlias));

    if (!binding) {
      throw new AppError(
        `Unknown table or alias reference: ${reference.tableAlias}`,
        "UNKNOWN_TABLE_ALIAS",
        400
      );
    }

    validateColumnOnBinding(reference.columnName, binding);
    return;
  }

  const matchingBindings = tableBindings.filter((binding) =>
    bindingContainsColumn(binding, reference.columnName)
  );

  if (matchingBindings.length === 1) {
    return;
  }

  if (matchingBindings.length > 1) {
    throw new AppError(
      `Ambiguous column reference: ${reference.columnName}`,
      "AMBIGUOUS_COLUMN",
      400
    );
  }

  if (projectionAliases.has(canonicalName(reference.columnName))) {
    return;
  }

  throw new AppError(`Unknown column reference: ${reference.columnName}`, "UNKNOWN_COLUMN", 400);
}

function validateColumnOnBinding(columnName: string, binding: TableBinding): void {
  if (columnName === "*") {
    return;
  }

  if (!bindingContainsColumn(binding, columnName)) {
    throw new AppError(
      `Unknown column ${columnName} on ${binding.alias}`,
      "UNKNOWN_COLUMN",
      400
    );
  }
}

function bindingContainsColumn(binding: TableBinding, columnName: string): boolean {
  if (!binding.columns) {
    return true;
  }

  return binding.columns.has(canonicalName(columnName));
}

function collectProjectionAliases(select: Select): ReadonlySet<string> {
  const aliases = new Set<string>();

  for (const column of normalizeColumns(select.columns)) {
    const alias = extractAlias(column.as);

    if (alias) {
      aliases.add(canonicalName(alias));
    }
  }

  return aliases;
}

function collectColumnReferences(select: Select): readonly ColumnReference[] {
  const references: ColumnReference[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.type === "select") {
      return;
    }

    if (node.type === "column_ref") {
      const reference = toColumnReference(node);

      if (reference) {
        references.push(reference);
      }

      return;
    }

    for (const entry of Object.values(node)) {
      if (Array.isArray(entry)) {
        entry.forEach(visit);
        continue;
      }

      visit(entry);
    }
  };

  visit(select.columns);
  visit(select.where);
  visit(select.groupby);
  visit(select.having);
  visit(select.orderby);
  visit(select.window);

  for (const fromItem of normalizeFromItems(select.from)) {
    if (!isSubqueryFrom(fromItem)) {
      visit((fromItem as { on?: unknown }).on);
    }
  }

  return dedupeColumnReferences(references);
}

function dedupeColumnReferences(
  references: readonly ColumnReference[]
): readonly ColumnReference[] {
  const seen = new Set<string>();
  const deduped: ColumnReference[] = [];

  for (const reference of references) {
    const key = `${canonicalName(reference.tableAlias ?? "")}.${canonicalName(
      reference.columnName
    )}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(reference);
  }

  return deduped;
}

function inferSelectedColumns(
  select: Select,
  tableBindings: readonly TableBinding[]
): ReadonlyMap<string, string> {
  const selectedColumns = new Map<string, string>();

  for (const column of normalizeColumns(select.columns)) {
    const expression = column.expr as Record<string, unknown> | undefined;
    const alias = extractAlias(column.as);

    if (alias) {
      selectedColumns.set(canonicalName(alias), alias);
      continue;
    }

    const reference =
      expression?.type === "column_ref" ? toColumnReference(expression) : undefined;

    if (!reference) {
      continue;
    }

    if (reference.columnName === "*") {
      expandStarProjection(reference.tableAlias, tableBindings, selectedColumns);
      continue;
    }

    selectedColumns.set(canonicalName(reference.columnName), reference.columnName);
  }

  return selectedColumns;
}

function expandStarProjection(
  tableAlias: string | undefined,
  tableBindings: readonly TableBinding[],
  selectedColumns: Map<string, string>
): void {
  const bindings = tableAlias
    ? tableBindings.filter((binding) => canonicalName(binding.alias) === canonicalName(tableAlias))
    : tableBindings;

  for (const binding of bindings) {
    for (const columnName of binding.columns?.values() ?? []) {
      selectedColumns.set(canonicalName(columnName), columnName);
    }
  }
}

function extractAstLimit(select: Select): number | undefined {
  const limitValues = getLimitValues(select.limit);

  if (limitValues.length === 0) {
    return undefined;
  }

  if (select.limit?.seperator?.toLowerCase() === "offset" && limitValues.length > 1) {
    return limitValues[0];
  }

  return limitValues.at(-1);
}

function getLimitValues(limit: Limit | null | undefined): readonly number[] {
  return (limit?.value ?? [])
    .map((value) => value.value)
    .filter((value): value is number => Number.isInteger(value));
}

function rejectSql(details: ValidationFailureDetails): SqlValidationResult {
  logger.info("sql validation completed", {
    allowed: false,
    reason: details.reason,
    referencedTableCount: details.referencedTables?.length ?? 0,
    referencedColumnCount: details.referencedColumns?.length ?? 0,
    limit: details.limit
  });

  return {
    allowed: false,
    normalizedSql: details.normalizedSql,
    reason: details.reason,
    referencedTables: details.referencedTables,
    referencedColumns: details.referencedColumns,
    limit: details.limit
  };
}

function resolveSelectedColumns(
  requestedColumns: readonly string[] | undefined,
  table: TableDefinition
): readonly string[] {
  const availableColumns = buildColumnIndex(table).columns;

  if (!requestedColumns || requestedColumns.length === 0) {
    return table.columns.slice(0, 5).map((column) => column.name);
  }

  return requestedColumns.map((columnName) => {
    const resolvedColumn = availableColumns.get(canonicalName(columnName));

    if (!resolvedColumn) {
      throw new AppError(
        `Unknown column ${columnName} on table ${table.name}`,
        "UNKNOWN_COLUMN",
        400
      );
    }

    return resolvedColumn;
  });
}

function buildMetadataIndex(tables: readonly TableDefinition[]): MetadataIndex {
  const indexedTables = new Map<string, TableDefinition>();

  for (const table of tables) {
    indexedTables.set(canonicalName(table.name), table);
    indexedTables.set(canonicalName(stripQuotes(table.name)), table);
  }

  return {
    tables: indexedTables
  };
}

function buildColumnIndex(table: TableDefinition): {
  readonly columns: ReadonlyMap<string, string>;
} {
  return {
    columns: new Map(
      table.columns.flatMap((column) => [
        [canonicalName(column.name), column.name],
        [canonicalName(stripQuotes(column.name)), column.name]
      ])
    )
  };
}

function findTableDefinition(
  tableName: string,
  tables: readonly TableDefinition[]
): TableDefinition | undefined {
  const requestedName = canonicalName(tableName);

  return tables.find((table) => canonicalName(table.name) === requestedName);
}

function normalizeFromItems(from: Select["from"]): readonly From[] {
  if (!from) {
    return [];
  }

  return Array.isArray(from) ? from : [from];
}

function normalizeColumns(columns: Select["columns"]): readonly Column[] {
  return Array.isArray(columns) ? (columns as Column[]) : [];
}

function isSelectAst(ast: AST): ast is Select {
  return ast.type === "select";
}

function hasIntoClause(select: Select): boolean {
  const into = (select as { into?: { position?: string | null } }).into;

  return Boolean(into?.position);
}

function isDualFrom(from: From): boolean {
  return (from as { type?: string }).type === "dual";
}

function isSubqueryFrom(from: From): from is TableExpr {
  return "expr" in from && Boolean((from as { expr?: unknown }).expr);
}

function isTableFrom(from: From): from is BaseFrom {
  return "table" in from && typeof from.table === "string";
}

function extractSubquerySelect(from: From): Select | undefined {
  const expression = (from as { expr?: { ast?: unknown } }).expr;
  const ast = expression?.ast;

  return ast && typeof ast === "object" && (ast as { type?: string }).type === "select"
    ? (ast as Select)
    : undefined;
}

function extractCteName(rawCte: unknown): string | undefined {
  const cte = rawCte as { name?: { value?: string } | string };

  if (typeof cte.name === "string") {
    return cte.name;
  }

  return cte.name?.value;
}

function extractCteSelect(rawCte: unknown): Select | undefined {
  const cte = rawCte as { stmt?: unknown };
  const statement = cte.stmt as { ast?: unknown; type?: string } | undefined;

  if (statement?.type === "select") {
    return statement as Select;
  }

  if (statement?.ast && (statement.ast as { type?: string }).type === "select") {
    return statement.ast as Select;
  }

  return undefined;
}

function collectJoinUsingColumns(fromItem: From): readonly string[] {
  const usingColumns = (fromItem as { using?: unknown[] }).using ?? [];

  return usingColumns
    .map((column) => {
      if (typeof column === "string") {
        return stripQuotes(column);
      }

      const value = (column as { value?: unknown }).value;

      return typeof value === "string" ? stripQuotes(value) : undefined;
    })
    .filter((value): value is string => Boolean(value));
}

function toColumnReference(node: Record<string, unknown>): ColumnReference | undefined {
  const columnName = extractColumnName(node.column);

  if (!columnName) {
    return undefined;
  }

  const tableAlias = extractIdentifierName(node.table);
  const displayName = tableAlias ? `${tableAlias}.${columnName}` : columnName;

  return {
    tableAlias,
    columnName,
    displayName
  };
}

function extractColumnName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stripQuotes(value);
  }

  const expression = (value as { expr?: unknown } | undefined)?.expr;

  if (!expression || typeof expression !== "object") {
    return undefined;
  }

  return extractIdentifierName(expression);
}

function extractIdentifierName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stripQuotes(value);
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as { value?: unknown }).value;

  return typeof candidate === "string" ? stripQuotes(candidate) : undefined;
}

function extractAlias(value: Column["as"]): string | undefined {
  return extractIdentifierName(value);
}

function stripQuotes(identifier: string): string {
  const terminalIdentifier = identifier.split(".").at(-1) ?? identifier;

  return terminalIdentifier.replace(/["`]/g, "");
}

function canonicalName(value: string): string {
  return stripQuotes(value).toLowerCase().replace(/[_\s-]/g, "");
}
