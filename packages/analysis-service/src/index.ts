import { AppError } from "@clusterdata/shared";

export interface SeriesSummary {
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly trend: "flat" | "rising" | "falling";
}

export interface OutlierPoint {
  readonly index: number;
  readonly value: number;
  readonly score: number;
}

export function summarizeSeries(points: readonly number[]): SeriesSummary {
  if (points.length === 0) {
    throw new AppError("Series cannot be empty", "EMPTY_SERIES", 400);
  }

  const minimum = Math.min(...points);
  const maximum = Math.max(...points);
  const average = points.reduce((sum, value) => sum + value, 0) / points.length;
  const delta = points[points.length - 1] - points[0];

  return {
    count: points.length,
    minimum,
    maximum,
    average,
    trend: Math.abs(delta) < 1e-6 ? "flat" : delta > 0 ? "rising" : "falling"
  };
}

export function detectOutliers(
  points: readonly number[],
  threshold = 2.5
): readonly OutlierPoint[] {
  if (points.length === 0) {
    throw new AppError("Series cannot be empty", "EMPTY_SERIES", 400);
  }

  const summary = summarizeSeries(points);
  const variance =
    points.reduce((sum, value) => sum + (value - summary.average) ** 2, 0) /
    points.length;
  const deviation = Math.sqrt(variance) || 1;

  return points
    .map((value, index) => ({
      index,
      value,
      score: Math.abs((value - summary.average) / deviation)
    }))
    .filter((point) => point.score >= threshold);
}

