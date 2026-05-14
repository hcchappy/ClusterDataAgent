import {
  type DatasetProfile,
  type FieldProfile,
  type NumberFieldProfile
} from "@clusterdata/analysis-service";
import { AppError, createLogger } from "@clusterdata/shared";

export type ChartKind = "line" | "bar" | "pie" | "table" | "histogram" | "scatter";
export type ChartSamplingStrategy = "none" | "stride" | "top-n-plus-other" | "binned";
export type ChartTheme = "dark" | "light";

const logger = createLogger("chart-engine");
const DEFAULT_MAX_RENDER_POINTS = 120;
const DEFAULT_MAX_PIE_SLICES = 8;
const DEFAULT_ZOOM_THRESHOLD = 24;
const DEFAULT_PROGRESSIVE_THRESHOLD = 200;
const DEFAULT_LARGE_SERIES_THRESHOLD = 400;
const DEFAULT_CHART_THEME: ChartTheme = "dark";

interface ChartThemeDefinition {
  readonly backgroundColor: string;
  readonly textColor: string;
  readonly secondaryTextColor: string;
  readonly axisColor: string;
  readonly splitLineColor: string;
  readonly tooltipBackgroundColor: string;
  readonly tooltipBorderColor: string;
  readonly palette: readonly string[];
}

const CHART_THEME_DEFINITIONS: Record<ChartTheme, ChartThemeDefinition> = {
  dark: {
    backgroundColor: "#0d1219",
    textColor: "#e7ecf3",
    secondaryTextColor: "#9eb1cb",
    axisColor: "#32415b",
    splitLineColor: "#243044",
    tooltipBackgroundColor: "#10151d",
    tooltipBorderColor: "#32415b",
    palette: ["#87a3ff", "#49cc93", "#ffb86c", "#ff7d9c", "#7de1d8", "#c1a6ff", "#f8d66d"]
  },
  light: {
    backgroundColor: "#ffffff",
    textColor: "#1f2937",
    secondaryTextColor: "#4b5563",
    axisColor: "#cbd5e1",
    splitLineColor: "#e2e8f0",
    tooltipBackgroundColor: "#f8fafc",
    tooltipBorderColor: "#cbd5e1",
    palette: ["#2563eb", "#059669", "#ea580c", "#db2777", "#0891b2", "#7c3aed", "#ca8a04"]
  }
};

export interface ChartSuggestionInput {
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly hasTimeAxis: boolean;
}

export interface ChartRecommendationRequest {
  readonly profile: DatasetProfile;
  readonly maxRecommendations?: number;
  readonly theme?: ChartTheme;
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

export interface ChartBuildOptions {
  readonly maxRenderPoints?: number;
  readonly maxPieSlices?: number;
  readonly zoomThreshold?: number;
  readonly progressiveThreshold?: number;
  readonly largeSeriesThreshold?: number;
  readonly theme?: ChartTheme;
}

export interface ChartOptimizationMetadata {
  readonly originalPointCount: number;
  readonly renderedPointCount: number;
  readonly sampled: boolean;
  readonly strategy: ChartSamplingStrategy;
  readonly interactiveZoom: boolean;
  readonly progressive: boolean;
  readonly largeMode: boolean;
}

interface EChartsAxis {
  readonly type: string;
  readonly data?: readonly string[];
  readonly axisLabel?: { readonly color: string };
  readonly axisLine?: { readonly lineStyle: { readonly color: string } };
  readonly splitLine?: { readonly lineStyle: { readonly color: string } };
}

export interface EChartsOption {
  readonly backgroundColor?: string;
  readonly color?: readonly string[];
  readonly textStyle?: { readonly color: string };
  readonly title: { readonly text: string; readonly textStyle?: { readonly color: string } };
  readonly tooltip: {
    readonly trigger: string;
    readonly backgroundColor?: string;
    readonly borderColor?: string;
    readonly textStyle?: { readonly color: string };
  };
  readonly legend?: {
    readonly data: readonly string[];
    readonly textStyle?: { readonly color: string };
  };
  dataZoom?: readonly {
    readonly type: "inside" | "slider";
    readonly start: number;
    readonly end: number;
  }[];
  animation?: boolean;
  meta?: ChartOptimizationMetadata;
  xAxis?: EChartsAxis;
  yAxis?: EChartsAxis;
  readonly series: readonly {
    readonly type: ChartKind;
    readonly name: string;
    readonly sampling?: "lttb" | "average";
    readonly large?: boolean;
    readonly largeThreshold?: number;
    readonly progressive?: number;
    readonly progressiveThreshold?: number;
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
  kind: ChartKind,
  options: ChartBuildOptions = {}
): EChartsOption {
  const config = resolveChartBuildOptions(options);
  const theme = CHART_THEME_DEFINITIONS[config.theme];
  const points = labels.map((label, index) => ({
    label,
    value: values[index] ?? 0
  }));

  if (kind === "pie") {
    const optimizedPoints = optimizePiePoints(points, config.maxPieSlices);
    const meta = buildOptimizationMetadata({
      originalPointCount: points.length,
      renderedPointCount: optimizedPoints.length,
      strategy: optimizedPoints.length < points.length ? "top-n-plus-other" : "none",
      interactiveZoom: false,
      progressive: false,
      largeMode: false
    });
    const option: EChartsOption = {
      ...buildThemeSurface(title, "item", theme),
      legend: {
        data: optimizedPoints.map((point) => point.label),
        textStyle: { color: theme.secondaryTextColor }
      },
      animation: !meta.progressive,
      meta,
      series: [
        {
          type: kind,
          name: title,
          data: optimizedPoints.map((point) => ({
            name: point.label,
            value: point.value
          }))
        }
      ]
    };

    logChartOptimization(kind, title, meta);

    return option;
  }

  const optimizedPoints = optimizeCategoryPoints(points, config.maxRenderPoints);
  const meta = buildOptimizationMetadata({
    originalPointCount: points.length,
    renderedPointCount: optimizedPoints.length,
    strategy: optimizedPoints.length < points.length ? "stride" : "none",
    interactiveZoom: points.length >= config.zoomThreshold,
    progressive: points.length >= config.progressiveThreshold,
    largeMode: kind === "scatter" && points.length >= config.largeSeriesThreshold
  });
  const option: EChartsOption = {
    ...buildThemeSurface(title, "axis", theme),
    animation: !meta.progressive,
    meta,
    series: [
      {
        type: kind,
        name: title,
        data: optimizedPoints.map((point) => point.value),
        sampling: resolveSeriesSampling(kind, meta),
        large: meta.largeMode || undefined,
        largeThreshold: meta.largeMode ? config.largeSeriesThreshold : undefined,
        progressive: meta.progressive ? 500 : undefined,
        progressiveThreshold: meta.progressive ? config.progressiveThreshold : undefined
      }
    ]
  };

  option.xAxis = buildAxisTheme("category", theme, optimizedPoints.map((point) => point.label));
  option.yAxis = buildAxisTheme("value", theme);

  if (meta.interactiveZoom) {
    option.dataZoom = [
      { type: "inside", start: 0, end: 100 },
      { type: "slider", start: 0, end: 100 }
    ];
  }

  logChartOptimization(kind, title, meta);

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
                categoryField.distinctCount <= 8 ? "bar" : "table",
                {
                  theme: request.theme
                }
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
      option: buildHistogramOption(metric, {
        theme: request.theme
      })
    });

    if (metric.outliers.length > 0) {
      recommendations.push({
        kind: "scatter",
        title: `${metric.name} outliers`,
        dimensions: ["row index"],
        metrics: [metric.name],
        score: 0.74,
        reason: "Detected outliers are easier to review on an indexed scatter plot",
        option: buildOutlierScatterOption(metric, {
          theme: request.theme
        })
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

  const topRecommendations = recommendations
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, maxRecommendations);

  logger.info("chart recommendations generated", {
    rowCount: request.profile.rowCount,
    fieldCount: request.profile.fieldCount,
    recommendationCount: topRecommendations.length,
    theme: request.theme ?? DEFAULT_CHART_THEME
  });

  return topRecommendations;
}

function buildHistogramOption(
  metric: NumberFieldProfile,
  options: ChartBuildOptions = {}
): EChartsOption {
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

  const option = buildEChartsOption(
    `${metric.name} distribution`,
    labels,
    values,
    "histogram",
    options
  );

  return {
    ...option,
    meta: buildOptimizationMetadata({
      originalPointCount: metric.count,
      renderedPointCount: bucketCount,
      strategy: "binned",
      interactiveZoom: false,
      progressive: false,
      largeMode: false
    })
  };
}

function buildOutlierScatterOption(
  metric: NumberFieldProfile,
  options: ChartBuildOptions = {}
): EChartsOption {
  const config = resolveChartBuildOptions(options);
  const theme = CHART_THEME_DEFINITIONS[config.theme];
  const pointCount = metric.outliers.length;
  const meta = buildOptimizationMetadata({
    originalPointCount: pointCount,
    renderedPointCount: pointCount,
    strategy: "none",
    interactiveZoom: pointCount >= config.zoomThreshold,
    progressive: pointCount >= config.progressiveThreshold,
    largeMode: pointCount >= config.largeSeriesThreshold
  });

  return {
    ...buildThemeSurface(`${metric.name} outliers`, "item", theme),
    animation: !meta.progressive,
    meta,
    dataZoom: meta.interactiveZoom
      ? [
          { type: "inside", start: 0, end: 100 },
          { type: "slider", start: 0, end: 100 }
        ]
      : undefined,
    xAxis: buildAxisTheme("value", theme),
    yAxis: buildAxisTheme("value", theme),
    series: [
      {
        type: "scatter",
        name: metric.name,
        large: meta.largeMode || undefined,
        largeThreshold: meta.largeMode ? config.largeSeriesThreshold : undefined,
        progressive: meta.progressive ? 500 : undefined,
        progressiveThreshold: meta.progressive ? config.progressiveThreshold : undefined,
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

function resolveChartBuildOptions(options: ChartBuildOptions): Required<ChartBuildOptions> {
  return {
    maxRenderPoints: options.maxRenderPoints ?? DEFAULT_MAX_RENDER_POINTS,
    maxPieSlices: options.maxPieSlices ?? DEFAULT_MAX_PIE_SLICES,
    zoomThreshold: options.zoomThreshold ?? DEFAULT_ZOOM_THRESHOLD,
    progressiveThreshold: options.progressiveThreshold ?? DEFAULT_PROGRESSIVE_THRESHOLD,
    largeSeriesThreshold: options.largeSeriesThreshold ?? DEFAULT_LARGE_SERIES_THRESHOLD,
    theme: options.theme ?? DEFAULT_CHART_THEME
  };
}

function buildThemeSurface(
  title: string,
  trigger: string,
  theme: ChartThemeDefinition
): Pick<EChartsOption, "backgroundColor" | "color" | "textStyle" | "title" | "tooltip"> {
  return {
    backgroundColor: theme.backgroundColor,
    color: theme.palette,
    textStyle: { color: theme.secondaryTextColor },
    title: {
      text: title,
      textStyle: { color: theme.textColor }
    },
    tooltip: {
      trigger,
      backgroundColor: theme.tooltipBackgroundColor,
      borderColor: theme.tooltipBorderColor,
      textStyle: { color: theme.textColor }
    }
  };
}

function buildAxisTheme(
  type: "category" | "value",
  theme: ChartThemeDefinition,
  data?: readonly string[]
): EChartsAxis {
  return {
    type,
    data,
    axisLabel: { color: theme.secondaryTextColor },
    axisLine: {
      lineStyle: { color: theme.axisColor }
    },
    splitLine:
      type === "value"
        ? {
            lineStyle: { color: theme.splitLineColor }
          }
        : undefined
  };
}

function optimizeCategoryPoints(
  points: readonly { readonly label: string; readonly value: number }[],
  maxRenderPoints: number
): readonly { readonly label: string; readonly value: number }[] {
  if (points.length <= maxRenderPoints) {
    return points;
  }

  const maxIndex = points.length - 1;
  const indices = new Set<number>();

  for (let index = 0; index < maxRenderPoints; index += 1) {
    indices.add(Math.round((index * maxIndex) / Math.max(maxRenderPoints - 1, 1)));
  }

  return [...indices]
    .sort((left, right) => left - right)
    .map((index) => points[index] ?? points[maxIndex]);
}

function optimizePiePoints(
  points: readonly { readonly label: string; readonly value: number }[],
  maxPieSlices: number
): readonly { readonly label: string; readonly value: number }[] {
  if (points.length <= maxPieSlices) {
    return points;
  }

  const sorted = [...points].sort((left, right) => right.value - left.value);
  const visibleCount = Math.max(1, maxPieSlices - 1);
  const visible = sorted.slice(0, visibleCount);
  const otherValue = sorted
    .slice(visibleCount)
    .reduce((sum, point) => sum + point.value, 0);

  return otherValue > 0
    ? [...visible, { label: "Other", value: Number(otherValue.toFixed(2)) }]
    : visible;
}

function buildOptimizationMetadata(input: {
  readonly originalPointCount: number;
  readonly renderedPointCount: number;
  readonly strategy: ChartSamplingStrategy;
  readonly interactiveZoom: boolean;
  readonly progressive: boolean;
  readonly largeMode: boolean;
}): ChartOptimizationMetadata {
  return {
    originalPointCount: input.originalPointCount,
    renderedPointCount: input.renderedPointCount,
    sampled: input.renderedPointCount < input.originalPointCount || input.strategy === "binned",
    strategy: input.strategy,
    interactiveZoom: input.interactiveZoom,
    progressive: input.progressive,
    largeMode: input.largeMode
  };
}

function resolveSeriesSampling(
  kind: ChartKind,
  meta: ChartOptimizationMetadata
): "lttb" | "average" | undefined {
  if (!meta.sampled || meta.strategy === "top-n-plus-other") {
    return undefined;
  }

  if (kind === "line" || kind === "scatter") {
    return "lttb";
  }

  return "average";
}

function logChartOptimization(
  kind: ChartKind,
  title: string,
  meta: ChartOptimizationMetadata
): void {
  if (!meta.sampled && !meta.interactiveZoom && !meta.progressive && !meta.largeMode) {
    return;
  }

  logger.info("chart option optimized", {
    kind,
    title,
    originalPointCount: meta.originalPointCount,
    renderedPointCount: meta.renderedPointCount,
    strategy: meta.strategy,
    interactiveZoom: meta.interactiveZoom,
    progressive: meta.progressive,
    largeMode: meta.largeMode
  });
}
