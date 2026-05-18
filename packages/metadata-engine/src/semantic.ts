import { readFile, stat } from "node:fs/promises";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";

export type SemanticDataType = "string" | "number" | "boolean" | "date";
export type SemanticMetricAggregation =
  | "count"
  | "countDistinct"
  | "sum"
  | "average"
  | "minimum"
  | "maximum";
export type SemanticMetricFormat = "integer" | "number" | "currency" | "percent";
export type SemanticFilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in";
export type SemanticTimeGrain = "raw" | "day" | "week" | "month";
export type SemanticFilterValue = string | number | boolean;

export interface MetadataCatalogLike {
  readonly tables: readonly MetadataTableLike[];
}

export interface MetadataTableLike {
  readonly name: string;
  readonly columns: readonly MetadataColumnLike[];
}

export interface MetadataColumnLike {
  readonly name: string;
  readonly dataType: string;
}

export interface SemanticDimensionDefinition {
  readonly id: string;
  readonly qualifiedId: string;
  readonly label: string;
  readonly columnName: string;
  readonly dataType: SemanticDataType;
  readonly description?: string;
  readonly synonyms?: readonly string[];
  readonly isPrimaryKey?: boolean;
  readonly isTimeDimension?: boolean;
}

export interface SemanticModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly tableName: string;
  readonly primaryKey: string;
  readonly description?: string;
  readonly owner?: string;
  readonly refreshCadence?: string;
  readonly synonyms?: readonly string[];
  readonly dimensions: readonly SemanticDimensionDefinition[];
  readonly defaultMetricIds: readonly string[];
}

export interface SemanticMetricFilterDefinition {
  readonly dimensionId: string;
  readonly operator: SemanticFilterOperator;
  readonly values: readonly SemanticFilterValue[];
}

export interface SemanticMetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly modelId: string;
  readonly tableName: string;
  readonly aggregation: SemanticMetricAggregation;
  readonly columnName?: string;
  readonly description?: string;
  readonly owner?: string;
  readonly refreshCadence?: string;
  readonly synonyms?: readonly string[];
  readonly format?: SemanticMetricFormat;
  readonly allowedDimensionIds: readonly string[];
  readonly defaultTimeDimensionId?: string;
  readonly filters: readonly SemanticMetricFilterDefinition[];
}

export interface SemanticCatalog {
  readonly version: 1;
  readonly sourcePath: string;
  readonly loadedAt: string;
  readonly models: readonly SemanticModelDefinition[];
  readonly metrics: readonly SemanticMetricDefinition[];
  readonly summary: {
    readonly modelCount: number;
    readonly metricCount: number;
    readonly dimensionCount: number;
    readonly ownerCount: number;
  };
}

export interface SemanticSearchResult {
  readonly type: "model" | "dimension" | "metric";
  readonly id: string;
  readonly label: string;
  readonly modelId: string;
  readonly tableName: string;
  readonly columnName?: string;
  readonly aggregation?: SemanticMetricAggregation;
  readonly score: number;
}

export interface SemanticModelInsight {
  readonly modelId: string;
  readonly label: string;
  readonly tableName: string;
  readonly dimensionCount: number;
  readonly metricCount: number;
  readonly owner?: string;
  readonly refreshCadence?: string;
}

export interface SemanticMetricInsight {
  readonly metricId: string;
  readonly label: string;
  readonly modelId: string;
  readonly aggregation: SemanticMetricAggregation;
  readonly owner?: string;
  readonly format?: SemanticMetricFormat;
  readonly defaultTimeDimensionId?: string;
  readonly allowedDimensionCount: number;
}

export interface SemanticOwnerInsight {
  readonly owner: string;
  readonly modelCount: number;
  readonly metricCount: number;
}

export interface SemanticCatalogInsights {
  readonly summary: SemanticCatalog["summary"];
  readonly models: readonly SemanticModelInsight[];
  readonly metrics: readonly SemanticMetricInsight[];
  readonly owners: readonly SemanticOwnerInsight[];
}

export interface SemanticCatalogCacheEntry {
  readonly mtimeMs: number;
  readonly catalog: SemanticCatalog;
}

export interface SemanticCatalogCache {
  get(sourcePath: string): SemanticCatalogCacheEntry | undefined;
  set(sourcePath: string, entry: SemanticCatalogCacheEntry): void;
}

export class InMemorySemanticCatalogCache implements SemanticCatalogCache {
  private readonly entries = new Map<string, SemanticCatalogCacheEntry>();

  public get(sourcePath: string): SemanticCatalogCacheEntry | undefined {
    return this.entries.get(sourcePath);
  }

  public set(sourcePath: string, entry: SemanticCatalogCacheEntry): void {
    this.entries.set(sourcePath, entry);
  }
}

export interface LoadSemanticCatalogOptions {
  readonly forceRefresh?: boolean;
}

export interface SemanticCatalogServiceOptions {
  readonly sourcePath: string;
  readonly getMetadataCatalog: () => MetadataCatalogLike;
  readonly cache?: SemanticCatalogCache;
  readonly initialCatalog?: SemanticCatalog;
  readonly logger?: Logger;
}

export interface SemanticMetricQueryRequest {
  readonly metricIds: readonly string[];
  readonly dimensionIds?: readonly string[];
  readonly timeDimensionId?: string;
  readonly timeGrain?: SemanticTimeGrain;
  readonly filters?: readonly SemanticMetricFilterDefinition[];
  readonly limit?: number;
}

export interface SemanticMetricQuery {
  readonly modelId: string;
  readonly modelLabel: string;
  readonly metricIds: readonly string[];
  readonly dimensionIds: readonly string[];
  readonly timeDimensionId?: string;
  readonly timeGrain?: SemanticTimeGrain;
  readonly limit: number;
  readonly sql: string;
  readonly metrics: readonly {
    readonly id: string;
    readonly label: string;
    readonly aggregation: SemanticMetricAggregation;
    readonly columnName?: string;
  }[];
  readonly dimensions: readonly {
    readonly id: string;
    readonly label: string;
    readonly columnName: string;
    readonly dataType: SemanticDataType;
  }[];
  readonly filters: readonly SemanticMetricFilterDefinition[];
  readonly referencedTables: readonly string[];
  readonly referencedColumns: readonly string[];
}

export class SemanticCatalogService {
  private readonly sourcePath: string;
  private readonly getMetadataCatalog: () => MetadataCatalogLike;
  private readonly cache: SemanticCatalogCache;
  private readonly logger: Logger;
  private currentCatalog?: SemanticCatalog;

  public constructor(options: SemanticCatalogServiceOptions) {
    this.sourcePath = options.sourcePath;
    this.getMetadataCatalog = options.getMetadataCatalog;
    this.cache = options.cache ?? new InMemorySemanticCatalogCache();
    this.currentCatalog = options.initialCatalog;
    this.logger = options.logger ?? createLogger("semantic-catalog");
  }

  public async getCatalog(): Promise<SemanticCatalog> {
    const catalog = await loadSemanticCatalog(
      this.sourcePath,
      this.getMetadataCatalog(),
      this.cache
    );

    if (this.currentCatalog?.loadedAt !== catalog.loadedAt) {
      this.logger.info("semantic catalog loaded", {
        sourcePath: catalog.sourcePath,
        modelCount: catalog.summary.modelCount,
        metricCount: catalog.summary.metricCount,
        dimensionCount: catalog.summary.dimensionCount,
        loadedAt: catalog.loadedAt
      });
    }

    this.currentCatalog = catalog;

    return catalog;
  }

  public async refresh(): Promise<SemanticCatalog> {
    const catalog = await loadSemanticCatalog(
      this.sourcePath,
      this.getMetadataCatalog(),
      this.cache,
      {
        forceRefresh: true
      }
    );

    this.currentCatalog = catalog;
    this.logger.info("semantic catalog refreshed", {
      sourcePath: catalog.sourcePath,
      modelCount: catalog.summary.modelCount,
      metricCount: catalog.summary.metricCount,
      dimensionCount: catalog.summary.dimensionCount,
      loadedAt: catalog.loadedAt
    });

    return catalog;
  }

  public async search(
    query: string,
    limit = 10
  ): Promise<readonly SemanticSearchResult[]> {
    const catalog = await this.getCatalog();
    const results = searchSemanticCatalog(catalog, query, limit);

    this.logger.info("semantic search completed", {
      query,
      limit,
      resultCount: results.length
    });

    return results;
  }

  public async buildMetricQuery(
    request: SemanticMetricQueryRequest
  ): Promise<SemanticMetricQuery> {
    const catalog = await this.getCatalog();
    const query = buildSemanticMetricQuery(catalog, request);

    this.logger.info("semantic metric query built", {
      modelId: query.modelId,
      metricIds: query.metricIds,
      dimensionIds: query.dimensionIds,
      limit: query.limit
    });

    return query;
  }

  public async getInsights(
    options: {
      readonly modelLimit?: number;
      readonly metricLimit?: number;
    } = {}
  ): Promise<SemanticCatalogInsights> {
    const catalog = await this.getCatalog();
    return buildSemanticCatalogInsights(catalog, options);
  }
}

export async function loadSemanticCatalog(
  sourcePath: string,
  metadataCatalog: MetadataCatalogLike,
  cache?: SemanticCatalogCache,
  options: LoadSemanticCatalogOptions = {}
): Promise<SemanticCatalog> {
  let fileStats: Awaited<ReturnType<typeof stat>>;

  try {
    fileStats = await stat(sourcePath);
  } catch (error) {
    throw new AppError("Semantic catalog file was not found", "SEMANTIC_CATALOG_NOT_FOUND", 500, {
      sourcePath,
      error: safeErrorMessage(error)
    });
  }

  const cached = cache?.get(sourcePath);

  if (!options.forceRefresh && cached && cached.mtimeMs === fileStats.mtimeMs) {
    return cached.catalog;
  }

  let sourceText: string;

  try {
    sourceText = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new AppError("Semantic catalog file could not be read", "SEMANTIC_CATALOG_READ_FAILED", 500, {
      sourcePath,
      error: safeErrorMessage(error)
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new AppError("Semantic catalog file contains invalid JSON", "SEMANTIC_CATALOG_INVALID_JSON", 500, {
      sourcePath,
      error: safeErrorMessage(error)
    });
  }

  const catalog = normalizeSemanticCatalog(
    parsed,
    metadataCatalog,
    sourcePath,
    new Date(fileStats.mtimeMs).toISOString()
  );

  cache?.set(sourcePath, {
    mtimeMs: fileStats.mtimeMs,
    catalog
  });

  return catalog;
}

export function searchSemanticCatalog(
  catalog: SemanticCatalog,
  query: string,
  limit = 10
): readonly SemanticSearchResult[] {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    throw new AppError("semantic search query is required", "SEMANTIC_SEARCH_QUERY_REQUIRED", 400);
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new AppError("semantic search limit must be between 1 and 100", "INVALID_SEMANTIC_SEARCH_LIMIT", 400, {
      limit
    });
  }

  const queryKey = canonicalName(normalizedQuery);
  const results: SemanticSearchResult[] = [];

  for (const model of catalog.models) {
    const modelScore = scoreSemanticMatch(
      [model.id, model.label, model.tableName, model.description, ...(model.synonyms ?? [])],
      queryKey
    );

    if (modelScore > 0) {
      results.push({
        type: "model",
        id: model.id,
        label: model.label,
        modelId: model.id,
        tableName: model.tableName,
        score: modelScore
      });
    }

    for (const dimension of model.dimensions) {
      const dimensionScore = scoreSemanticMatch(
        [
          dimension.id,
          dimension.qualifiedId,
          dimension.label,
          dimension.columnName,
          dimension.description,
          ...(dimension.synonyms ?? [])
        ],
        queryKey
      );

      if (dimensionScore > 0) {
        results.push({
          type: "dimension",
          id: dimension.qualifiedId,
          label: dimension.label,
          modelId: model.id,
          tableName: model.tableName,
          columnName: dimension.columnName,
          score: dimensionScore
        });
      }
    }
  }

  for (const metric of catalog.metrics) {
    const model = catalog.models.find((entry) => entry.id === metric.modelId);
    const metricScore = scoreSemanticMatch(
      [
        metric.id,
        metric.label,
        metric.description,
        metric.modelId,
        metric.tableName,
        ...(metric.synonyms ?? [])
      ],
      queryKey
    );

    if (metricScore > 0 && model) {
      results.push({
        type: "metric",
        id: metric.id,
        label: metric.label,
        modelId: metric.modelId,
        tableName: metric.tableName,
        aggregation: metric.aggregation,
        score: metricScore
      });
    }
  }

  return results
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export function buildSemanticCatalogFromMetadata(
  metadataCatalog: MetadataCatalogLike,
  options: {
    readonly sourcePath?: string;
    readonly loadedAt?: string;
  } = {}
): SemanticCatalog {
  if (!Array.isArray(metadataCatalog.tables) || metadataCatalog.tables.length === 0) {
    throw new AppError("Metadata catalog tables cannot be empty", "INVALID_METADATA_CATALOG", 500);
  }

  const models = metadataCatalog.tables.map((table): SemanticModelDefinition => {
    const modelId = toSemanticModelId(table.name);
    const primaryKey =
      table.columns.find((column: MetadataColumnLike) => canonicalName(column.name) === "id")?.name ??
      table.columns[0]?.name;

    if (!primaryKey) {
      throw new AppError(
        `Metadata table ${table.name} must include at least one column`,
        "INVALID_METADATA_CATALOG",
        500,
        {
          tableName: table.name
        }
      );
    }

    const dimensions = table.columns.map((column: MetadataColumnLike): SemanticDimensionDefinition => ({
      id: toSemanticDimensionId(column.name),
      qualifiedId: `${modelId}.${toSemanticDimensionId(column.name)}`,
      label: column.name,
      columnName: column.name,
      dataType: inferSemanticDataType(column.dataType),
      isPrimaryKey: column.name === primaryKey,
      isTimeDimension: inferSemanticDataType(column.dataType) === "date"
    }));

    return {
      id: modelId,
      label: table.name,
      tableName: table.name,
      primaryKey,
      description: `Generated semantic model for ${table.name}`,
      owner: "generated",
      refreshCadence: "unknown",
      synonyms: [table.name],
      dimensions,
      defaultMetricIds: [`${modelId}_count`]
    } satisfies SemanticModelDefinition;
  });
  const metrics = models.map((model): SemanticMetricDefinition => {
    const defaultTimeDimensionId = model.dimensions.find(
      (dimension: SemanticDimensionDefinition) => dimension.isTimeDimension
    )?.qualifiedId;

    return {
      id: `${model.id}_count`,
      label: `${model.label} Count`,
      modelId: model.id,
      tableName: model.tableName,
      aggregation: "count" as const,
      columnName: model.primaryKey,
      description: `Generated row count metric for ${model.tableName}`,
      owner: "generated",
      refreshCadence: "unknown",
      synonyms: [`${model.label} rows`, `${model.tableName} count`],
      format: "integer" as const,
      allowedDimensionIds: model.dimensions.map(
        (dimension: SemanticDimensionDefinition) => dimension.qualifiedId
      ),
      defaultTimeDimensionId,
      filters: []
    } satisfies SemanticMetricDefinition;
  });

  return {
    version: 1,
    sourcePath: options.sourcePath ?? `generated://${new Date().toISOString()}`,
    loadedAt: options.loadedAt ?? new Date().toISOString(),
    models,
    metrics,
    summary: {
      modelCount: models.length,
      metricCount: metrics.length,
      dimensionCount: models.reduce((sum, model) => sum + model.dimensions.length, 0),
      ownerCount: 1
    }
  };
}

export function buildSemanticCatalogInsights(
  catalog: SemanticCatalog,
  options: {
    readonly modelLimit?: number;
    readonly metricLimit?: number;
  } = {}
): SemanticCatalogInsights {
  const modelLimit = options.modelLimit ?? 6;
  const metricLimit = options.metricLimit ?? 10;

  if (!Number.isInteger(modelLimit) || modelLimit <= 0 || modelLimit > 50) {
    throw new AppError("modelLimit must be between 1 and 50", "INVALID_SEMANTIC_MODEL_LIMIT", 400, {
      modelLimit
    });
  }

  if (!Number.isInteger(metricLimit) || metricLimit <= 0 || metricLimit > 50) {
    throw new AppError("metricLimit must be between 1 and 50", "INVALID_SEMANTIC_METRIC_LIMIT", 400, {
      metricLimit
    });
  }

  const metricCountByModel = catalog.metrics.reduce((counts, metric) => {
    counts.set(metric.modelId, (counts.get(metric.modelId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const ownerCounts = new Map<string, { modelCount: number; metricCount: number }>();

  for (const model of catalog.models) {
    if (!model.owner) {
      continue;
    }

    ownerCounts.set(model.owner, {
      modelCount: (ownerCounts.get(model.owner)?.modelCount ?? 0) + 1,
      metricCount: ownerCounts.get(model.owner)?.metricCount ?? 0
    });
  }

  for (const metric of catalog.metrics) {
    if (!metric.owner) {
      continue;
    }

    ownerCounts.set(metric.owner, {
      modelCount: ownerCounts.get(metric.owner)?.modelCount ?? 0,
      metricCount: (ownerCounts.get(metric.owner)?.metricCount ?? 0) + 1
    });
  }

  return {
    summary: catalog.summary,
    models: catalog.models
      .map(
        (model): SemanticModelInsight => ({
          modelId: model.id,
          label: model.label,
          tableName: model.tableName,
          dimensionCount: model.dimensions.length,
          metricCount: metricCountByModel.get(model.id) ?? 0,
          owner: model.owner,
          refreshCadence: model.refreshCadence
        })
      )
      .sort(
        (left, right) =>
          right.metricCount - left.metricCount ||
          right.dimensionCount - left.dimensionCount ||
          left.label.localeCompare(right.label)
      )
      .slice(0, modelLimit),
    metrics: catalog.metrics
      .map(
        (metric): SemanticMetricInsight => ({
          metricId: metric.id,
          label: metric.label,
          modelId: metric.modelId,
          aggregation: metric.aggregation,
          owner: metric.owner,
          format: metric.format,
          defaultTimeDimensionId: metric.defaultTimeDimensionId,
          allowedDimensionCount: metric.allowedDimensionIds.length
        })
      )
      .sort((left, right) => left.label.localeCompare(right.label))
      .slice(0, metricLimit),
    owners: [...ownerCounts.entries()]
      .map(([owner, counts]) => ({
        owner,
        modelCount: counts.modelCount,
        metricCount: counts.metricCount
      }))
      .sort(
        (left, right) =>
          right.metricCount - left.metricCount ||
          right.modelCount - left.modelCount ||
          left.owner.localeCompare(right.owner)
      )
  };
}

export function buildSemanticMetricQuery(
  catalog: SemanticCatalog,
  request: SemanticMetricQueryRequest,
  options: {
    readonly maxLimit?: number;
  } = {}
): SemanticMetricQuery {
  if (!Array.isArray(request.metricIds) || request.metricIds.length === 0) {
    throw new AppError("metricIds cannot be empty", "SEMANTIC_METRIC_IDS_REQUIRED", 400);
  }

  const maxLimit = options.maxLimit ?? 500;

  if (!Number.isInteger(maxLimit) || maxLimit <= 0 || maxLimit > 5000) {
    throw new AppError("maxLimit must be between 1 and 5000", "INVALID_SEMANTIC_MAX_LIMIT", 500, {
      maxLimit
    });
  }

  const modelIndex = new Map(catalog.models.map((model) => [canonicalName(model.id), model] as const));
  const metricIndex = new Map(catalog.metrics.map((metric) => [canonicalName(metric.id), metric] as const));
  const metrics = dedupeById(
    request.metricIds.map((metricId) => resolveMetric(metricId, metricIndex))
  );
  const modelIds = [...new Set(metrics.map((metric) => metric.modelId))];

  if (modelIds.length !== 1) {
    throw new AppError(
      "All requested metrics must belong to the same semantic model",
      "SEMANTIC_MODEL_MISMATCH",
      400,
      {
        modelIds
      }
    );
  }

  const model = resolveModel(modelIds[0], modelIndex);
  const dimensionIndex = new Map(
    model.dimensions.flatMap((dimension) => [
      [canonicalName(dimension.qualifiedId), dimension],
      [canonicalName(dimension.id), dimension]
    ])
  );
  const requestedDimensions = dedupeById(
    (request.dimensionIds ?? []).map((dimensionId) => resolveDimension(dimensionId, model, dimensionIndex))
  );
  const resolvedTimeDimension =
    typeof request.timeDimensionId === "string"
      ? resolveDimension(request.timeDimensionId, model, dimensionIndex)
      : request.timeGrain && metrics[0]?.defaultTimeDimensionId
        ? resolveDimension(metrics[0].defaultTimeDimensionId, model, dimensionIndex)
        : undefined;
  const dimensions = dedupeById([
    ...requestedDimensions,
    ...(resolvedTimeDimension ? [resolvedTimeDimension] : [])
  ]);
  const timeGrain =
    resolvedTimeDimension && request.timeGrain ? request.timeGrain : resolvedTimeDimension ? "raw" : undefined;

  if (timeGrain && !resolvedTimeDimension) {
    throw new AppError(
      "A time dimension is required when timeGrain is provided",
      "SEMANTIC_TIME_DIMENSION_REQUIRED",
      400
    );
  }

  if (
    typeof request.limit !== "undefined" &&
    (!Number.isInteger(request.limit) || request.limit <= 0 || request.limit > maxLimit)
  ) {
    throw new AppError(
      `Semantic query limit must be between 1 and ${maxLimit}`,
      "INVALID_SEMANTIC_QUERY_LIMIT",
      400,
      {
        limit: request.limit,
        maxLimit
      }
    );
  }

  const allowedDimensionIds = intersectAllowedDimensionIds(model, metrics);

  for (const dimension of dimensions) {
    if (!allowedDimensionIds.has(dimension.qualifiedId)) {
      throw new AppError(
        `Metric query cannot group by dimension ${dimension.qualifiedId}`,
        "SEMANTIC_DIMENSION_NOT_ALLOWED",
        400,
        {
          dimensionId: dimension.qualifiedId
        }
      );
    }
  }

  const requestFilters = (request.filters ?? []).map((filter) =>
    normalizeFilter(filter, model, dimensionIndex)
  );

  for (const filter of requestFilters) {
    if (!allowedDimensionIds.has(filter.dimensionId)) {
      throw new AppError(
        `Metric query cannot filter on dimension ${filter.dimensionId}`,
        "SEMANTIC_FILTER_DIMENSION_NOT_ALLOWED",
        400,
        {
          dimensionId: filter.dimensionId
        }
      );
    }
  }

  const limit = request.limit ?? (dimensions.length > 0 ? 50 : 1);
  const dimensionSelects = dimensions.map((dimension) =>
    buildDimensionSelect(dimension, timeGrain, resolvedTimeDimension)
  );
  const metricSelects = metrics.map((metric) => buildMetricSelect(metric, model, dimensionIndex));
  const whereClauses = requestFilters.map((filter) =>
    buildFilterSql(resolveDimension(filter.dimensionId, model, dimensionIndex), filter)
  );
  const selectClauses = [
    ...dimensionSelects.map((item) => `${item.expression} as ${quoteIdentifier(item.alias)}`),
    ...metricSelects.map((item) => `${item.expression} as ${quoteIdentifier(item.alias)}`)
  ];
  const groupByClauses =
    dimensions.length > 0 ? dimensionSelects.map((item) => item.groupByExpression) : [];
  const orderByClauses =
    dimensions.length === 0
      ? []
      : resolvedTimeDimension
        ? [quoteIdentifier(dimensionSelects[0]?.alias ?? buildSqlAlias("time"))]
        : [quoteIdentifier(metricSelects[0]?.alias ?? buildSqlAlias(metrics[0].id)) + " desc"];
  const sqlLines = [
    `select ${selectClauses.join(", ")}`,
    `from ${quoteIdentifier(model.tableName)}`
  ];

  if (whereClauses.length > 0) {
    sqlLines.push(`where ${whereClauses.join(" and ")}`);
  }

  if (groupByClauses.length > 0) {
    sqlLines.push(`group by ${groupByClauses.join(", ")}`);
  }

  if (orderByClauses.length > 0) {
    sqlLines.push(`order by ${orderByClauses.join(", ")}`);
  }

  sqlLines.push(`limit ${limit}`);

  const referencedColumns = dedupeStrings([
    ...dimensions.map((dimension) => `${model.tableName}.${dimension.columnName}`),
    ...metrics
      .map((metric) => (metric.columnName ? `${model.tableName}.${metric.columnName}` : undefined))
      .filter((entry): entry is string => typeof entry === "string"),
    ...requestFilters.map((filter) => {
      const dimension = resolveDimension(filter.dimensionId, model, dimensionIndex);
      return `${model.tableName}.${dimension.columnName}`;
    }),
    ...metrics.flatMap((metric) =>
      metric.filters.map((filter) => {
        const dimension = resolveDimension(filter.dimensionId, model, dimensionIndex);
        return `${model.tableName}.${dimension.columnName}`;
      })
    )
  ]);

  return {
    modelId: model.id,
    modelLabel: model.label,
    metricIds: metrics.map((metric) => metric.id),
    dimensionIds: dimensions.map((dimension) => dimension.qualifiedId),
    timeDimensionId: resolvedTimeDimension?.qualifiedId,
    timeGrain,
    limit,
    sql: sqlLines.join("\n"),
    metrics: metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      aggregation: metric.aggregation,
      columnName: metric.columnName
    })),
    dimensions: dimensions.map((dimension) => ({
      id: dimension.qualifiedId,
      label: dimension.label,
      columnName: dimension.columnName,
      dataType: dimension.dataType
    })),
    filters: requestFilters,
    referencedTables: [model.tableName],
    referencedColumns
  };
}

function normalizeSemanticCatalog(
  source: unknown,
  metadataCatalog: MetadataCatalogLike,
  sourcePath: string,
  loadedAt: string
): SemanticCatalog {
  if (!isPlainObject(source)) {
    throw new AppError("Semantic catalog must be an object", "INVALID_SEMANTIC_CATALOG", 500, {
      sourcePath
    });
  }

  if (source.version !== 1) {
    throw new AppError("Semantic catalog version must be 1", "INVALID_SEMANTIC_CATALOG_VERSION", 500, {
      sourcePath,
      version: source.version
    });
  }

  if (!Array.isArray(source.models) || source.models.length === 0) {
    throw new AppError("Semantic catalog models cannot be empty", "INVALID_SEMANTIC_MODELS", 500, {
      sourcePath
    });
  }

  if (!Array.isArray(source.metrics) || source.metrics.length === 0) {
    throw new AppError("Semantic catalog metrics cannot be empty", "INVALID_SEMANTIC_METRICS", 500, {
      sourcePath
    });
  }

  const tableIndex = new Map(
    metadataCatalog.tables.flatMap((table) => [
      [canonicalName(table.name), table],
      [canonicalName(stripQuotes(table.name)), table]
    ])
  );
  const rawModels = source.models;
  const rawMetrics = source.metrics;
  const seenModelIds = new Set<string>();
  const seenMetricIds = new Set<string>();
  const models = rawModels.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new AppError("Semantic model entries must be objects", "INVALID_SEMANTIC_MODEL", 500, {
        sourcePath
      });
    }

    const id = requireSemanticString(entry.id, "model.id");
    const modelIdKey = canonicalName(id);

    if (seenModelIds.has(modelIdKey)) {
      throw new AppError(`Duplicate semantic model: ${id}`, "DUPLICATE_SEMANTIC_MODEL", 500, {
        sourcePath,
        modelId: id
      });
    }

    seenModelIds.add(modelIdKey);

    const tableName = requireSemanticString(entry.tableName, `model ${id}.tableName`);
    const table = tableIndex.get(canonicalName(tableName));

    if (!table) {
      throw new AppError(
        `Semantic model ${id} references unknown table ${tableName}`,
        "SEMANTIC_TABLE_NOT_FOUND",
        500,
        {
          sourcePath,
          modelId: id,
          tableName
        }
      );
    }

    const columnIndex = new Map(
      table.columns.flatMap((column) => [
        [canonicalName(column.name), column],
        [canonicalName(stripQuotes(column.name)), column]
      ])
    );
    const primaryKey = requireSemanticString(entry.primaryKey, `model ${id}.primaryKey`);

    if (!columnIndex.has(canonicalName(primaryKey))) {
      throw new AppError(
        `Semantic model ${id} references unknown primary key ${primaryKey}`,
        "SEMANTIC_PRIMARY_KEY_NOT_FOUND",
        500,
        {
          sourcePath,
          modelId: id,
          primaryKey
        }
      );
    }

    if (!Array.isArray(entry.dimensions) || entry.dimensions.length === 0) {
      throw new AppError(
        `Semantic model ${id} must declare dimensions`,
        "SEMANTIC_DIMENSIONS_REQUIRED",
        500,
        {
          sourcePath,
          modelId: id
        }
      );
    }

    const seenDimensionIds = new Set<string>();
    const dimensions = entry.dimensions.map((dimensionEntry) => {
      if (!isPlainObject(dimensionEntry)) {
        throw new AppError("Semantic dimension entries must be objects", "INVALID_SEMANTIC_DIMENSION", 500, {
          sourcePath,
          modelId: id
        });
      }

      const dimensionId = requireSemanticString(dimensionEntry.id, `model ${id}.dimension.id`);
      const qualifiedId = `${id}.${dimensionId}`;
      const dimensionIdKey = canonicalName(dimensionId);

      if (seenDimensionIds.has(dimensionIdKey)) {
        throw new AppError(
          `Duplicate semantic dimension ${dimensionId} in model ${id}`,
          "DUPLICATE_SEMANTIC_DIMENSION",
          500,
          {
            sourcePath,
            modelId: id,
            dimensionId
          }
        );
      }

      seenDimensionIds.add(dimensionIdKey);

      const columnName = requireSemanticString(
        dimensionEntry.columnName,
        `model ${id}.dimension ${dimensionId}.columnName`
      );
      const column = columnIndex.get(canonicalName(columnName));

      if (!column) {
        throw new AppError(
          `Semantic dimension ${qualifiedId} references unknown column ${columnName}`,
          "SEMANTIC_COLUMN_NOT_FOUND",
          500,
          {
            sourcePath,
            modelId: id,
            dimensionId,
            columnName
          }
        );
      }

      const dataType = normalizeSemanticDataType(dimensionEntry.dataType, column.dataType);

      return {
        id: dimensionId,
        qualifiedId,
        label: requireSemanticString(dimensionEntry.label, `model ${id}.dimension ${dimensionId}.label`),
        columnName: column.name,
        dataType,
        description: normalizeOptionalSemanticString(dimensionEntry.description),
        synonyms: normalizeSemanticStringArray(dimensionEntry.synonyms, `model ${id}.dimension ${dimensionId}.synonyms`),
        isPrimaryKey: column.name === primaryKey,
        isTimeDimension:
          typeof dimensionEntry.isTimeDimension === "boolean"
            ? dimensionEntry.isTimeDimension
            : dataType === "date"
      } satisfies SemanticDimensionDefinition;
    });

    return {
      id,
      label: requireSemanticString(entry.label, `model ${id}.label`),
      tableName: table.name,
      primaryKey,
      description: normalizeOptionalSemanticString(entry.description),
      owner: normalizeOptionalSemanticString(entry.owner),
      refreshCadence: normalizeOptionalSemanticString(entry.refreshCadence),
      synonyms: normalizeSemanticStringArray(entry.synonyms, `model ${id}.synonyms`),
      dimensions,
      defaultMetricIds: []
    } satisfies SemanticModelDefinition;
  });
  const modelIndex = new Map(models.map((model) => [canonicalName(model.id), model] as const));
  const metrics = rawMetrics.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new AppError("Semantic metric entries must be objects", "INVALID_SEMANTIC_METRIC", 500, {
        sourcePath
      });
    }

    const id = requireSemanticString(entry.id, "metric.id");
    const metricIdKey = canonicalName(id);

    if (seenMetricIds.has(metricIdKey)) {
      throw new AppError(`Duplicate semantic metric: ${id}`, "DUPLICATE_SEMANTIC_METRIC", 500, {
        sourcePath,
        metricId: id
      });
    }

    seenMetricIds.add(metricIdKey);

    const modelId = requireSemanticString(entry.modelId, `metric ${id}.modelId`);
    const model = modelIndex.get(canonicalName(modelId));

    if (!model) {
      throw new AppError(
        `Semantic metric ${id} references unknown model ${modelId}`,
        "SEMANTIC_MODEL_NOT_FOUND",
        500,
        {
          sourcePath,
          metricId: id,
          modelId
        }
      );
    }

    const aggregation = normalizeMetricAggregation(entry.aggregation, id);
    const columnName =
      typeof entry.columnName === "undefined"
        ? undefined
        : requireSemanticString(entry.columnName, `metric ${id}.columnName`);
    const dimensionIndex = new Map(
      model.dimensions.flatMap((dimension) => [
        [canonicalName(dimension.qualifiedId), dimension],
        [canonicalName(dimension.id), dimension]
      ])
    );

    if (columnName) {
      const dimension = model.dimensions.find(
        (entryDimension) => canonicalName(entryDimension.columnName) === canonicalName(columnName)
      );

      if (!dimension) {
        throw new AppError(
          `Semantic metric ${id} references unknown column ${columnName}`,
          "SEMANTIC_COLUMN_NOT_FOUND",
          500,
          {
            sourcePath,
            metricId: id,
            columnName
          }
        );
      }
    }

    if (
      (aggregation === "countDistinct" ||
        aggregation === "sum" ||
        aggregation === "average" ||
        aggregation === "minimum" ||
        aggregation === "maximum") &&
      !columnName
    ) {
      throw new AppError(
        `Semantic metric ${id} requires columnName for aggregation ${aggregation}`,
        "SEMANTIC_METRIC_COLUMN_REQUIRED",
        500,
        {
          sourcePath,
          metricId: id,
          aggregation
        }
      );
    }

    const allowedDimensionIds = normalizeAllowedDimensionIds(
      entry.allowedDimensionIds,
      model,
      dimensionIndex,
      `metric ${id}.allowedDimensionIds`
    );
    const defaultTimeDimensionId = normalizeOptionalDimensionId(
      entry.defaultTimeDimensionId,
      model,
      dimensionIndex,
      `metric ${id}.defaultTimeDimensionId`
    );
    const filters = normalizeMetricFilters(
      entry.filters,
      model,
      dimensionIndex,
      `metric ${id}.filters`
    );

    return {
      id,
      label: requireSemanticString(entry.label, `metric ${id}.label`),
      modelId: model.id,
      tableName: model.tableName,
      aggregation,
      columnName,
      description: normalizeOptionalSemanticString(entry.description),
      owner: normalizeOptionalSemanticString(entry.owner),
      refreshCadence: normalizeOptionalSemanticString(entry.refreshCadence),
      synonyms: normalizeSemanticStringArray(entry.synonyms, `metric ${id}.synonyms`),
      format: normalizeMetricFormat(entry.format, id),
      allowedDimensionIds:
        defaultTimeDimensionId && !allowedDimensionIds.includes(defaultTimeDimensionId)
          ? [...allowedDimensionIds, defaultTimeDimensionId]
          : allowedDimensionIds,
      defaultTimeDimensionId,
      filters
    } satisfies SemanticMetricDefinition;
  });
  const metricsByModel = new Map<string, string[]>();

  for (const metric of metrics) {
    const current = metricsByModel.get(metric.modelId) ?? [];
    current.push(metric.id);
    metricsByModel.set(metric.modelId, current);
  }

  const normalizedModels = models.map((model) => {
    const rawModel = rawModels.find(
      (entry) => isPlainObject(entry) && canonicalName(String(entry.id)) === canonicalName(model.id)
    );
    const defaultMetricIds =
      rawModel && isPlainObject(rawModel)
        ? normalizeDefaultMetricIds(
            rawModel.defaultMetricIds,
            model,
            metricsByModel.get(model.id) ?? [],
            `model ${model.id}.defaultMetricIds`
          )
        : [];

    return {
      ...model,
      defaultMetricIds:
        defaultMetricIds.length > 0 ? defaultMetricIds : metricsByModel.get(model.id) ?? []
    };
  });
  const owners = new Set(
    [
      ...normalizedModels.map((model) => model.owner),
      ...metrics.map((metric) => metric.owner)
    ].filter((owner): owner is string => typeof owner === "string" && owner.length > 0)
  );

  return {
    version: 1,
    sourcePath,
    loadedAt,
    models: normalizedModels,
    metrics,
    summary: {
      modelCount: normalizedModels.length,
      metricCount: metrics.length,
      dimensionCount: normalizedModels.reduce((sum, model) => sum + model.dimensions.length, 0),
      ownerCount: owners.size
    }
  };
}

function normalizeAllowedDimensionIds(
  value: unknown,
  model: SemanticModelDefinition,
  dimensionIndex: ReadonlyMap<string, SemanticDimensionDefinition>,
  path: string
): readonly string[] {
  if (typeof value === "undefined") {
    return model.dimensions.map((dimension) => dimension.qualifiedId);
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${path} must be an array`, "INVALID_SEMANTIC_DIMENSION_LIST", 500, {
      path
    });
  }

  return dedupeStrings(
    value.map((entry) => {
      const dimension = resolveDimension(String(entry), model, dimensionIndex);
      return dimension.qualifiedId;
    })
  );
}

function normalizeOptionalDimensionId(
  value: unknown,
  model: SemanticModelDefinition,
  dimensionIndex: ReadonlyMap<string, SemanticDimensionDefinition>,
  path: string
): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  const dimension = resolveDimension(requireSemanticString(value, path), model, dimensionIndex);
  return dimension.qualifiedId;
}

function normalizeDefaultMetricIds(
  value: unknown,
  model: SemanticModelDefinition,
  metricIds: readonly string[],
  path: string
): readonly string[] {
  if (typeof value === "undefined") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${path} must be an array`, "INVALID_SEMANTIC_METRIC_LIST", 500, {
      path
    });
  }

  const metricIdSet = new Set(metricIds.map((metricId) => canonicalName(metricId)));

  return dedupeStrings(
    value.map((entry) => {
      const metricId = requireSemanticString(entry, path);

      if (!metricIdSet.has(canonicalName(metricId))) {
        throw new AppError(
          `Model ${model.id} default metric ${metricId} was not found`,
          "SEMANTIC_DEFAULT_METRIC_NOT_FOUND",
          500,
          {
            modelId: model.id,
            metricId
          }
        );
      }

      return metricIds.find((entryMetricId) => canonicalName(entryMetricId) === canonicalName(metricId)) ?? metricId;
    })
  );
}

function normalizeMetricFilters(
  value: unknown,
  model: SemanticModelDefinition,
  dimensionIndex: ReadonlyMap<string, SemanticDimensionDefinition>,
  path: string
): readonly SemanticMetricFilterDefinition[] {
  if (typeof value === "undefined") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${path} must be an array`, "INVALID_SEMANTIC_FILTERS", 500, {
      path
    });
  }

  return value.map((entry) => normalizeFilter(entry, model, dimensionIndex));
}

function normalizeFilter(
  value: unknown,
  model: SemanticModelDefinition,
  dimensionIndex: ReadonlyMap<string, SemanticDimensionDefinition>
): SemanticMetricFilterDefinition {
  if (!isPlainObject(value)) {
    throw new AppError("Semantic filters must be objects", "INVALID_SEMANTIC_FILTER", 400);
  }

  const dimension = resolveDimension(
    requireSemanticString(value.dimensionId, "filter.dimensionId"),
    model,
    dimensionIndex
  );
  const operator = normalizeFilterOperator(value.operator);

  if (!Array.isArray(value.values) || value.values.length === 0) {
    throw new AppError("Semantic filters must include values", "INVALID_SEMANTIC_FILTER_VALUES", 400, {
      dimensionId: dimension.qualifiedId
    });
  }

  const values = value.values.map((entry) => normalizeFilterValue(entry, dimension.qualifiedId));

  if (operator !== "in" && values.length !== 1) {
    throw new AppError(
      `Filter ${dimension.qualifiedId} with operator ${operator} must include exactly one value`,
      "INVALID_SEMANTIC_FILTER_VALUES",
      400,
      {
        dimensionId: dimension.qualifiedId,
        operator,
        valueCount: values.length
      }
    );
  }

  return {
    dimensionId: dimension.qualifiedId,
    operator,
    values
  };
}

function buildDimensionSelect(
  dimension: SemanticDimensionDefinition,
  timeGrain: SemanticTimeGrain | undefined,
  resolvedTimeDimension: SemanticDimensionDefinition | undefined
): {
  readonly expression: string;
  readonly groupByExpression: string;
  readonly alias: string;
} {
  const quotedColumn = quoteIdentifier(dimension.columnName);
  const alias = buildSqlAlias(
    dimension === resolvedTimeDimension && timeGrain && timeGrain !== "raw"
      ? `${dimension.qualifiedId}_${timeGrain}`
      : dimension.qualifiedId
  );

  if (dimension === resolvedTimeDimension && timeGrain && timeGrain !== "raw") {
    const expression = `date_trunc('${timeGrain}', ${quotedColumn})`;

    return {
      expression,
      groupByExpression: expression,
      alias
    };
  }

  return {
    expression: quotedColumn,
    groupByExpression: quotedColumn,
    alias
  };
}

function buildMetricSelect(
  metric: SemanticMetricDefinition,
  model: SemanticModelDefinition,
  dimensionIndex: ReadonlyMap<string, SemanticDimensionDefinition>
): {
  readonly expression: string;
  readonly alias: string;
} {
  const aggregateExpression = buildAggregateExpression(metric);

  if (metric.filters.length === 0) {
    return {
      expression: aggregateExpression,
      alias: buildSqlAlias(metric.id)
    };
  }

  const filterSql = metric.filters
    .map((filter) => buildFilterSql(resolveDimension(filter.dimensionId, model, dimensionIndex), filter))
    .join(" and ");

  return {
    expression: `${aggregateExpression} filter (where ${filterSql})`,
    alias: buildSqlAlias(metric.id)
  };
}

function buildAggregateExpression(metric: SemanticMetricDefinition): string {
  const quotedColumn =
    typeof metric.columnName === "string" ? quoteIdentifier(metric.columnName) : undefined;

  switch (metric.aggregation) {
    case "count":
      return quotedColumn ? `count(${quotedColumn})` : "count(*)";
    case "countDistinct":
      return `count(distinct ${quotedColumn})`;
    case "sum":
      return `sum(${quotedColumn})`;
    case "average":
      return `avg(${quotedColumn})`;
    case "minimum":
      return `min(${quotedColumn})`;
    case "maximum":
      return `max(${quotedColumn})`;
    default:
      throw new AppError("Unsupported semantic metric aggregation", "INVALID_SEMANTIC_AGGREGATION", 500, {
        aggregation: metric.aggregation
      });
  }
}

function buildFilterSql(
  dimension: SemanticDimensionDefinition,
  filter: SemanticMetricFilterDefinition
): string {
  const columnExpression = quoteIdentifier(dimension.columnName);

  if (filter.operator === "in") {
    return `${columnExpression} in (${filter.values.map(serializeSqlLiteral).join(", ")})`;
  }

  return `${columnExpression} ${filter.operator} ${serializeSqlLiteral(filter.values[0])}`;
}

function intersectAllowedDimensionIds(
  model: SemanticModelDefinition,
  metrics: readonly SemanticMetricDefinition[]
): ReadonlySet<string> {
  const defaultDimensions = new Set(model.dimensions.map((dimension) => dimension.qualifiedId));
  let current = defaultDimensions;

  for (const metric of metrics) {
    const next = new Set(metric.allowedDimensionIds);
    current = new Set([...current].filter((dimensionId) => next.has(dimensionId)));
  }

  return current;
}

function resolveModel(
  modelId: string,
  index: ReadonlyMap<string, SemanticModelDefinition>
): SemanticModelDefinition {
  const model = index.get(canonicalName(modelId));

  if (!model) {
    throw new AppError(`Unknown semantic model: ${modelId}`, "SEMANTIC_MODEL_NOT_FOUND", 400, {
      modelId
    });
  }

  return model;
}

function resolveMetric(
  metricId: string,
  index: ReadonlyMap<string, SemanticMetricDefinition>
): SemanticMetricDefinition {
  const metric = index.get(canonicalName(metricId));

  if (!metric) {
    throw new AppError(`Unknown semantic metric: ${metricId}`, "SEMANTIC_METRIC_NOT_FOUND", 400, {
      metricId
    });
  }

  return metric;
}

function resolveDimension(
  dimensionId: string,
  model: SemanticModelDefinition,
  index: ReadonlyMap<string, SemanticDimensionDefinition>
): SemanticDimensionDefinition {
  const dimension = index.get(canonicalName(dimensionId));

  if (!dimension) {
    throw new AppError(
      `Unknown semantic dimension ${dimensionId} for model ${model.id}`,
      "SEMANTIC_DIMENSION_NOT_FOUND",
      400,
      {
        modelId: model.id,
        dimensionId
      }
    );
  }

  return dimension;
}

function normalizeSemanticDataType(
  value: unknown,
  metadataDataType: string
): SemanticDataType {
  if (value === "string" || value === "number" || value === "boolean" || value === "date") {
    return value;
  }

  return inferSemanticDataType(metadataDataType);
}

function inferSemanticDataType(metadataDataType: string): SemanticDataType {
  const normalized = canonicalName(metadataDataType);

  if (
    normalized.includes("int") ||
    normalized.includes("float") ||
    normalized.includes("decimal") ||
    normalized.includes("numeric") ||
    normalized.includes("double")
  ) {
    return "number";
  }

  if (normalized.includes("bool")) {
    return "boolean";
  }

  if (
    normalized.includes("date") ||
    normalized.includes("time") ||
    normalized.includes("timestamp")
  ) {
    return "date";
  }

  return "string";
}

function toSemanticModelId(tableName: string): string {
  return buildSemanticIdentifier(tableName);
}

function toSemanticDimensionId(columnName: string): string {
  return buildSemanticIdentifier(columnName);
}

function buildSemanticIdentifier(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return "field";
  }

  return parts
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`
    )
    .join("");
}

function normalizeMetricAggregation(
  value: unknown,
  metricId: string
): SemanticMetricAggregation {
  if (
    value === "count" ||
    value === "countDistinct" ||
    value === "sum" ||
    value === "average" ||
    value === "minimum" ||
    value === "maximum"
  ) {
    return value;
  }

  throw new AppError(
    `Metric ${metricId} has an invalid aggregation`,
    "INVALID_SEMANTIC_AGGREGATION",
    500,
    {
      metricId,
      aggregation: value
    }
  );
}

function normalizeMetricFormat(
  value: unknown,
  metricId: string
): SemanticMetricFormat | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (value === "integer" || value === "number" || value === "currency" || value === "percent") {
    return value;
  }

  throw new AppError(`Metric ${metricId} has an invalid format`, "INVALID_SEMANTIC_FORMAT", 500, {
    metricId,
    format: value
  });
}

function normalizeFilterOperator(value: unknown): SemanticFilterOperator {
  if (
    value === "=" ||
    value === "!=" ||
    value === ">" ||
    value === ">=" ||
    value === "<" ||
    value === "<=" ||
    value === "in"
  ) {
    return value;
  }

  throw new AppError("Semantic filter operator is invalid", "INVALID_SEMANTIC_FILTER_OPERATOR", 400, {
    operator: value
  });
}

function normalizeFilterValue(value: unknown, dimensionId: string): SemanticFilterValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new AppError(
        `Filter ${dimensionId} contains a non-finite number`,
        "INVALID_SEMANTIC_FILTER_VALUE",
        400,
        {
          dimensionId
        }
      );
    }

    return value;
  }

  throw new AppError(
    `Filter ${dimensionId} contains an unsupported value type`,
    "INVALID_SEMANTIC_FILTER_VALUE",
    400,
    {
      dimensionId
    }
  );
}

function requireSemanticString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`${path} must be a non-empty string`, "INVALID_SEMANTIC_VALUE", 500, {
      path
    });
  }

  return value.trim();
}

function normalizeOptionalSemanticString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeSemanticStringArray(
  value: unknown,
  path: string
): readonly string[] | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(`${path} must be an array`, "INVALID_SEMANTIC_VALUE", 500, {
      path
    });
  }

  return dedupeStrings(value.map((entry) => requireSemanticString(entry, path)));
}

function scoreSemanticMatch(
  values: readonly (string | undefined)[],
  queryKey: string
): number {
  let bestScore = 0;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const valueKey = canonicalName(value);

    if (valueKey === queryKey) {
      bestScore = Math.max(bestScore, 100);
      continue;
    }

    if (valueKey.startsWith(queryKey)) {
      bestScore = Math.max(bestScore, 78);
      continue;
    }

    if (valueKey.includes(queryKey)) {
      bestScore = Math.max(bestScore, 55);
    }
  }

  return bestScore;
}

function serializeSqlLiteral(value: SemanticFilterValue): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError("SQL literal number must be finite", "INVALID_SEMANTIC_FILTER_VALUE", 400);
    }

    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}

function buildSqlAlias(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "field";
}

function stripQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}

function canonicalName(value: string): string {
  return stripQuotes(value).toLowerCase().replace(/[_\s.-]/g, "");
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function dedupeById<T extends { readonly id?: string; readonly qualifiedId?: string }>(
  values: readonly T[]
): readonly T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const value of values) {
    const key = value.qualifiedId ?? value.id;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
