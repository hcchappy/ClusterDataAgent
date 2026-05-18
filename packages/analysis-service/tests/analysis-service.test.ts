import { describe, expect, it } from "vitest";
import { AppError } from "@clusterdata/shared";
import {
  analyzeTimeSeries,
  detectOutliers,
  generateDatasetInsights,
  profileDataset,
  summarizeSeries
} from "../src/index.js";

describe("analysis-service", () => {
  it("summarizes a series", () => {
    const summary = summarizeSeries([1, 2, 3, 4]);

    expect(summary.count).toBe(4);
    expect(summary.minimum).toBe(1);
    expect(summary.maximum).toBe(4);
    expect(summary.median).toBe(2.5);
    expect(summary.trend).toBe("rising");
  });

  it("detects outliers", () => {
    const outliers = detectOutliers([1, 1, 1, 10], 1.5);

    expect(outliers.length).toBeGreaterThan(0);
  });

  it("analyzes time series cadence, moving average, and anomalies", () => {
    const analysis = analyzeTimeSeries({
      points: [
        { timestamp: "2026-01-01T00:00:00.000Z", value: 1 },
        { timestamp: "2026-01-02T00:00:00.000Z", value: 1 },
        { timestamp: "2026-01-03T00:00:00.000Z", value: 1 },
        { timestamp: "2026-01-04T00:00:00.000Z", value: 10 }
      ],
      movingAverageWindow: 2,
      anomalyThreshold: 1.5
    });

    expect(analysis).toMatchObject({
      pointCount: 4,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-04T00:00:00.000Z",
      movingAverageWindow: 2,
      interval: {
        unit: "day",
        regular: true,
        minimumMs: 86_400_000,
        maximumMs: 86_400_000,
        medianMs: 86_400_000
      },
      change: {
        absolute: 9,
        percent: 9,
        direction: "up"
      },
      summary: {
        trend: "rising"
      }
    });
    expect(analysis.movingAverage).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 1,
        average: 1
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        value: 1,
        average: 1
      },
      {
        timestamp: "2026-01-03T00:00:00.000Z",
        value: 1,
        average: 1
      },
      {
        timestamp: "2026-01-04T00:00:00.000Z",
        value: 10,
        average: 5.5
      }
    ]);
    expect(analysis.anomalies).toEqual([
      {
        index: 3,
        value: 10,
        score: expect.any(Number),
        timestamp: "2026-01-04T00:00:00.000Z"
      }
    ]);
  });

  it("profiles numeric, string, boolean, and date fields", () => {
    const profile = profileDataset({
      rows: [
        {
          region: "north",
          amount: 10,
          active: true,
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        {
          region: "south",
          amount: 20,
          active: false,
          createdAt: "2026-01-02T00:00:00.000Z"
        },
        {
          region: "north",
          amount: 30,
          active: true,
          createdAt: "2026-01-03T00:00:00.000Z"
        }
      ]
    });

    const amount = profile.fields.find((field) => field.name === "amount");
    const region = profile.fields.find((field) => field.name === "region");
    const active = profile.fields.find((field) => field.name === "active");
    const createdAt = profile.fields.find((field) => field.name === "createdAt");

    expect(profile.rowCount).toBe(3);
    expect(amount).toMatchObject({
      kind: "number",
      minimum: 10,
      maximum: 30,
      average: 20,
      median: 20
    });
    expect(region).toMatchObject({
      kind: "string",
      topValues: [
        { value: "north", count: 2 },
        { value: "south", count: 1 }
      ]
    });
    expect(active).toMatchObject({
      kind: "boolean",
      trueCount: 2,
      falseCount: 1
    });
    expect(createdAt).toMatchObject({
      kind: "date",
      minimum: "2026-01-01T00:00:00.000Z",
      maximum: "2026-01-03T00:00:00.000Z"
    });
  });

  it("reports missing, mixed, empty, and duplicate quality warnings", () => {
    const profile = profileDataset({
      rows: [
        { id: 1, mixed: "1", mostlyMissing: null, empty: null },
        { id: 1, mixed: 1, mostlyMissing: null, empty: undefined },
        { id: 1, mixed: "1", mostlyMissing: "present", empty: "" }
      ]
    });

    expect(profile.quality.duplicateRowCount).toBe(0);
    expect(profile.quality.emptyFieldCount).toBe(1);
    expect(profile.quality.highMissingFieldCount).toBe(2);
    expect(profile.quality.mixedFieldCount).toBe(1);
    expect(profile.quality.warnings).toEqual(
      expect.arrayContaining([
        "1 fields are empty",
        "2 fields have at least 50% missing values",
        "1 fields contain mixed value types"
      ])
    );
  });

  it("counts exact duplicate rows", () => {
    const profile = profileDataset({
      rows: [
        { id: 1, region: "north" },
        { region: "north", id: 1 },
        { id: 2, region: "south" }
      ]
    });

    expect(profile.quality.duplicateRowCount).toBe(1);
    expect(profile.quality.warnings).toContain("1 duplicate rows detected");
  });

  it("generates quality, trend, breakdown, and correlation insights", () => {
    const result = generateDatasetInsights({
      rows: [
        { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10, cost: 5, region: "north" },
        { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20, cost: 10, region: "north" },
        { createdAt: "2026-01-03T00:00:00.000Z", revenue: 40, cost: 20, region: "south" }
      ]
    });

    expect(result.profile.rowCount).toBe(3);
    expect(result.insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trend",
          fields: ["createdAt", "revenue"]
        }),
        expect.objectContaining({
          kind: "breakdown",
          fields: ["region", "revenue"]
        }),
        expect.objectContaining({
          kind: "correlation",
          fields: ["revenue", "cost"]
        })
      ])
    );
  });

  it("rejects empty datasets", () => {
    expect(() => profileDataset({ rows: [] })).toThrow(AppError);
  });

  it("rejects invalid dataset insight limits", () => {
    expect(() =>
      generateDatasetInsights({
        rows: [{ revenue: 1 }],
        maxInsights: 0
      })
    ).toThrow(AppError);
  });

  it("rejects invalid time series windows", () => {
    expect(() =>
      analyzeTimeSeries({
        points: [{ timestamp: "2026-01-01T00:00:00.000Z", value: 1 }],
        movingAverageWindow: 0
      })
    ).toThrow(AppError);
  });
});

