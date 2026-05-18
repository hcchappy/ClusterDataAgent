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

export type DatasetInsightKind = "quality" | "trend" | "breakdown" | "correlation";

export interface DatasetInsightMetric {
  readonly label: string;
  readonly value: string | number;
}

export interface DatasetInsight {
  readonly kind: DatasetInsightKind;
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly string[];
  readonly metrics?: readonly DatasetInsightMetric[];
}

export interface DatasetInsightsRequest extends DatasetProfileRequest {
  readonly maxInsights?: number;
}

export interface DatasetInsightsResult {
  readonly profile: DatasetProfile;
  readonly insights: readonly DatasetInsight[];
}

export interface TimeSeriesPoint {
  readonly timestamp: string;
  readonly value: number;
}

export interface TimeSeriesAnalysisRequest {
  readonly points: readonly TimeSeriesPoint[];
  readonly movingAverageWindow?: number;
  readonly anomalyThreshold?: number;
}

export type TimeSeriesIntervalUnit =
  | "single"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "irregular";

export interface TimeSeriesIntervalSummary {
  readonly unit: TimeSeriesIntervalUnit;
  readonly regular: boolean;
  readonly minimumMs: number;
  readonly maximumMs: number;
  readonly medianMs: number;
}

export interface TimeSeriesChangeSummary {
  readonly absolute: number;
  readonly percent: number | null;
  readonly direction: "flat" | "up" | "down";
}

export interface TimeSeriesMovingAveragePoint {
  readonly timestamp: string;
  readonly value: number;
  readonly average: number;
}

export interface TimeSeriesAnomaly extends OutlierPoint {
  readonly timestamp: string;
}

export interface TimeSeriesAnalysis {
  readonly pointCount: number;
  readonly start: string;
  readonly end: string;
  readonly summary: SeriesSummary;
  readonly change: TimeSeriesChangeSummary;
  readonly interval: TimeSeriesIntervalSummary;
  readonly movingAverageWindow: number;
  readonly movingAverage: readonly TimeSeriesMovingAveragePoint[];
  readonly anomalies: readonly TimeSeriesAnomaly[];
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

export function analyzeTimeSeries(
  request: TimeSeriesAnalysisRequest
): TimeSeriesAnalysis {
  const points = request.points;

  assertNonEmptyTimeSeries(points);

  const movingAverageWindow =
    typeof request.movingAverageWindow === "undefined"
      ? Math.min(3, points.length)
      : request.movingAverageWindow;
  const anomalyThreshold =
    request.anomalyThreshold ?? DEFAULT_OUTLIER_THRESHOLD;

  if (!Number.isInteger(movingAverageWindow) || movingAverageWindow <= 0) {
    throw new AppError(
      "movingAverageWindow must be a positive integer",
      "INVALID_MOVING_AVERAGE_WINDOW",
      400
    );
  }

  if (!Number.isFinite(anomalyThreshold) || anomalyThreshold <= 0) {
    throw new AppError("anomalyThreshold must be positive", "INVALID_THRESHOLD", 400);
  }

  const sortedPoints = points
    .map((point) => ({
      timestamp: toDate(point.timestamp).toISOString(),
      value: toFiniteNumber(point.value)
    }))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const values = sortedPoints.map((point) => point.value);
  const summary = summarizeSeries(values);
  const anomalies = detectOutliers(values, anomalyThreshold).map((outlier) => ({
    ...outlier,
    timestamp: sortedPoints[outlier.index]?.timestamp ?? sortedPoints[0].timestamp
  }));
  const interval = inferTimeSeriesInterval(sortedPoints);
  const analysis = {
    pointCount: sortedPoints.length,
    start: sortedPoints[0].timestamp,
    end: sortedPoints[sortedPoints.length - 1].timestamp,
    summary,
    change: calculateTimeSeriesChange(values),
    interval,
    movingAverageWindow,
    movingAverage: buildMovingAverageSeries(sortedPoints, movingAverageWindow),
    anomalies
  } satisfies TimeSeriesAnalysis;

  logger.info("time series analyzed", {
    pointCount: analysis.pointCount,
    start: analysis.start,
    end: analysis.end,
    movingAverageWindow,
    anomalyCount: anomalies.length,
    intervalUnit: interval.unit,
    intervalRegular: interval.regular
  });

  return analysis;
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

export function generateDatasetInsights(
  request: DatasetInsightsRequest
): DatasetInsightsResult {
  const maxInsights = request.maxInsights ?? 6;

  if (!Number.isInteger(maxInsights) || maxInsights <= 0 || maxInsights > 12) {
    throw new AppError("maxInsights must be between 1 and 12", "INVALID_INSIGHT_LIMIT", 400);
  }

  const profile = profileDataset(request);
  const insights: DatasetInsight[] = [];

  const qualityInsight = buildQualityInsight(profile);

  if (qualityInsight) {
    insights.push(qualityInsight);
  }

  const trendInsight = buildTrendInsight(request.rows, profile);

  if (trendInsight) {
    insights.push(trendInsight);
  }

  const breakdownInsight = buildBreakdownInsight(request.rows, profile);

  if (breakdownInsight) {
    insights.push(breakdownInsight);
  }

  const correlationInsight = buildCorrelationInsight(request.rows, profile);

  if (correlationInsight) {
    insights.push(correlationInsight);
  }

  if (insights.length === 0) {
    insights.push({
      kind: "quality",
      title: "Dataset looks healthy",
      summary: `${profile.rowCount} rows across ${profile.fieldCount} fields with no major warnings.`,
      fields: []
    });
  }

  const result = {
    profile,
    insights: insights.slice(0, maxInsights)
  } satisfies DatasetInsightsResult;

  logger.info("dataset insights generated", {
    rowCount: profile.rowCount,
    fieldCount: profile.fieldCount,
    insightCount: result.insights.length
  });

  return result;
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

function buildQualityInsight(profile: DatasetProfile): DatasetInsight | undefined {
  if (profile.quality.warnings.length === 0) {
    return undefined;
  }

  return {
    kind: "quality",
    title: "Data quality watchouts",
    summary: profile.quality.warnings.slice(0, 3).join("; "),
    fields: profile.fields
      .filter((field) => field.missingRatio >= 0.5 || field.kind === "mixed" || field.kind === "empty")
      .map((field) => field.name)
      .slice(0, 4),
    metrics: [
      { label: "emptyFields", value: profile.quality.emptyFieldCount },
      { label: "highMissing", value: profile.quality.highMissingFieldCount },
      { label: "mixedFields", value: profile.quality.mixedFieldCount },
      { label: "duplicates", value: profile.quality.duplicateRowCount }
    ]
  };
}

function buildTrendInsight(
  rows: readonly DatasetRow[],
  profile: DatasetProfile
): DatasetInsight | undefined {
  const dateField = profile.fields.find((field) => field.kind === "date");
  const metricField = profile.fields.find((field) => field.kind === "number");

  if (!dateField || !metricField) {
    return undefined;
  }

  const aggregated = new Map<string, number>();

  for (const row of rows) {
    const timestamp = row[dateField.name];
    const value = row[metricField.name];

    if (isMissing(timestamp) || isMissing(value)) {
      continue;
    }

    if (detectValueKind(timestamp) !== "date" || detectValueKind(value) !== "number") {
      continue;
    }

    const bucket = toDate(timestamp).toISOString();
    aggregated.set(bucket, (aggregated.get(bucket) ?? 0) + toFiniteNumber(value));
  }

  if (aggregated.size < 2) {
    return undefined;
  }

  const analysis = analyzeTimeSeries({
    points: [...aggregated.entries()]
      .map(([timestamp, value]) => ({ timestamp, value }))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  });
  const direction =
    analysis.change.direction === "up"
      ? "rose"
      : analysis.change.direction === "down"
        ? "fell"
        : "held steady";

  return {
    kind: "trend",
    title: `${metricField.name} trend`,
    summary: `${metricField.name} ${direction} by ${formatInsightNumber(analysis.change.absolute)} across ${analysis.pointCount} time buckets.`,
    fields: [dateField.name, metricField.name],
    metrics: [
      { label: "change", value: formatInsightNumber(analysis.change.absolute) },
      {
        label: "changePct",
        value:
          analysis.change.percent === null
            ? "n/a"
            : `${(analysis.change.percent * 100).toFixed(1)}%`
      },
      { label: "interval", value: analysis.interval.unit },
      { label: "anomalies", value: analysis.anomalies.length }
    ]
  };
}

function buildBreakdownInsight(
  rows: readonly DatasetRow[],
  profile: DatasetProfile
): DatasetInsight | undefined {
  const categoryField = profile.fields.find(
    (field) => field.kind === "string" && field.distinctCount >= 2 && field.distinctCount <= 24
  );
  const metricField = profile.fields.find((field) => field.kind === "number");

  if (!categoryField || !metricField) {
    return undefined;
  }

  const categoryTotals = new Map<string, number>();

  for (const row of rows) {
    const category = row[categoryField.name];
    const value = row[metricField.name];

    if (typeof category !== "string" || detectValueKind(value) !== "number") {
      continue;
    }

    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + toFiniteNumber(value));
  }

  const rankedCategories = [...categoryTotals.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));

  if (rankedCategories.length < 2) {
    return undefined;
  }

  const topCategory = rankedCategories[0];
  const total = rankedCategories.reduce((sum, item) => sum + item.count, 0);
  const share = total === 0 ? 0 : topCategory.count / total;

  return {
    kind: "breakdown",
    title: `${metricField.name} by ${categoryField.name}`,
    summary: `${topCategory.value} contributes ${(share * 100).toFixed(1)}% of summed ${metricField.name} across ${rankedCategories.length} groups.`,
    fields: [categoryField.name, metricField.name],
    metrics: [
      { label: "topCategory", value: topCategory.value },
      { label: "topValue", value: formatInsightNumber(topCategory.count) },
      { label: "groupCount", value: rankedCategories.length }
    ]
  };
}

function buildCorrelationInsight(
  rows: readonly DatasetRow[],
  profile: DatasetProfile
): DatasetInsight | undefined {
  const numericFields = profile.fields.filter((field) => field.kind === "number");
  let bestPair:
    | {
        readonly left: string;
        readonly right: string;
        readonly correlation: number;
        readonly count: number;
      }
    | undefined;

  for (let leftIndex = 0; leftIndex < numericFields.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < numericFields.length; rightIndex += 1) {
      const leftField = numericFields[leftIndex];
      const rightField = numericFields[rightIndex];
      const pairs = rows
        .map((row) => ({
          left: row[leftField.name],
          right: row[rightField.name]
        }))
        .filter(
          (pair) => detectValueKind(pair.left) === "number" && detectValueKind(pair.right) === "number"
        )
        .map((pair) => ({
          left: toFiniteNumber(pair.left),
          right: toFiniteNumber(pair.right)
        }));

      if (pairs.length < 3) {
        continue;
      }

      const correlation = calculatePearsonCorrelation(
        pairs.map((pair) => pair.left),
        pairs.map((pair) => pair.right)
      );

      if (!Number.isFinite(correlation) || Math.abs(correlation) < 0.4) {
        continue;
      }

      if (!bestPair || Math.abs(correlation) > Math.abs(bestPair.correlation)) {
        bestPair = {
          left: leftField.name,
          right: rightField.name,
          correlation,
          count: pairs.length
        };
      }
    }
  }

  if (!bestPair) {
    return undefined;
  }

  const strength =
    Math.abs(bestPair.correlation) >= 0.8
      ? "strong"
      : Math.abs(bestPair.correlation) >= 0.6
        ? "moderate"
        : "light";
  const direction = bestPair.correlation > 0 ? "positive" : "negative";

  return {
    kind: "correlation",
    title: `${bestPair.left} vs ${bestPair.right}`,
    summary: `${bestPair.left} and ${bestPair.right} show a ${strength} ${direction} relationship across ${bestPair.count} rows.`,
    fields: [bestPair.left, bestPair.right],
    metrics: [
      { label: "correlation", value: bestPair.correlation.toFixed(2) },
      { label: "samples", value: bestPair.count }
    ]
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

function calculatePearsonCorrelation(
  leftValues: readonly number[],
  rightValues: readonly number[]
): number {
  if (leftValues.length !== rightValues.length || leftValues.length < 2) {
    return Number.NaN;
  }

  const leftAverage = leftValues.reduce((sum, value) => sum + value, 0) / leftValues.length;
  const rightAverage = rightValues.reduce((sum, value) => sum + value, 0) / rightValues.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (let index = 0; index < leftValues.length; index += 1) {
    const leftDelta = leftValues[index] - leftAverage;
    const rightDelta = rightValues[index] - rightAverage;

    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);

  if (denominator <= NUMBER_EPSILON) {
    return Number.NaN;
  }

  return numerator / denominator;
}

function formatInsightNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2);
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

function assertNonEmptyTimeSeries(
  points: readonly TimeSeriesPoint[]
): void {
  if (!Array.isArray(points) || points.length === 0) {
    throw new AppError("Time series points cannot be empty", "EMPTY_TIME_SERIES", 400);
  }
}

function isMissing(value: unknown): boolean {
  return value === null || typeof value === "undefined" || value === "";
}

function calculateTimeSeriesChange(
  values: readonly number[]
): TimeSeriesChangeSummary {
  const absolute = values[values.length - 1] - values[0];
  const direction =
    Math.abs(absolute) < NUMBER_EPSILON ? "flat" : absolute > 0 ? "up" : "down";

  return {
    absolute,
    percent:
      Math.abs(values[0]) < NUMBER_EPSILON ? null : absolute / Math.abs(values[0]),
    direction
  };
}

function inferTimeSeriesInterval(
  points: readonly TimeSeriesPoint[]
): TimeSeriesIntervalSummary {
  if (points.length <= 1) {
    return {
      unit: "single",
      regular: true,
      minimumMs: 0,
      maximumMs: 0,
      medianMs: 0
    };
  }

  const intervals = points
    .slice(1)
    .map((point, index) => Date.parse(point.timestamp) - Date.parse(points[index].timestamp))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const minimumMs = intervals[0] ?? 0;
  const maximumMs = intervals[intervals.length - 1] ?? 0;
  const medianMs = calculateMedian(intervals);
  const regular =
    maximumMs - minimumMs <= Math.max(1_000, medianMs * 0.1);

  return {
    unit: classifyTimeSeriesIntervalUnit(medianMs, regular),
    regular,
    minimumMs,
    maximumMs,
    medianMs
  };
}

function classifyTimeSeriesIntervalUnit(
  medianMs: number,
  regular: boolean
): TimeSeriesIntervalUnit {
  if (!regular) {
    return "irregular";
  }

  if (medianMs < 60 * 60 * 1_000) {
    return "minute";
  }

  if (medianMs < 24 * 60 * 60 * 1_000) {
    return "hour";
  }

  if (medianMs < 7 * 24 * 60 * 60 * 1_000) {
    return "day";
  }

  if (medianMs < 31 * 24 * 60 * 60 * 1_000) {
    return "week";
  }

  return "month";
}

function buildMovingAverageSeries(
  points: readonly TimeSeriesPoint[],
  windowSize: number
): readonly TimeSeriesMovingAveragePoint[] {
  return points.map((point, index) => {
    const windowStart = Math.max(0, index - windowSize + 1);
    const windowValues = points.slice(windowStart, index + 1).map((entry) => entry.value);
    const average =
      windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;

    return {
      timestamp: point.timestamp,
      value: point.value,
      average
    };
  });
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
