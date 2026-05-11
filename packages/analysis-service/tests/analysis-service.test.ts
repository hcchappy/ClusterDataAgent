import { describe, expect, it } from "vitest";
import { detectOutliers, summarizeSeries } from "../src/index.js";

describe("analysis-service", () => {
  it("summarizes a series", () => {
    const summary = summarizeSeries([1, 2, 3, 4]);

    expect(summary.count).toBe(4);
    expect(summary.minimum).toBe(1);
    expect(summary.maximum).toBe(4);
    expect(summary.trend).toBe("rising");
  });

  it("detects outliers", () => {
    const outliers = detectOutliers([1, 1, 1, 10], 1.5);

    expect(outliers.length).toBeGreaterThan(0);
  });
});

