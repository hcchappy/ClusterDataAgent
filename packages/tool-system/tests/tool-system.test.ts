import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/index.js";

describe("tool-system", () => {
  it("registers and executes tools", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "echo",
      description: "echoes the payload",
      execute: async (input: { value: string }) => input.value.toUpperCase()
    });

    await expect(registry.execute("echo", { value: "ok" })).resolves.toBe("OK");
    expect(registry.list()).toHaveLength(1);
  });
});

