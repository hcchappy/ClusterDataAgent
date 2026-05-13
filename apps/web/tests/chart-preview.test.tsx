import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChartRecommendation, DatasetProfile } from "../src/api.js";
import {
  ChartRecommendationPreview,
  buildChartPreviewModel
} from "../src/chart-preview.js";

const sampleRows = [
  { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10, region: "north" },
  { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20, region: "south" },
  { createdAt: "2026-01-03T00:00:00.000Z", revenue: 30, region: "north" }
];

const sampleProfile: DatasetProfile = {
  rowCount: 3,
  fieldCount: 3,
  fields: [
    {
      name: "createdAt",
      kind: "date",
      count: 3,
      missingCount: 0,
      missingRatio: 0,
      distinctCount: 3,
      examples: ["2026-01-01T00:00:00.000Z"],
      minimum: "2026-01-01T00:00:00.000Z",
      maximum: "2026-01-03T00:00:00.000Z"
    },
    {
      name: "revenue",
      kind: "number",
      count: 3,
      missingCount: 0,
      missingRatio: 0,
      distinctCount: 3,
      examples: [10, 20, 30],
      minimum: 10,
      maximum: 30,
      average: 20,
      median: 20,
      standardDeviation: 8.16,
      outliers: []
    },
    {
      name: "region",
      kind: "string",
      count: 3,
      missingCount: 0,
      missingRatio: 0,
      distinctCount: 2,
      examples: ["north", "south"],
      topValues: [
        { value: "north", count: 2 },
        { value: "south", count: 1 }
      ]
    }
  ],
  quality: {
    emptyFieldCount: 0,
    highMissingFieldCount: 0,
    mixedFieldCount: 0,
    duplicateRowCount: 0,
    warnings: []
  }
};

describe("chart preview", () => {
  it("builds grouped previews for line and pie recommendations", () => {
    const lineRecommendation: ChartRecommendation = {
      kind: "line",
      title: "revenue over createdAt",
      dimensions: ["createdAt"],
      metrics: ["revenue"],
      score: 0.95,
      reason: "Date and numeric fields support trend analysis over time"
    };
    const pieRecommendation: ChartRecommendation = {
      kind: "pie",
      title: "revenue by region",
      dimensions: ["region"],
      metrics: ["revenue"],
      score: 0.88,
      reason: "Compare regions"
    };

    expect(buildChartPreviewModel(lineRecommendation, sampleRows, sampleProfile)).toMatchObject({
      kind: "line",
      labels: [
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z"
      ],
      values: [10, 20, 30]
    });
    expect(buildChartPreviewModel(pieRecommendation, sampleRows, sampleProfile)).toMatchObject({
      kind: "pie",
      slices: [
        expect.objectContaining({ label: "north", value: 40 }),
        expect.objectContaining({ label: "south", value: 20 })
      ]
    });
  });

  it("renders svg previews and table previews", () => {
    const lineHtml = renderToStaticMarkup(
      <ChartRecommendationPreview
        recommendation={{
          kind: "line",
          title: "revenue over createdAt",
          dimensions: ["createdAt"],
          metrics: ["revenue"],
          score: 0.95,
          reason: "Trend analysis"
        }}
        rows={sampleRows}
        profile={sampleProfile}
      />
    );
    const tableHtml = renderToStaticMarkup(
      <ChartRecommendationPreview
        recommendation={{
          kind: "table",
          title: "Dataset table",
          dimensions: ["createdAt", "region"],
          metrics: ["revenue"],
          score: 0.3,
          reason: "Fallback"
        }}
        rows={sampleRows}
        profile={sampleProfile}
      />
    );

    expect(lineHtml).toContain("<svg");
    expect(tableHtml).toContain("<table");
    expect(tableHtml).toContain("north");
  });

  it("shows an empty preview state when no rows are available", () => {
    const html = renderToStaticMarkup(
      <ChartRecommendationPreview
        recommendation={{
          kind: "bar",
          title: "revenue by region",
          dimensions: ["region"],
          metrics: ["revenue"],
          score: 0.88,
          reason: "Compare"
        }}
        rows={[]}
        profile={null}
      />
    );

    expect(html).toContain("Preview becomes available");
  });

  it("samples large previews for line and pie charts", () => {
    const manyRows = Array.from({ length: 120 }, (_unused, index) => ({
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      revenue: index + 1,
      region: `region-${index + 1}`
    }));

    const linePreview = buildChartPreviewModel(
      {
        kind: "line",
        title: "revenue over createdAt",
        dimensions: ["createdAt"],
        metrics: ["revenue"],
        score: 0.95,
        reason: "Trend analysis"
      },
      manyRows,
      sampleProfile
    );
    const piePreview = buildChartPreviewModel(
      {
        kind: "pie",
        title: "revenue by region",
        dimensions: ["region"],
        metrics: ["revenue"],
        score: 0.88,
        reason: "Compare categories"
      },
      manyRows,
      sampleProfile
    );

    expect(linePreview).toMatchObject({
      kind: "line"
    });
    expect(
      linePreview && "labels" in linePreview ? linePreview.labels.length : 0
    ).toBeLessThanOrEqual(48);
    expect(piePreview).toMatchObject({
      kind: "pie"
    });
    expect(
      piePreview && "slices" in piePreview ? piePreview.slices.length : 0
    ).toBeLessThanOrEqual(6);
    expect(
      piePreview && "slices" in piePreview
        ? piePreview.slices.some((slice) => slice.label === "Other")
        : false
    ).toBe(true);
  });
});
