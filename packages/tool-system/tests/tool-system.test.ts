import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@clusterdata/shared";
import { ToolRegistry, type ToolExecutionHooks } from "../src/index.js";

describe("tool-system", () => {
  it("registers and executes tools", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "echo",
      description: "echoes the payload",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: async (input: { value: string }) => input.value.toUpperCase()
    });

    await expect(registry.execute("echo", { value: "ok" })).resolves.toBe("OK");
    expect(registry.list()).toHaveLength(1);
  });

  it("runs hooks in execution order", async () => {
    const events: string[] = [];
    const hooks: ToolExecutionHooks = {
      beforeExecute: ({ toolName, attempt }) => {
        events.push(`before:${toolName}:${attempt}`);
      },
      afterExecute: ({ toolName, attempt }) => {
        events.push(`after:${toolName}:${attempt}`);
      }
    };
    const registry = new ToolRegistry({ hooks });

    registry.register({
      name: "sum",
      description: "sums two numbers",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" }
        },
        required: ["a", "b"],
        additionalProperties: false
      },
      execute: ({ a, b }: { a: number; b: number }) => a + b
    });

    await expect(registry.execute("sum", { a: 1, b: 2 })).resolves.toBe(3);
    expect(events).toEqual(["before:sum:1", "after:sum:1"]);
  });

  it("retries retryable failures and records metrics", async () => {
    const registry = new ToolRegistry({
      logger: createLogger("tool-test")
    });
    let attempts = 0;

    registry.register({
      name: "flaky",
      description: "fails once",
      execution: {
        retries: 1
      },
      execute: () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("boom");
        }

        return "ok";
      }
    });

    await expect(registry.execute("flaky", {})).resolves.toBe("ok");
    expect(attempts).toBe(2);
    expect(registry.getMetrics().flaky.calls).toBe(2);
    expect(registry.getMetrics().flaky.failures).toBe(1);
    expect(registry.getMetrics().flaky.successes).toBe(1);
  });

  it("times out long-running tools", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "slow",
      description: "waits too long",
      execution: {
        timeoutMs: 10
      },
      execute: async () =>
        await new Promise<string>((resolve) => {
          setTimeout(() => resolve("done"), 50);
        })
    });

    await expect(registry.execute("slow", {})).rejects.toMatchObject({
      code: "TOOL_EXECUTION_TIMEOUT",
      statusCode: 504
    });
  });

  it("rejects invalid input against the declared schema", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "guarded",
      description: "guards shape",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "integer" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: () => "ok"
    });

    await expect(registry.execute("guarded", { value: "nope" })).rejects.toMatchObject({
      code: "INVALID_TOOL_INPUT",
      statusCode: 400
    });
  });

  it("emits error hook payloads with retry intent", async () => {
    const onError = vi.fn();
    const registry = new ToolRegistry({
      hooks: {
        onError
      }
    });
    let attempts = 0;

    registry.register({
      name: "sometimes",
      description: "fails once then succeeds",
      execution: {
        retries: 1
      },
      execute: () => {
        attempts += 1;

        if (attempts < 2) {
          throw new Error("retry me");
        }

        return "ok";
      }
    });

    await expect(registry.execute("sometimes", {})).resolves.toBe("ok");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "sometimes",
        attempt: 1,
        willRetry: true
      })
    );
  });
});
