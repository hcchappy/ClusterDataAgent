import { readFile, stat } from "node:fs/promises";
import pg from "pg";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";

export interface TableColumn {
  readonly name: string;
  readonly dataType: string;
}

export interface RelationHint {
  readonly fromColumn: string;
  readonly toTable?: string;
  readonly toColumn?: string;
}

export interface TableDefinition {
  readonly name: string;
  readonly columns: readonly TableColumn[];
  readonly relations?: readonly RelationHint[];
}

export interface RelationEdge {
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

const PRISMA_SCALAR_TYPES = new Set([
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
  "Unsupported"
]);

const POSTGRES_COLUMNS_SQL = `
select
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  ordinal_position
from information_schema.columns
where table_schema = $1
order by table_name, ordinal_position
`;

const POSTGRES_RELATIONS_SQL = `
select
  source_table.relname as from_table,
  source_attribute.attname as from_column,
  target_table.relname as to_table,
  target_attribute.attname as to_column
from pg_constraint constraint_info
join pg_class source_table
  on source_table.oid = constraint_info.conrelid
join pg_namespace source_namespace
  on source_namespace.oid = source_table.relnamespace
join pg_class target_table
  on target_table.oid = constraint_info.confrelid
join unnest(constraint_info.conkey) with ordinality as source_key(attnum, ordinal)
  on true
join unnest(constraint_info.confkey) with ordinality as target_key(attnum, ordinal)
  on source_key.ordinal = target_key.ordinal
join pg_attribute source_attribute
  on source_attribute.attrelid = source_table.oid
  and source_attribute.attnum = source_key.attnum
join pg_attribute target_attribute
  on target_attribute.attrelid = target_table.oid
  and target_attribute.attnum = target_key.attnum
where constraint_info.contype = 'f'
  and source_namespace.nspname = $1
order by source_table.relname, source_attribute.attname
`;

export interface PrismaFieldDefinition {
  readonly name: string;
  readonly type: string;
  readonly isOptional: boolean;
  readonly isList: boolean;
  readonly relation?: {
    readonly targetTable?: string;
    readonly targetColumn?: string;
    readonly fields?: readonly string[];
    readonly references?: readonly string[];
  };
}

export interface PrismaModelDefinition {
  readonly name: string;
  readonly dbName?: string;
  readonly fields: readonly PrismaFieldDefinition[];
}

export interface PrismaSchemaCatalog {
  readonly sourcePath: string;
  readonly loadedAt: string;
  readonly models: readonly PrismaModelDefinition[];
  readonly tables: readonly TableDefinition[];
  readonly relations: readonly RelationEdge[];
  readonly summary: {
    readonly tableCount: number;
    readonly columnCount: number;
    readonly relationCount: number;
  };
}

export interface MetadataSearchResult {
  readonly type: "table" | "column" | "relation";
  readonly tableName: string;
  readonly columnName?: string;
  readonly relation?: RelationEdge;
  readonly score: number;
}

export interface MetadataDataTypeSummary {
  readonly dataType: string;
  readonly count: number;
}

export interface MetadataRelationHotspot {
  readonly tableName: string;
  readonly relationCount: number;
}

export interface MetadataTableInsight {
  readonly tableName: string;
  readonly columnCount: number;
  readonly relationCount: number;
  readonly sampleColumns: readonly TableColumn[];
  readonly relatedTables: readonly string[];
  readonly starterQuery: string;
}

export interface MetadataCatalogInsights {
  readonly summary: PrismaSchemaCatalog["summary"];
  readonly dataTypes: readonly MetadataDataTypeSummary[];
  readonly relationHotspots: readonly MetadataRelationHotspot[];
  readonly tables: readonly MetadataTableInsight[];
}

export interface MetadataCacheEntry {
  readonly mtimeMs: number;
  readonly catalog: PrismaSchemaCatalog;
}

export interface MetadataCache {
  get(sourcePath: string): MetadataCacheEntry | undefined;
  set(sourcePath: string, entry: MetadataCacheEntry): void;
}

export class InMemoryMetadataCache implements MetadataCache {
  private readonly entries = new Map<string, MetadataCacheEntry>();

  public get(sourcePath: string): MetadataCacheEntry | undefined {
    return this.entries.get(sourcePath);
  }

  public set(sourcePath: string, entry: MetadataCacheEntry): void {
    this.entries.set(sourcePath, entry);
  }
}

export interface LoadPrismaSchemaCatalogOptions {
  readonly forceRefresh?: boolean;
}

export interface PrismaMetadataCatalogServiceOptions {
  readonly sourcePath: string;
  readonly cache?: MetadataCache;
  readonly initialCatalog?: PrismaSchemaCatalog;
  readonly logger?: Logger;
}

export interface PostgresMetadataScannerOptions {
  readonly databaseUrl: string;
  readonly schemaName?: string;
  readonly logger?: Logger;
  readonly clientFactory?: PostgresClientFactory;
}

export type PostgresClientFactory = (databaseUrl: string) => PostgresMetadataClient;

export interface PostgresMetadataClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends PostgresQueryRow = PostgresQueryRow>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly T[] }>;
}

export interface PostgresQueryRow {
  readonly [key: string]: unknown;
}

export interface PostgresColumnRow extends PostgresQueryRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly udt_name: string;
  readonly is_nullable: string;
  readonly ordinal_position: number;
}

export interface PostgresRelationRow extends PostgresQueryRow {
  readonly from_table: string;
  readonly from_column: string;
  readonly to_table: string;
  readonly to_column: string;
}

export class PrismaMetadataCatalogService {
  private readonly sourcePath: string;
  private readonly cache: MetadataCache;
  private readonly logger: Logger;
  private currentCatalog?: PrismaSchemaCatalog;

  public constructor(options: PrismaMetadataCatalogServiceOptions) {
    this.sourcePath = options.sourcePath;
    this.cache = options.cache ?? new InMemoryMetadataCache();
    this.currentCatalog = options.initialCatalog;
    this.logger = options.logger ?? createLogger("metadata-engine");
  }

  public async getCatalog(): Promise<PrismaSchemaCatalog> {
    const catalog = await loadPrismaSchemaCatalog(this.sourcePath, this.cache);

    this.logCatalogChange(catalog, "metadata catalog loaded");
    this.currentCatalog = catalog;

    return catalog;
  }

  public async refresh(): Promise<PrismaSchemaCatalog> {
    const catalog = await loadPrismaSchemaCatalog(this.sourcePath, this.cache, {
      forceRefresh: true
    });

    this.currentCatalog = catalog;
    this.logger.info("metadata catalog refreshed", {
      sourcePath: catalog.sourcePath,
      tableCount: catalog.summary.tableCount,
      relationCount: catalog.summary.relationCount,
      loadedAt: catalog.loadedAt
    });

    return catalog;
  }

  public async listTables(): Promise<readonly TableDefinition[]> {
    return (await this.getCatalog()).tables;
  }

  public async getTable(tableName: string): Promise<TableDefinition> {
    const catalog = await this.getCatalog();
    const table = findTableDefinition(tableName, catalog.tables);

    if (!table) {
      throw new AppError(`Unknown metadata table: ${tableName}`, "METADATA_TABLE_NOT_FOUND", 404, {
        tableName
      });
    }

    return table;
  }

  public async listRelations(tableName?: string): Promise<readonly RelationEdge[]> {
    const catalog = await this.getCatalog();

    if (!tableName) {
      return catalog.relations;
    }

    const normalized = canonicalName(tableName);

    return catalog.relations.filter(
      (relation) =>
        canonicalName(relation.fromTable) === normalized ||
        canonicalName(relation.toTable) === normalized
    );
  }

  public async search(
    query: string,
    limit = 10
  ): Promise<readonly MetadataSearchResult[]> {
    const catalog = await this.getCatalog();
    const results = searchMetadataCatalog(catalog, query, limit);

    this.logger.info("metadata search completed", {
      query,
      resultCount: results.length
    });

    return results;
  }

  private logCatalogChange(catalog: PrismaSchemaCatalog, message: string): void {
    if (this.currentCatalog?.loadedAt === catalog.loadedAt) {
      return;
    }

    this.logger.info(message, {
      sourcePath: catalog.sourcePath,
      tableCount: catalog.summary.tableCount,
      relationCount: catalog.summary.relationCount,
      loadedAt: catalog.loadedAt
    });
  }
}

export async function loadPostgresSchemaCatalog(
  options: PostgresMetadataScannerOptions
): Promise<PrismaSchemaCatalog> {
  const schemaName = options.schemaName ?? "public";
  const logger = options.logger ?? createLogger("metadata-engine");

  if (options.databaseUrl.trim().length === 0) {
    throw new AppError(
      "databaseUrl is required for PostgreSQL metadata scanning",
      "DATABASE_URL_REQUIRED",
      400
    );
  }

  const client = (options.clientFactory ?? createPgClient)(options.databaseUrl);

  try {
    await client.connect();

    const [columnResult, relationResult] = await Promise.all([
      client.query<PostgresColumnRow>(POSTGRES_COLUMNS_SQL, [schemaName]),
      client.query<PostgresRelationRow>(POSTGRES_RELATIONS_SQL, [schemaName])
    ]);
    const catalog = buildPostgresCatalog({
      sourcePath: `postgresql://${schemaName}`,
      columns: columnResult.rows,
      relations: relationResult.rows
    });

    logger.info("postgres metadata catalog loaded", {
      schemaName,
      tableCount: catalog.summary.tableCount,
      relationCount: catalog.summary.relationCount
    });

    return catalog;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("PostgreSQL metadata scan failed", "POSTGRES_METADATA_SCAN_FAILED", 500, {
      schemaName,
      error: safeErrorMessage(error)
    });
  } finally {
    await client.end();
  }
}

export function buildPostgresCatalog({
  sourcePath,
  columns,
  relations
}: {
  readonly sourcePath: string;
  readonly columns: readonly PostgresColumnRow[];
  readonly relations: readonly PostgresRelationRow[];
}): PrismaSchemaCatalog {
  const tableColumns = new Map<string, TableColumn[]>();

  for (const column of columns) {
    const tableName = column.table_name;
    const currentColumns = tableColumns.get(tableName) ?? [];

    currentColumns.push({
      name: column.column_name,
      dataType: column.data_type === "USER-DEFINED" ? column.udt_name : column.data_type
    });
    tableColumns.set(tableName, currentColumns);
  }

  const tables = Array.from(tableColumns.entries()).map(
    ([name, tableColumnList]): TableDefinition => ({
      name,
      columns: tableColumnList
    })
  );
  const relationEdges = relations.map(
    (relation): RelationEdge => ({
      fromTable: relation.from_table,
      fromColumn: relation.from_column,
      toTable: relation.to_table,
      toColumn: relation.to_column
    })
  );
  const catalog: PrismaSchemaCatalog = {
    sourcePath,
    loadedAt: new Date().toISOString(),
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
    relations: relationEdges,
    summary: {
      tableCount: tables.length,
      columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
      relationCount: relationEdges.length
    }
  };

  if (catalog.summary.tableCount === 0) {
    throw new AppError("No PostgreSQL tables were found", "NO_POSTGRES_TABLES", 404, {
      sourcePath
    });
  }

  return catalog;
}

export async function loadPrismaSchemaCatalog(
  sourcePath: string,
  cache?: MetadataCache,
  options: LoadPrismaSchemaCatalogOptions = {}
): Promise<PrismaSchemaCatalog> {
  let fileStats: Awaited<ReturnType<typeof stat>>;

  try {
    fileStats = await stat(sourcePath);
  } catch (error) {
    throw new AppError("Prisma schema file was not found", "PRISMA_SCHEMA_NOT_FOUND", 500, {
      sourcePath,
      error: safeErrorMessage(error)
    });
  }

  const cached = cache?.get(sourcePath);

  if (!options.forceRefresh && cached && cached.mtimeMs === fileStats.mtimeMs) {
    return cached.catalog;
  }

  let schemaText: string;

  try {
    schemaText = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new AppError("Prisma schema file could not be read", "PRISMA_SCHEMA_READ_FAILED", 500, {
      sourcePath,
      error: safeErrorMessage(error)
    });
  }

  const models = parsePrismaSchema(schemaText);
  const tables = models.map(toTableDefinition);
  const relations = buildRelationGraph(tables);
  const summary = summarizeMetadata(tables);
  const catalog: PrismaSchemaCatalog = {
    sourcePath,
    loadedAt: new Date(fileStats.mtimeMs).toISOString(),
    models,
    tables,
    relations,
    summary
  };

  cache?.set(sourcePath, {
    mtimeMs: fileStats.mtimeMs,
    catalog
  });

  return catalog;
}

export function parsePrismaSchema(schemaText: string): readonly PrismaModelDefinition[] {
  const models: PrismaModelDefinition[] = [];
  const lines = schemaText.split(/\r?\n/);
  let currentModel: PrismaModelBuilder | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("//")) {
      continue;
    }

    if (!currentModel) {
      const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);

      if (!modelMatch) {
        continue;
      }

      currentModel = {
        name: modelMatch[1],
        fields: []
      };
      continue;
    }

    if (line.startsWith("}")) {
      models.push(currentModel);
      currentModel = undefined;
      continue;
    }

    if (line.startsWith("@@")) {
      if (line.startsWith("@@map(")) {
        currentModel.dbName = extractQuotedValue(line);
      }

      continue;
    }

    const field = parsePrismaField(line);

    if (field) {
      currentModel.fields.push(field);
    }
  }

  return models;
}

export function summarizeMetadata(tables: readonly TableDefinition[]): {
  readonly tableCount: number;
  readonly columnCount: number;
  readonly relationCount: number;
} {
  if (tables.length === 0) {
    throw new AppError("No tables provided", "NO_TABLES", 400);
  }

  const relationCount = buildRelationGraph(tables).length;

  return {
    tableCount: tables.length,
    columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
    relationCount
  };
}

export function searchMetadataCatalog(
  catalog: PrismaSchemaCatalog,
  query: string,
  limit = 10
): readonly MetadataSearchResult[] {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    throw new AppError("metadata search query is required", "METADATA_SEARCH_QUERY_REQUIRED", 400);
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new AppError("metadata search limit must be between 1 and 100", "INVALID_METADATA_SEARCH_LIMIT", 400, {
      limit
    });
  }

  const queryKey = canonicalName(normalizedQuery);
  const results: MetadataSearchResult[] = [];

  for (const table of catalog.tables) {
    const tableScore = scoreMetadataMatch(table.name, queryKey);

    if (tableScore > 0) {
      results.push({
        type: "table",
        tableName: table.name,
        score: tableScore
      });
    }

    for (const column of table.columns) {
      const columnScore = scoreColumnMatch(table.name, column.name, queryKey);

      if (columnScore > 0) {
        results.push({
          type: "column",
          tableName: table.name,
          columnName: column.name,
          score: columnScore
        });
      }
    }
  }

  for (const relation of catalog.relations) {
    const relationText = `${relation.fromTable}.${relation.fromColumn}.${relation.toTable}.${relation.toColumn}`;
    const relationScore = scoreMetadataMatch(relationText, queryKey);

    if (relationScore > 0) {
      results.push({
        type: "relation",
        tableName: relation.fromTable,
        relation,
        score: relationScore
      });
    }
  }

  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

export function buildMetadataCatalogInsights(
  catalog: PrismaSchemaCatalog,
  options: {
    readonly tableLimit?: number;
    readonly columnLimit?: number;
  } = {}
): MetadataCatalogInsights {
  const tableLimit = options.tableLimit ?? 8;
  const columnLimit = options.columnLimit ?? 6;

  if (!Number.isInteger(tableLimit) || tableLimit <= 0 || tableLimit > 50) {
    throw new AppError("tableLimit must be between 1 and 50", "INVALID_METADATA_TABLE_LIMIT", 400, {
      tableLimit
    });
  }

  if (!Number.isInteger(columnLimit) || columnLimit <= 0 || columnLimit > 20) {
    throw new AppError("columnLimit must be between 1 and 20", "INVALID_METADATA_COLUMN_LIMIT", 400, {
      columnLimit
    });
  }

  const relationCounts = new Map<string, number>();

  for (const relation of catalog.relations) {
    relationCounts.set(relation.fromTable, (relationCounts.get(relation.fromTable) ?? 0) + 1);
    relationCounts.set(relation.toTable, (relationCounts.get(relation.toTable) ?? 0) + 1);
  }

  const dataTypeCounts = [...catalog.tables.flatMap((table) => table.columns)].reduce(
    (counts, column) => {
      counts.set(column.dataType, (counts.get(column.dataType) ?? 0) + 1);
      return counts;
    },
    new Map<string, number>()
  );

  const tableInsights = catalog.tables
    .map((table) => {
      const relatedTables = [
        ...new Set(
          catalog.relations.flatMap((relation) => {
            if (relation.fromTable === table.name) {
              return [relation.toTable];
            }

            if (relation.toTable === table.name) {
              return [relation.fromTable];
            }

            return [];
          })
        )
      ].sort((left, right) => left.localeCompare(right));
      const sampleColumns = table.columns.slice(0, columnLimit);

      return {
        tableName: table.name,
        columnCount: table.columns.length,
        relationCount: relationCounts.get(table.name) ?? 0,
        sampleColumns,
        relatedTables,
        starterQuery: buildMetadataStarterQuery(table.name, sampleColumns)
      } satisfies MetadataTableInsight;
    })
    .sort(
      (left, right) =>
        right.relationCount - left.relationCount ||
        right.columnCount - left.columnCount ||
        left.tableName.localeCompare(right.tableName)
    )
    .slice(0, tableLimit);

  return {
    summary: catalog.summary,
    dataTypes: [...dataTypeCounts.entries()]
      .map(([dataType, count]) => ({ dataType, count }))
      .sort((left, right) => right.count - left.count || left.dataType.localeCompare(right.dataType)),
    relationHotspots: [...relationCounts.entries()]
      .map(([tableName, relationCount]) => ({
        tableName,
        relationCount
      }))
      .sort(
        (left, right) =>
          right.relationCount - left.relationCount || left.tableName.localeCompare(right.tableName)
      ),
    tables: tableInsights
  };
}

function buildMetadataStarterQuery(
  tableName: string,
  columns: readonly TableColumn[]
): string {
  const selectedColumns = columns.map((column) => column.name).join(", ");

  return `select ${selectedColumns || "*"} from ${tableName} limit 20`;
}

export function buildRelationGraph(
  tables: readonly TableDefinition[]
): readonly RelationEdge[] {
  const indexedTables = new Map(
    tables.flatMap((table) => [
      [canonicalName(table.name), table],
      [canonicalName(stripQuotes(table.name)), table]
    ])
  );
  const relations: RelationEdge[] = [];
  const relationKeys = new Set<string>();

  for (const table of tables) {
    for (const relation of table.relations ?? []) {
      const toTable = resolveTargetTableName(relation.toTable, indexedTables);
      const toColumn = relation.toColumn ?? "id";

      if (!toTable) {
        continue;
      }

      pushRelation(relations, relationKeys, {
        fromTable: table.name,
        fromColumn: relation.fromColumn,
        toTable,
        toColumn
      });
    }

    for (const column of table.columns) {
      const inferredTarget = inferForeignKeyTarget(column.name, indexedTables);

      if (!inferredTarget) {
        continue;
      }

      pushRelation(relations, relationKeys, {
        fromTable: table.name,
        fromColumn: column.name,
        toTable: inferredTarget.name,
        toColumn: inferredTarget.column
      });
    }
  }

  return relations;
}

function toTableDefinition(model: PrismaModelDefinition): TableDefinition {
  const columns = model.fields
    .filter((field) => isScalarField(field))
    .map((field) => ({
      name: field.name,
      dataType: field.type
    }));
  const relations = model.fields
    .filter((field) => Boolean(field.relation))
    .flatMap((field) => {
      if (!field.relation?.fields || !field.relation.references) {
        return [];
      }

      const [fromColumn] = field.relation.fields;
      const [toColumn] = field.relation.references;

      if (!fromColumn) {
        return [];
      }

      return [
        {
          fromColumn,
          toTable: field.relation.targetTable,
          toColumn
        } satisfies RelationHint
      ];
    });

  return {
    name: model.dbName ?? model.name,
    columns,
    relations: relations.length > 0 ? relations : undefined
  };
}

function parsePrismaField(line: string): PrismaFieldDefinition | undefined {
  const fieldMatch = /^(\w+)\s+([^\s]+)\s*(.*)$/.exec(line);

  if (!fieldMatch) {
    return undefined;
  }

  const [, name, rawType, remainder] = fieldMatch;
  const type = stripTypeDecorators(rawType);
  const isOptional = rawType.endsWith("?");
  const isList = rawType.endsWith("[]");
  const relationMatch = /@relation\(([^)]*)\)/.exec(remainder);
  const relation = relationMatch ? parseRelationAttributes(relationMatch[1], type) : undefined;

  return {
    name,
    type,
    isOptional,
    isList,
    relation
  };
}

function parseRelationAttributes(
  attributeBody: string,
  targetTable: string
): PrismaFieldDefinition["relation"] {
  const fields = parseArrayAttribute(attributeBody, "fields");
  const references = parseArrayAttribute(attributeBody, "references");

  return {
    targetTable,
    targetColumn: references?.[0],
    fields,
    references
  };
}

function parseArrayAttribute(source: string, key: string): readonly string[] | undefined {
  const match = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(source);

  if (!match) {
    return undefined;
  }

  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(stripQuotes);
}

function isScalarField(field: PrismaFieldDefinition): boolean {
  if (field.relation && /^[A-Z]/.test(field.type)) {
    return false;
  }

  return PRISMA_SCALAR_TYPES.has(field.type);
}

function stripTypeDecorators(type: string): string {
  return Array.from(type)
    .filter((character) => character !== "?" && character !== "[" && character !== "]")
    .join("");
}

function stripQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}

function extractQuotedValue(source: string): string | undefined {
  const match = /"([^"]+)"|'([^']+)'|`([^`]+)`/.exec(source);

  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function canonicalName(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

function inferForeignKeyTarget(
  columnName: string,
  indexedTables: ReadonlyMap<string, TableDefinition>
): { readonly name: string; readonly column: string } | undefined {
  const candidate = canonicalName(stripForeignKeySuffix(columnName));
  const exact = indexedTables.get(candidate);

  if (exact) {
    return {
      name: exact.name,
      column: "id"
    };
  }

  const singularCandidate = candidate.endsWith("s") ? candidate.slice(0, -1) : candidate;
  const singular = indexedTables.get(singularCandidate);

  if (singular) {
    return {
      name: singular.name,
      column: "id"
    };
  }

  return undefined;
}

function stripForeignKeySuffix(columnName: string): string {
  return columnName.endsWith("_id")
    ? columnName.slice(0, -3)
    : columnName.endsWith("Id")
      ? columnName.slice(0, -2)
      : columnName;
}

function resolveTargetTableName(
  target: string | undefined,
  indexedTables: ReadonlyMap<string, TableDefinition>
): string | undefined {
  if (!target) {
    return undefined;
  }

  const table = indexedTables.get(canonicalName(target));

  return table?.name;
}

function findTableDefinition(
  tableName: string,
  tables: readonly TableDefinition[]
): TableDefinition | undefined {
  const requestedName = canonicalName(tableName);

  return tables.find((table) => canonicalName(table.name) === requestedName);
}

function scoreMetadataMatch(value: string, queryKey: string): number {
  const valueKey = canonicalName(value);

  if (valueKey === queryKey) {
    return 100;
  }

  if (valueKey.startsWith(queryKey)) {
    return 75;
  }

  if (valueKey.includes(queryKey)) {
    return 50;
  }

  return 0;
}

function scoreColumnMatch(tableName: string, columnName: string, queryKey: string): number {
  const columnScore = scoreMetadataMatch(columnName, queryKey);

  if (columnScore > 0) {
    return columnScore;
  }

  const tableKey = canonicalName(tableName);
  const fullColumnKey = `${tableKey}${canonicalName(columnName)}`;

  if (queryKey.length <= tableKey.length) {
    return 0;
  }

  if (fullColumnKey === queryKey) {
    return 95;
  }

  if (fullColumnKey.includes(queryKey)) {
    return 45;
  }

  return 0;
}

function createPgClient(databaseUrl: string): PostgresMetadataClient {
  const client = new pg.Client({
    connectionString: databaseUrl
  });

  return {
    async connect() {
      await client.connect();
    },
    async end() {
      await client.end();
    },
    async query<T extends PostgresQueryRow = PostgresQueryRow>(
      sql: string,
      values?: readonly unknown[]
    ) {
      const result = await client.query<T>(sql, values ? [...values] : undefined);

      return {
        rows: result.rows
      };
    }
  };
}

function pushRelation(
  relations: RelationEdge[],
  relationKeys: Set<string>,
  relation: RelationEdge
): void {
  const key = `${relation.fromTable}.${relation.fromColumn}->${relation.toTable}.${relation.toColumn}`;

  if (relationKeys.has(key)) {
    return;
  }

  relationKeys.add(key);
  relations.push(relation);
}

interface PrismaModelBuilder {
  name: string;
  dbName?: string;
  fields: PrismaFieldDefinition[];
}

export * from "./semantic.js";
