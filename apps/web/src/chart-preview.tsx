import { type ReactElement } from "react";
import type { ChartRecommendation, DatasetProfile, DatasetRow } from "./api.js";

interface CategorySeriesModel {
  readonly kind: "line" | "bar" | "histogram";
  readonly title: string;
  readonly labels: readonly string[];
  readonly values: readonly number[];
}

interface PieSeriesModel {
  readonly kind: "pie";
  readonly title: string;
  readonly slices: readonly {
    readonly label: string;
    readonly value: number;
    readonly color: string;
  }[];
}

interface ScatterSeriesModel {
  readonly kind: "scatter";
  readonly title: string;
  readonly points: readonly {
    readonly x: number;
    readonly y: number;
    readonly highlight: boolean;
  }[];
}

interface TablePreviewModel {
  readonly kind: "table";
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type ChartPreviewModel =
  | CategorySeriesModel
  | PieSeriesModel
  | ScatterSeriesModel
  | TablePreviewModel;

const MAX_PREVIEW_POINTS = 48;
const MAX_PREVIEW_PIE_SLICES = 6;
const MAX_SCATTER_PREVIEW_POINTS = 80;

const PREVIEW_COLORS = [
  "#87a3ff",
  "#49cc93",
  "#ffb86c",
  "#ff7d9c",
  "#7de1d8",
  "#c1a6ff",
  "#f8d66d",
  "#7aa2f7"
] as const;

export function ChartRecommendationPreview({
  recommendation,
  rows,
  profile
}: {
  readonly recommendation: ChartRecommendation;
  readonly rows: readonly DatasetRow[];
  readonly profile?: DatasetProfile | null;
}): ReactElement {
  const preview = buildChartPreviewModel(recommendation, rows, profile ?? undefined);

  if (!preview) {
    return (
      <div className="chart-preview chart-preview-empty">
        <p className="subtle small">
          Preview becomes available after a dataset profile has loaded row data.
        </p>
      </div>
    );
  }

  if (preview.kind === "table") {
    return <TablePreview model={preview} />;
  }

  if (preview.kind === "pie") {
    return <PiePreview model={preview} />;
  }

  if (preview.kind === "scatter") {
    return <ScatterPreview model={preview} />;
  }

  return <CartesianPreview model={preview} />;
}

export function buildChartPreviewModel(
  recommendation: ChartRecommendation,
  rows: readonly DatasetRow[],
  profile?: DatasetProfile
): ChartPreviewModel | undefined {
  if (rows.length === 0) {
    return recommendation.kind === "table" ? buildTablePreview(recommendation, rows) : undefined;
  }

  if (recommendation.kind === "table") {
    return buildTablePreview(recommendation, rows);
  }

  if (recommendation.kind === "histogram") {
    return buildHistogramPreview(recommendation, rows);
  }

  if (recommendation.kind === "scatter") {
    return buildScatterPreview(recommendation, rows, profile);
  }

  if (recommendation.kind === "pie") {
    const grouped = buildGroupedMetricSeries(recommendation, rows);

    if (!grouped) {
      return undefined;
    }

    const pieSlices = limitPiePreviewSlices(grouped);

    return {
      kind: "pie",
      title: recommendation.title,
      slices: pieSlices.labels.map((label, index) => ({
        label,
        value: pieSlices.values[index] ?? 0,
        color: PREVIEW_COLORS[index % PREVIEW_COLORS.length]
      }))
    };
  }

  const grouped = buildGroupedMetricSeries(recommendation, rows);

  if (!grouped) {
    return undefined;
  }

  const limited = limitCategoryPreviewSeries(grouped);

  return {
    kind: recommendation.kind,
    title: recommendation.title,
    labels: limited.labels,
    values: limited.values
  };
}

function CartesianPreview({
  model
}: {
  readonly model: CategorySeriesModel;
}): ReactElement {
  const width = 320;
  const height = 180;
  const padding = 18;
  const chartHeight = height - padding * 2;
  const chartWidth = width - padding * 2;
  const maxValue = Math.max(...model.values, 1);
  const minValue = model.kind === "line" ? Math.min(...model.values, 0) : 0;
  const range = Math.max(maxValue - minValue, 1);
  const stepX = model.values.length > 1 ? chartWidth / (model.values.length - 1) : chartWidth;

  const polylinePoints = model.values
    .map((value, index) => {
      const x = padding + stepX * index;
      const y = padding + chartHeight - ((value - minValue) / range) * chartHeight;

      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="chart-preview">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${model.title} preview`}
      >
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
        {model.kind === "line" ? (
          <>
            <polyline
              fill="none"
              points={polylinePoints}
              stroke={PREVIEW_COLORS[0]}
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {model.values.map((value, index) => {
              const x = padding + stepX * index;
              const y = padding + chartHeight - ((value - minValue) / range) * chartHeight;

              return (
                <circle
                  key={`line-point-${index}`}
                  cx={x}
                  cy={y}
                  r="4"
                  fill={PREVIEW_COLORS[0]}
                />
              );
            })}
          </>
        ) : (
          model.values.map((value, index) => {
            const barWidth = chartWidth / Math.max(model.values.length, 1) - 8;
            const x = padding + (chartWidth / Math.max(model.values.length, 1)) * index + 4;
            const barHeight = ((value - minValue) / range) * chartHeight;
            const y = height - padding - barHeight;

            return (
              <rect
                key={`bar-${index}`}
                x={x}
                y={y}
                width={Math.max(barWidth, 8)}
                height={Math.max(barHeight, 4)}
                rx="4"
                fill={PREVIEW_COLORS[index % PREVIEW_COLORS.length]}
              />
            );
          })
        )}
      </svg>
      <div className="chart-caption-row">
        {model.labels.slice(0, 4).map((label) => (
          <span key={label} className="chart-caption mono">
            {truncateLabel(label)}
          </span>
        ))}
      </div>
    </div>
  );
}

function PiePreview({
  model
}: {
  readonly model: PieSeriesModel;
}): ReactElement {
  const radius = 54;
  const center = 72;
  const circumference = 2 * Math.PI * radius;
  const total = model.slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  let offset = 0;

  return (
    <div className="chart-preview chart-preview-split">
      <svg
        className="chart-svg chart-svg-pie"
        viewBox="0 0 144 144"
        role="img"
        aria-label={`${model.title} preview`}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#243044"
          strokeWidth="18"
        />
        {model.slices.map((slice) => {
          const segmentLength = (slice.value / total) * circumference;
          const currentOffset = offset;

          offset += segmentLength;

          return (
            <circle
              key={slice.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth="18"
              strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
              strokeDashoffset={-currentOffset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          );
        })}
      </svg>
      <div className="chart-legend">
        {model.slices.slice(0, 4).map((slice) => (
          <div key={slice.label} className="chart-legend-item">
            <span
              className="chart-swatch"
              style={{ backgroundColor: slice.color }}
              aria-hidden="true"
            />
            <span className="mono">
              {truncateLabel(slice.label)} ({formatMetricValue(slice.value)})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScatterPreview({
  model
}: {
  readonly model: ScatterSeriesModel;
}): ReactElement {
  const width = 320;
  const height = 180;
  const padding = 18;
  const chartHeight = height - padding * 2;
  const chartWidth = width - padding * 2;
  const maxX = Math.max(...model.points.map((point) => point.x), 1);
  const maxY = Math.max(...model.points.map((point) => point.y), 1);
  const minY = Math.min(...model.points.map((point) => point.y), 0);
  const yRange = Math.max(maxY - minY, 1);

  return (
    <div className="chart-preview">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${model.title} preview`}
      >
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
        {model.points.map((point) => {
          const x = padding + (point.x / maxX) * chartWidth;
          const y = padding + chartHeight - ((point.y - minY) / yRange) * chartHeight;

          return (
            <circle
              key={`${point.x}-${point.y}`}
              cx={x}
              cy={y}
              r={point.highlight ? 5 : 4}
              fill={point.highlight ? "#ff7d9c" : PREVIEW_COLORS[0]}
            />
          );
        })}
      </svg>
      <div className="chart-caption-row">
        <span className="chart-caption mono">row index</span>
        <span className="chart-caption mono">metric value</span>
      </div>
    </div>
  );
}

function TablePreview({
  model
}: {
  readonly model: TablePreviewModel;
}): ReactElement {
  return (
    <div className="chart-preview chart-preview-table">
      <div className="result-table-wrap">
        <table className="result-table chart-table-preview">
          <thead>
            <tr>
              {model.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, rowIndex) => (
              <tr key={`preview-row-${rowIndex}`}>
                {row.map((value, valueIndex) => (
                  <td key={`preview-cell-${rowIndex}-${valueIndex}`}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function buildGroupedMetricSeries(
  recommendation: ChartRecommendation,
  rows: readonly DatasetRow[]
): {
  readonly labels: readonly string[];
  readonly values: readonly number[];
} | undefined {
  const dimension = recommendation.dimensions[0];
  const metric = recommendation.metrics[0];

  if (!dimension || !metric) {
    return undefined;
  }

  const totals = new Map<string, number>();
  const ordering = new Map<string, number>();
  let encounteredDate = false;

  for (const row of rows) {
    const label = formatDimensionValue(row[dimension]);
    const value = toNumber(row[metric]);

    if (typeof value === "undefined") {
      continue;
    }

    totals.set(label, (totals.get(label) ?? 0) + value);

    const timestamp = Date.parse(label);

    if (Number.isFinite(timestamp)) {
      ordering.set(label, timestamp);
      encounteredDate = true;
    }
  }

  const labels = [...totals.keys()];

  if (labels.length === 0) {
    return undefined;
  }

  labels.sort((left, right) => {
    if (encounteredDate) {
      return (ordering.get(left) ?? 0) - (ordering.get(right) ?? 0);
    }

    return left.localeCompare(right);
  });

  return {
    labels,
    values: labels.map((label) => Number((totals.get(label) ?? 0).toFixed(2)))
  };
}

function buildHistogramPreview(
  recommendation: ChartRecommendation,
  rows: readonly DatasetRow[]
): ChartPreviewModel | undefined {
  const metric = recommendation.metrics[0] ?? recommendation.dimensions[0];

  if (!metric) {
    return undefined;
  }

  const values = rows
    .map((row) => toNumber(row[metric]))
    .filter((value): value is number => typeof value === "number");

  if (values.length === 0) {
    return undefined;
  }

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const bucketCount = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(values.length))));
  const range = Math.max(maximum - minimum, 1);
  const bucketSize = range / bucketCount;
  const labels = Array.from({ length: bucketCount }, (_unused, index) => {
    const start = minimum + bucketSize * index;
    const end = index === bucketCount - 1 ? maximum : start + bucketSize;

    return `${formatMetricValue(start)}-${formatMetricValue(end)}`;
  });
  const bucketValues = new Array<number>(bucketCount).fill(0);

  for (const value of values) {
    const bucketIndex =
      range === 0 ? 0 : Math.min(bucketCount - 1, Math.floor((value - minimum) / bucketSize));

    bucketValues[bucketIndex] += 1;
  }

  return {
    kind: "histogram",
    title: recommendation.title,
    labels,
    values: bucketValues
  };
}

function buildScatterPreview(
  recommendation: ChartRecommendation,
  rows: readonly DatasetRow[],
  profile?: DatasetProfile
): ChartPreviewModel | undefined {
  const metric = recommendation.metrics[0];

  if (!metric) {
    return undefined;
  }

  const highlightedOutliers = new Set(
    profile?.fields.find((field) => field.name === metric && field.kind === "number")?.outliers?.map(
      (outlier) => outlier.index
    ) ?? []
  );
  const points = rows
    .map((row, index) => {
      const value = toNumber(row[metric]);

      if (typeof value === "undefined") {
        return undefined;
      }

      return {
        x: index + 1,
        y: value,
        highlight: highlightedOutliers.has(index)
      };
    })
    .filter(
      (point): point is { readonly x: number; readonly y: number; readonly highlight: boolean } =>
        typeof point !== "undefined"
    );
  const limitedPoints = limitScatterPreviewPoints(points);

  if (limitedPoints.length === 0) {
    return undefined;
  }

  return {
    kind: "scatter",
    title: recommendation.title,
    points: limitedPoints
  };
}

function buildTablePreview(
  recommendation: ChartRecommendation,
  rows: readonly DatasetRow[]
): TablePreviewModel {
  const columns =
    recommendation.dimensions.length + recommendation.metrics.length > 0
      ? [...recommendation.dimensions, ...recommendation.metrics]
      : Object.keys(rows[0] ?? {}).slice(0, 4);

  return {
    kind: "table",
    title: recommendation.title,
    columns,
    rows: rows.slice(0, 4).map((row) =>
      columns.map((column) => formatCellValue(row[column]))
    )
  };
}

function formatDimensionValue(value: unknown): string {
  if (value === null || typeof value === "undefined" || value === "") {
    return "missing";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatCellValue(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateLabel(value: string, maxLength = 14): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function limitCategoryPreviewSeries(series: {
  readonly labels: readonly string[];
  readonly values: readonly number[];
}): {
  readonly labels: readonly string[];
  readonly values: readonly number[];
} {
  if (series.labels.length <= MAX_PREVIEW_POINTS) {
    return series;
  }

  const maxIndex = series.labels.length - 1;
  const indices = new Set<number>();

  for (let index = 0; index < MAX_PREVIEW_POINTS; index += 1) {
    indices.add(Math.round((index * maxIndex) / Math.max(MAX_PREVIEW_POINTS - 1, 1)));
  }

  const ordered = [...indices].sort((left, right) => left - right);

  return {
    labels: ordered.map((index) => series.labels[index] ?? series.labels[maxIndex]),
    values: ordered.map((index) => series.values[index] ?? series.values[maxIndex] ?? 0)
  };
}

function limitPiePreviewSlices(series: {
  readonly labels: readonly string[];
  readonly values: readonly number[];
}): {
  readonly labels: readonly string[];
  readonly values: readonly number[];
} {
  if (series.labels.length <= MAX_PREVIEW_PIE_SLICES) {
    return series;
  }

  const sorted = series.labels
    .map((label, index) => ({
      label,
      value: series.values[index] ?? 0
    }))
    .sort((left, right) => right.value - left.value);
  const visibleCount = Math.max(1, MAX_PREVIEW_PIE_SLICES - 1);
  const visible = sorted.slice(0, visibleCount);
  const otherValue = sorted.slice(visibleCount).reduce((sum, item) => sum + item.value, 0);

  return {
    labels: [...visible.map((item) => item.label), "Other"],
    values: [...visible.map((item) => item.value), Number(otherValue.toFixed(2))]
  };
}

function limitScatterPreviewPoints(
  points: readonly {
    readonly x: number;
    readonly y: number;
    readonly highlight: boolean;
  }[]
): readonly {
  readonly x: number;
  readonly y: number;
  readonly highlight: boolean;
}[] {
  if (points.length <= MAX_SCATTER_PREVIEW_POINTS) {
    return points;
  }

  const highlightIndices = points
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.highlight)
    .map((entry) => entry.index);
  const maxIndex = points.length - 1;
  const indices = new Set<number>([0, maxIndex, ...highlightIndices]);

  for (let index = 0; index < MAX_SCATTER_PREVIEW_POINTS; index += 1) {
    indices.add(
      Math.round((index * maxIndex) / Math.max(MAX_SCATTER_PREVIEW_POINTS - 1, 1))
    );
  }

  return [...indices]
    .sort((left, right) => left - right)
    .slice(0, MAX_SCATTER_PREVIEW_POINTS + highlightIndices.length)
    .map((index) => points[index] ?? points[maxIndex]);
}
