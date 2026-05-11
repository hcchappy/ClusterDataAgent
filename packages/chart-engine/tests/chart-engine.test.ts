import { describe, expect, it } from "vitest";
import { buildEChartsOption, chooseChartKind } from "../src/index.js";

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
});

