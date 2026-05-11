import {
  type DatasetProfile,
  type FieldProfile,
  type NumberFieldProfile
} from "@clusterdata/analysis-service";
import { AppError } from "@clusterdata/shared";

export type ChartKind = "line" | "bar" | "pie" | "table" | "histogram" | "scatter";

export interface ChartSuggestionInput {
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly hasTimeAxis: boolean;
}

export interface ChartRecommendationRequest {
  readonly profile: DatasetProfile;
  readonly maxRecommendations?: number;
}

export interface ChartRecommendation {
  readonly kind: ChartKind;
  readonly title: string;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly score: number;
  readonly reason: string;
  readonly option?: EChartsOption;
}

export interface EChartsOption {
  readonly title: { readonly text: string };
  readonly tooltip: { readonly trigger: string };
  readonly legend?: { readonly data: readonly string[] };
  xAxis?: { readonly type: string; readonly data?: readonly string[] };
  yAxis?: { readonly type: string };
  readonly series: readonly {
    readonly type: ChartKind;
    readonly name: string;
    readonly data:
      | readonly number[]
      | readonly { readonly name: string; readonly value: number }[]
      | readonly [number, number][];
  }[];
}

export function chooseChartKind(input: ChartSuggestionInput): ChartKind {
  if (input.hasTimeAxis) {
    return "line";
  }

  if (input.metrics.length > 1) {
    return "bar";
  }

  if (input.dimensions.length === 1) {
    return "pie";
  }

  return "table";
}

export function buildEChartsOption(
  title: string,
  labels: readonly string[],
  values: readonly number[],
  kind: ChartKind
): EChartsOption {
  const option: EChartsOption = {
    title: { text: title },
    tooltip: { trigger: kind === "pie" ? "item" : "axis" },
    series: [
      {
        type: kind,
        name: title,
        data:
          kind === "pie"
            ? labels.map((label, index) => ({ name: label, value: values[index] ?? 0 }))
            : values
      }
    ]
  };

  if (kind !== "pie") {
    option.xAxis = { type: "category", data: labels };
    option.yAxis = { type: "value" };
  }

  return option;
}

export function recommendChartsFromProfile(
  request: ChartRecommendationRequest
): readonly ChartRecommendation[] {
  const maxRecommendations = request.maxRecommendations ?? 5;

  if (!Number.isInteger(maxRecommendations) || maxRecommendations <= 0 || maxRecommendations > 20) {
    throw new AppError(
      "maxRecommendations must be between 1 and 20",
      "INVALID_RECOMMENDATION_LIMIT",
      400
    );
  }

  const fields = request.profile.fields;
  const numberFields = fields.filter(isNumberField);
  const categoryFields = fields.filter((field) => field.kind === "string" && field.distinctCount > 0);
  const dateFields = fields.filter((field) => field.kind === "date");
  const recommendations: ChartRecommendation[] = [];

  for (const dateField of dateFields) {
    for (const metric of numberFields) {
      recommendations.push({
        kind: "line",
        title: `${metric.name} over ${dateField.name}`,
        dimensions: [dateField.name],
        metrics: [metric.name],
        score: 0.95,
        reason: "Date and numeric fields support trend analysis over time"
      });
    }
  }

  for (const categoryField of categoryFields) {
    for (const metric of numberFields) {
      recommendations.push({
        kind: categoryField.distinctCount <= 8 ? "bar" : "table",
        title: `${metric.name} by ${categoryField.name}`,
        dimensions: [categoryField.name],
        metrics: [metric.name],
        score: categoryField.distinctCount <= 8 ? 0.88 : 0.62,
        reason:
          categoryField.distinctCount <= 8
            ? "Low-cardinality categories are good for comparison charts"
            : "High-cardinality categories are safer to inspect as a table first",
        option:
          categoryField.kind === "string" && categoryField.topValues.length > 0
            ? buildEChartsOption(
                `${metric.name} by ${categoryField.name}`,
                categoryField.topValues.map((value) => value.value),
                categoryField.topValues.map((value) => value.count),
                categoryField.distinctCount <= 8 ? "bar" : "table"
              )
            : undefined
      });
    }
  }

  for (const metric of numberFields) {
    recommendations.push({
      kind: "histogram",
      title: `${metric.name} distribution`,
      dimensions: [metric.name],
      metrics: [metric.name],
      score: metric.distinctCount > 1 ? 0.78 : 0.35,
      reason: "Numeric fields can be inspected for spread, skew, and outliers",
      option: buildHistogramOption(metric)
    });

    if (metric.outliers.length > 0) {
      recommendations.push({
        kind: "scatter",
        title: `${metric.name} outliers`,
        dimensions: ["row index"],
        metrics: [metric.name],
        score: 0.74,
        reason: "Detected outliers are easier to review on an indexed scatter plot",
        option: buildOutlierScatterOption(metric)
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      kind: "table",
      title: "Dataset table",
      dimensions: fields.map((field) => field.name),
      metrics: [],
      score: 0.3,
      reason: "No numeric or date fields were detected, so a table is the safest first view"
    });
  }

  return recommendations
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, maxRecommendations);
}

function buildHistogramOption(metric: NumberFieldProfile): EChartsOption {
  const bucketCount = Math.min(8, Math.max(1, metric.distinctCount));
  const range = metric.maximum - metric.minimum;
  const bucketSize = range === 0 ? 1 : range / bucketCount;
  const labels = Array.from({ length: bucketCount }, (_unused, index) => {
    const start = metric.minimum + bucketSize * index;
    const end = index === bucketCount - 1 ? metric.maximum : start + bucketSize;

    return `${formatNumber(start)}-${formatNumber(end)}`;
  });
  const values = new Array<number>(bucketCount).fill(0);

  for (const example of metric.examples) {
    if (typeof example !== "number") {
      continue;
    }

    const bucketIndex =
      range === 0 ? 0 : Math.min(bucketCount - 1, Math.floor((example - metric.minimum) / bucketSize));

    values[bucketIndex] += 1;
  }

  return buildEChartsOption(`${metric.name} distribution`, labels, values, "histogram");
}

function buildOutlierScatterOption(metric: NumberFieldProfile): EChartsOption {
  return {
    title: { text: `${metric.name} outliers` },
    tooltip: { trigger: "item" },
    xAxis: { type: "value" },
    yAxis: { type: "value" },
    series: [
      {
        type: "scatter",
        name: metric.name,
        data: metric.outliers.map(
          (outlier): [number, number] => [outlier.index, outlier.value]
        )
      }
    ]
  };
}

function isNumberField(field: FieldProfile): field is NumberFieldProfile {
  return field.kind === "number";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
