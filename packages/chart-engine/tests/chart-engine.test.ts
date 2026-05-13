import { describe, expect, it } from "vitest";
import { profileDataset } from "@clusterdata/analysis-service";
import {
  buildEChartsOption,
  chooseChartKind,
  recommendChartsFromProfile
} from "../src/index.js";

describe("chart-engine", () => {
  it("chooses a time series chart when time is present", () => {
    expect(
      chooseChartKind({
        dimensions: ["date"],
        metrics: ["revenue"],
        hasTimeAxis: true
      })
    ).toBe("line");
  });

  it("builds an option object", () => {
    const option = buildEChartsOption("Revenue", ["Jan"], [10], "bar");

    expect(option.title.text).toBe("Revenue");
    expect(option.series[0].type).toBe("bar");
  });

  it("optimizes large category series with sampling and zoom metadata", () => {
    const labels = Array.from({ length: 240 }, (_unused, index) => `Day ${index + 1}`);
    const values = labels.map((_label, index) => index + 1);
    const option = buildEChartsOption("Revenue", labels, values, "line");

    expect(option.meta).toMatchObject({
      originalPointCount: 240,
      sampled: true,
      strategy: "stride",
      interactiveZoom: true,
      progressive: true
    });
    expect(option.xAxis?.data?.length).toBeLessThanOrEqual(120);
    expect(option.series[0]).toMatchObject({
      sampling: "lttb",
      progressive: 500
    });
    expect(option.dataZoom).toHaveLength(2);
    expect(option.animation).toBe(false);
  });

  it("aggregates large pie categories into top slices and other", () => {
    const labels = Array.from({ length: 10 }, (_unused, index) => `Region ${index + 1}`);
    const values = [50, 40, 30, 20, 10, 9, 8, 7, 6, 5];
    const option = buildEChartsOption("Revenue by region", labels, values, "pie");
    const seriesData = option.series[0].data;

    expect(option.meta).toMatchObject({
      originalPointCount: 10,
      renderedPointCount: 8,
      sampled: true,
      strategy: "top-n-plus-other"
    });
    expect(seriesData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Region 1", value: 50 }),
        expect.objectContaining({ name: "Other", value: 18 })
      ])
    );
  });

  it("recommends time series charts from date and numeric fields", () => {
    const profile = profileDataset({
      rows: [
        { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10, region: "north" },
        { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20, region: "south" },
        { createdAt: "2026-01-03T00:00:00.000Z", revenue: 30, region: "north" }
      ]
    });
    const recommendations = recommendChartsFromProfile({ profile });

    expect(recommendations[0]).toMatchObject({
      kind: "line",
      title: "revenue over createdAt",
      dimensions: ["createdAt"],
      metrics: ["revenue"]
    });
  });

  it("recommends category comparison charts with option metadata", () => {
    const profile = profileDataset({
      rows: [
        { region: "north", revenue: 10 },
        { region: "south", revenue: 20 },
        { region: "north", revenue: 30 }
      ]
    });
    const recommendations = recommendChartsFromProfile({ profile });
    const comparison = recommendations.find(
      (recommendation) => recommendation.title === "revenue by region"
    );

    expect(comparison).toMatchObject({
      kind: "bar",
      dimensions: ["region"],
      metrics: ["revenue"]
    });
    expect(comparison?.option?.series[0].data).toEqual([2, 1]);
  });

  it("recommends numeric distribution charts", () => {
    const profile = profileDataset({
      rows: [{ revenue: 10 }, { revenue: 20 }, { revenue: 30 }]
    });
    const recommendations = recommendChartsFromProfile({ profile });

    expect(recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "histogram",
          title: "revenue distribution"
        })
      ])
    );
  });

  it("recommends outlier scatter charts when outliers exist", () => {
    const profile = profileDataset({
      rows: [{ revenue: 1 }, { revenue: 1 }, { revenue: 1 }, { revenue: 10 }],
      outlierThreshold: 1.5
    });
    const recommendations = recommendChartsFromProfile({ profile });

    expect(recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "scatter",
          title: "revenue outliers"
        })
      ])
    );
  });

  it("falls back to a table when no chartable fields exist", () => {
    const profile = profileDataset({
      rows: [{ note: "alpha" }, { note: "beta" }]
    });
    const recommendations = recommendChartsFromProfile({ profile });

    expect(recommendations[0]).toMatchObject({
      kind: "table",
      title: "Dataset table"
    });
  });
});

