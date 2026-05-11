export type ChartKind = "line" | "bar" | "pie" | "table";

export interface ChartSuggestionInput {
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly hasTimeAxis: boolean;
}

export interface EChartsOption {
  readonly title: { readonly text: string };
  readonly tooltip: { readonly trigger: string };
  xAxis?: { readonly type: string; readonly data: readonly string[] };
  yAxis?: { readonly type: string };
  readonly series: readonly {
    readonly type: ChartKind;
    readonly name: string;
    readonly data: readonly number[];
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
    tooltip: { trigger: "axis" },
    series: [
      {
        type: kind,
        name: title,
        data: values
      }
    ]
  };

  if (kind !== "pie") {
    option.xAxis = { type: "category", data: labels };
    option.yAxis = { type: "value" };
  }

  return option;
}
