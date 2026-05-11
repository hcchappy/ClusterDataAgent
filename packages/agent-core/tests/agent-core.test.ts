import { describe, expect, it, vi } from "vitest";
import { AppError } from "@clusterdata/shared";
import { ToolRegistry } from "@clusterdata/tool-system";
import {
  AgentExecutor,
  InMemorySessionStore,
  buildAgentManifest,
  resolveResponsesApiEndpoint,
  type ResponsesTransport
} from "../src/index.js";

describe("agent-core", () => {
  it("builds a manifest summary", () => {
    const manifest = buildAgentManifest({
      projectName: "ClusterDataAgent",
      currentGoal: "Initialize the monorepo",
      priorities: ["monorepo", "agent-core"],
      rules: ["small commits", "tests first"]
    });

    expect(manifest.nextPriority).toBe("monorepo");
    expect(manifest.summary).toContain("ClusterDataAgent");
  });

  it("stores successful assistant turns in memory", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore(4);
    const transport = createTransport([
      {
        id: "resp_1",
        output_text: "Hello there",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello there" }]
          }
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15
        }
      }
    ]);
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 1
      },
      transport
    });

    const result = await executor.executeTurn({
      sessionId: "s1",
      message: "Hi"
    });

    expect(result.outputText).toBe("Hello there");
    expect(result.usage?.totalTokens).toBe(15);
    expect(sessionStore.get("s1")).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello there" }
    ]);
  });

  it("handles tool calls and feeds outputs back to the model", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "summarize-series",
      description: "Summarize a numeric series",
      inputSchema: {
        type: "object",
        properties: {
          points: {
            type: "array",
            items: { type: "number" }
          }
        },
        required: ["points"],
        additionalProperties: false
      },
      execute: ({ points }: { points: readonly number[] }) => ({
        average: points.reduce((sum, value) => sum + value, 0) / points.length
      })
    });
    const sessionStore = new InMemorySessionStore(4);
    const transport = createTransport([
      {
        id: "resp_tool",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "summarize-series",
            arguments: "{\"points\":[1,2,3]}"
          }
        ]
      },
      {
        id: "resp_final",
        output_text: "Average is 2",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Average is 2" }]
          }
        ]
      }
    ]);
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport
    });

    const result = await executor.executeTurn({
      sessionId: "tool-session",
      message: "Analyze this series"
    });

    expect(result.outputText).toBe("Average is 2");
    expect(result.toolCalls).toEqual([
      {
        callId: "call_1",
        toolName: "summarize-series",
        arguments: {
          points: [1, 2, 3]
        },
        output: {
          average: 2
        }
      }
    ]);
  });

  it("retries transport failures and succeeds on the second attempt", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore(4);
    let attempt = 0;
    const transport: ResponsesTransport = {
      createResponse: async () => {
        attempt += 1;

        if (attempt === 1) {
          throw new AppError("temporary failure", "OPENAI_REQUEST_FAILED", 502);
        }

        return {
          id: "resp_retry",
          output_text: "Recovered",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Recovered" }]
            }
          ]
        };
      }
    };
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 1
      },
      transport
    });

    await expect(
      executor.executeTurn({
        sessionId: "retry",
        message: "Hello"
      })
    ).resolves.toMatchObject({
      outputText: "Recovered"
    });
  });

  it("enforces the in-memory message cap with fifo trimming", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore(2);
    const transport = createTransport([
      {
        id: "resp_one",
        output_text: "First answer",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "First answer" }]
          }
        ]
      },
      {
        id: "resp_two",
        output_text: "Second answer",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Second answer" }]
          }
        ]
      }
    ]);
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport
    });

    await executor.executeTurn({
      sessionId: "memory",
      message: "first"
    });
    await executor.executeTurn({
      sessionId: "memory",
      message: "second"
    });

    expect(sessionStore.get("memory")).toEqual([
      { role: "user", content: "second" },
      { role: "assistant", content: "Second answer" }
    ]);
  });

  it("emits failed stream events when execution errors", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore();
    const transport: ResponsesTransport = {
      createResponse: async () => {
        throw new AppError("timeout", "OPENAI_TIMEOUT", 504);
      }
    };
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport
    });
    const events: string[] = [];

    await expect(
      (async () => {
        for await (const event of executor.streamTurn({
          sessionId: "fail",
          message: "Hi"
        })) {
          events.push(event.type);
        }
      })()
    ).rejects.toMatchObject({
      code: "OPENAI_TIMEOUT"
    });

    expect(events).toEqual(["session.started", "response.failed"]);
  });

  it("streams text delta events for the completed answer", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore();
    const transport = createTransport([
      {
        id: "resp_stream",
        output_text: "This is a streamed answer.",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "This is a streamed answer." }]
          }
        ]
      }
    ]);
    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport
    });
    const deltas: string[] = [];

    for await (const event of executor.streamTurn({
      sessionId: "stream",
      message: "Hi"
    })) {
      if (event.type === "response.output_text.delta") {
        deltas.push(event.delta);
      }
    }

    expect(deltas.join("")).toBe("This is a streamed answer.");
  });

  it("normalizes base and full response endpoints", () => {
    expect(resolveResponsesApiEndpoint("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(resolveResponsesApiEndpoint("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/responses"
    );
    expect(
      resolveResponsesApiEndpoint("https://openrouter.ai/api/v1/responses")
    ).toBe("https://openrouter.ai/api/v1/responses");
  });
});

function createTransport(responses: readonly object[]): ResponsesTransport {
  const queue = [...responses];

  return {
    createResponse: vi.fn(async () => {
      const next = queue.shift();

      if (!next) {
        throw new Error("No response queued");
      }

      return next as never;
    })
  };
}
