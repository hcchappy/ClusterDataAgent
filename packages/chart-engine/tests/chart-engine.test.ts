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

