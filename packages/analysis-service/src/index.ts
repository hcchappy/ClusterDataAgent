import { AppError, createLogger } from "@clusterdata/shared";

const logger = createLogger("analysis-service");
const DEFAULT_MAX_CATEGORY_VALUES = 8;
const DEFAULT_OUTLIER_THRESHOLD = 2.5;
const NUMBER_EPSILON = 1e-6;

export type DatasetRow = Readonly<Record<string, unknown>>;
export type FieldKind = "number" | "string" | "boolean" | "date" | "mixed" | "empty";

export interface SeriesSummary {
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly median: number;
  readonly standardDeviation: number;
  readonly trend: "flat" | "rising" | "falling";
}

export interface OutlierPoint {
  readonly index: number;
  readonly value: number;
  readonly score: number;
}

export interface DatasetProfileRequest {
  readonly rows: readonly DatasetRow[];
  readonly maxCategoryValues?: number;
  readonly outlierThreshold?: number;
}

export interface DatasetProfile {
  readonly rowCount: number;
  readonly fieldCount: number;
  readonly fields: readonly FieldProfile[];
  readonly quality: DatasetQualitySummary;
}

export type FieldProfile =
  | NumberFieldProfile
  | StringFieldProfile
  | BooleanFieldProfile
  | DateFieldProfile
  | MixedFieldProfile
  | EmptyFieldProfile;

export interface BaseFieldProfile {
  readonly name: string;
  readonly kind: FieldKind;
  readonly count: number;
  readonly missingCount: number;
  readonly missingRatio: number;
  readonly distinctCount: number;
  readonly examples: readonly unknown[];
}

export interface NumberFieldProfile extends BaseFieldProfile {
  readonly kind: "number";
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly median: number;
  readonly standardDeviation: number;
  readonly outliers: readonly OutlierPoint[];
}

export interface StringFieldProfile extends BaseFieldProfile {
  readonly kind: "string";
  readonly topValues: readonly CategoryCount[];
}

export interface BooleanFieldProfile extends BaseFieldProfile {
  readonly kind: "boolean";
  readonly trueCount: number;
  readonly falseCount: number;
}

export interface DateFieldProfile extends BaseFieldProfile {
  readonly kind: "date";
  readonly minimum: string;
  readonly maximum: string;
}

export interface MixedFieldProfile extends BaseFieldProfile {
  readonly kind: "mixed";
  readonly detectedKinds: readonly FieldKind[];
}

export interface EmptyFieldProfile extends BaseFieldProfile {
  readonly kind: "empty";
}

export interface CategoryCount {
  readonly value: string;
  readonly count: number;
}

export interface DatasetQualitySummary {
  readonly emptyFieldCount: number;
  readonly highMissingFieldCount: number;
  readonly mixedFieldCount: number;
  readonly duplicateRowCount: number;
  readonly warnings: readonly string[];
}

interface FieldAccumulator {
  readonly name: string;
  count: number;
  missingCount: number;
  readonly values: unknown[];
  readonly distinctValues: Set<string>;
  readonly examples: unknown[];
  readonly kindCounts: Map<FieldKind, number>;
}

export function summarizeSeries(points: readonly number[]): SeriesSummary {
  assertNonEmptySeries(points);

  const sorted = [...points].sort((left, right) => left - right);
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  const average = points.reduce((sum, value) => sum + value, 0) / points.length;
  const median = calculateMedian(sorted);
  const variance =
    points.reduce((sum, value) => sum + (value - average) ** 2, 0) / points.length;
  const standardDeviation = Math.sqrt(variance);
  const delta = points[points.length - 1] - points[0];

  logger.info("series summarized", {
    count: points.length,
    minimum,
    maximum,
    trend: Math.abs(delta) < NUMBER_EPSILON ? "flat" : delta > 0 ? "rising" : "falling"
  });

  return {
    count: points.length,
    minimum,
    maximum,
    average,
    median,
    standardDeviation,
    trend: Math.abs(delta) < NUMBER_EPSILON ? "flat" : delta > 0 ? "rising" : "falling"
  };
}

export function detectOutliers(
  points: readonly number[],
  threshold = DEFAULT_OUTLIER_THRESHOLD
): readonly OutlierPoint[] {
  assertNonEmptySeries(points);

  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new AppError("Outlier threshold must be positive", "INVALID_THRESHOLD", 400);
  }

  const summary = summarizeSeries(points);
  const deviation = summary.standardDeviation || 1;
  const outliers = points
    .map((value, index) => ({
      index,
      value,
      score: Math.abs((value - summary.average) / deviation)
    }))
    .filter((point) => point.score >= threshold);

  logger.info("series outliers detected", {
    count: points.length,
    outlierCount: outliers.length,
    threshold
  });

  return outliers;
}

export function profileDataset(request: DatasetProfileRequest): DatasetProfile {
  const rows = request.rows;
  const maxCategoryValues = request.maxCategoryValues ?? DEFAULT_MAX_CATEGORY_VALUES;
  const outlierThreshold = request.outlierThreshold ?? DEFAULT_OUTLIER_THRESHOLD;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError("Dataset rows cannot be empty", "EMPTY_DATASET", 400);
  }

  if (!Number.isInteger(maxCategoryValues) || maxCategoryValues <= 0 || maxCategoryValues > 50) {
    throw new AppError(
      "maxCategoryValues must be between 1 and 50",
      "INVALID_CATEGORY_LIMIT",
      400
    );
  }

  if (!Number.isFinite(outlierThreshold) || outlierThreshold <= 0) {
    throw new AppError("outlierThreshold must be positive", "INVALID_THRESHOLD", 400);
  }

  const fieldNames = collectFieldNames(rows);
  const accumulators = new Map(
    fieldNames.map((fieldName) => [
      fieldName,
      {
        name: fieldName,
        count: 0,
        missingCount: 0,
        values: [] as unknown[],
        distinctValues: new Set<string>(),
        examples: [] as unknown[],
        kindCounts: new Map<FieldKind, number>()
      } satisfies FieldAccumulator
    ])
  );
  const duplicateRowCount = countDuplicateRows(rows);

  for (const row of rows) {
    for (const fieldName of fieldNames) {
      const accumulator = accumulators.get(fieldName);

      if (!accumulator) {
        continue;
      }

      const value = row[fieldName];

      accumulator.count += 1;

      if (isMissing(value)) {
        accumulator.missingCount += 1;
        continue;
      }

      const kind = detectValueKind(value);

      accumulator.values.push(value);
      accumulator.distinctValues.add(stableValueKey(value));
      accumulator.kindCounts.set(kind, (accumulator.kindCounts.get(kind) ?? 0) + 1);

      if (accumulator.examples.length < 3) {
        accumulator.examples.push(value);
      }
    }
  }

  const fields = [...accumulators.values()].map((accumulator) =>
    buildFieldProfile(accumulator, maxCategoryValues, outlierThreshold)
  );
  const quality = buildQualitySummary(fields, duplicateRowCount);

  logger.info("dataset profiled", {
    rowCount: rows.length,
    fieldCount: fields.length,
    duplicateRowCount,
    warningCount: quality.warnings.length
  });

  return {
    rowCount: rows.length,
    fieldCount: fields.length,
    fields,
    quality
  };
}

function buildFieldProfile(
  accumulator: FieldAccumulator,
  maxCategoryValues: number,
  outlierThreshold: number
): FieldProfile {
  const kind = resolveFieldKind(accumulator.kindCounts);
  const base: BaseFieldProfile = {
    name: accumulator.name,
    kind,
    count: accumulator.count,
    missingCount: accumulator.missingCount,
    missingRatio: accumulator.count === 0 ? 0 : accumulator.missingCount / accumulator.count,
    distinctCount: accumulator.distinctValues.size,
    examples: accumulator.examples
  } satisfies BaseFieldProfile;

  if (kind === "empty") {
    return {
      ...base,
      kind
    };
  }

  if (kind === "number") {
    const values = accumulator.values.map((value) => toFiniteNumber(value));
    const summary = summarizeSeries(values);

    return {
      ...base,
      kind,
      minimum: summary.minimum,
      maximum: summary.maximum,
      average: summary.average,
      median: summary.median,
      standardDeviation: summary.standardDeviation,
      outliers: detectOutliers(values, outlierThreshold)
    };
  }

  if (kind === "boolean") {
    const trueCount = accumulator.values.filter((value) => value === true).length;

    return {
      ...base,
      kind,
      trueCount,
      falseCount: accumulator.values.length - trueCount
    };
  }

  if (kind === "date") {
    const timestamps = accumulator.values.map((value) => toDate(value).getTime());

    return {
      ...base,
      kind,
      minimum: new Date(Math.min(...timestamps)).toISOString(),
      maximum: new Date(Math.max(...timestamps)).toISOString()
    };
  }

  if (kind === "string") {
    return {
      ...base,
      kind,
      topValues: buildTopValues(accumulator.values, maxCategoryValues)
    };
  }

  return {
    ...base,
    kind: "mixed",
    detectedKinds: [...accumulator.kindCounts.keys()].sort()
  };
}

function buildQualitySummary(
  fields: readonly FieldProfile[],
  duplicateRowCount: number
): DatasetQualitySummary {
  const emptyFieldCount = fields.filter((field) => field.kind === "empty").length;
  const highMissingFieldCount = fields.filter((field) => field.missingRatio >= 0.5).length;
  const mixedFieldCount = fields.filter((field) => field.kind === "mixed").length;
  const warnings: string[] = [];

  if (emptyFieldCount > 0) {
    warnings.push(`${emptyFieldCount} fields are empty`);
  }

  if (highMissingFieldCount > 0) {
    warnings.push(`${highMissingFieldCount} fields have at least 50% missing values`);
  }

  if (mixedFieldCount > 0) {
    warnings.push(`${mixedFieldCount} fields contain mixed value types`);
  }

  if (duplicateRowCount > 0) {
    warnings.push(`${duplicateRowCount} duplicate rows detected`);
  }

  return {
    emptyFieldCount,
    highMissingFieldCount,
    mixedFieldCount,
    duplicateRowCount,
    warnings
  };
}

function collectFieldNames(rows: readonly DatasetRow[]): readonly string[] {
  const fieldNames = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new AppError("Each dataset row must be an object", "INVALID_DATASET_ROW", 400);
    }

    Object.keys(row).forEach((fieldName) => fieldNames.add(fieldName));
  }

  if (fieldNames.size === 0) {
    throw new AppError("Dataset rows must include at least one field", "EMPTY_DATASET", 400);
  }

  return [...fieldNames];
}

function countDuplicateRows(rows: readonly DatasetRow[]): number {
  const rowKeys = new Set<string>();
  let duplicateCount = 0;

  for (const row of rows) {
    const key = stableValueKey(row);

    if (rowKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }

    rowKeys.add(key);
  }

  return duplicateCount;
}

function buildTopValues(
  values: readonly unknown[],
  maxCategoryValues: number
): readonly CategoryCount[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = String(value);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, maxCategoryValues);
}

function resolveFieldKind(kindCounts: ReadonlyMap<FieldKind, number>): FieldKind {
  if (kindCounts.size === 0) {
    return "empty";
  }

  if (kindCounts.size === 1) {
    return [...kindCounts.keys()][0];
  }

  const nonStringKinds = [...kindCounts.keys()].filter((kind) => kind !== "string");

  if (nonStringKinds.length === 1 && kindCounts.has("string")) {
    return "mixed";
  }

  return "mixed";
}

function detectValueKind(value: unknown): FieldKind {
  if (typeof value === "number" && Number.isFinite(value)) {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return "date";
  }

  if (typeof value === "string") {
    if (isIsoLikeDate(value)) {
      return "date";
    }

    return "string";
  }

  return "mixed";
}

function isIsoLikeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("Expected finite numeric value", "INVALID_NUMERIC_VALUE", 400);
  }

  return value;
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));

  if (!Number.isFinite(date.getTime())) {
    throw new AppError("Expected date value", "INVALID_DATE_VALUE", 400);
  }

  return date;
}

function calculateMedian(sortedValues: readonly number[]): number {
  const midpoint = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[midpoint];
  }

  return (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2;
}

function assertNonEmptySeries(points: readonly number[]): void {
  if (points.length === 0) {
    throw new AppError("Series cannot be empty", "EMPTY_SERIES", 400);
  }

  if (!points.every((value) => Number.isFinite(value))) {
    throw new AppError("Series must contain only finite numbers", "INVALID_SERIES", 400);
  }
}

function isMissing(value: unknown): boolean {
  return value === null || typeof value === "undefined" || value === "";
}

function stableValueKey(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableValueKey(item)).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableValueKey(nestedValue)}`)
    .join(",")}}`;
}
