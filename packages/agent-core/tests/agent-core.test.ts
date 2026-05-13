import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@clusterdata/shared";
import { ToolRegistry } from "@clusterdata/tool-system";
import {
  AgentExecutor,
  FileSessionStore,
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

  it("sends bilingual data-tool instructions to the model", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "search-metadata",
      description: "Search metadata",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"],
        additionalProperties: false
      },
      execute: () => ({ results: [] })
    });
    const sessionStore = new InMemorySessionStore(4);
    let capturedRequest: unknown;
    const transport: ResponsesTransport = {
      createResponse: vi.fn(async (request) => {
        capturedRequest = request;

        return {
          id: "resp_instructions",
          output_text: "ok",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }]
            }
          ]
        } as never;
      })
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

    await executor.executeTurn({
      sessionId: "instructions",
      message: "\u8ba2\u5355\u4e2d\u6709\u591a\u5c11\u8bb0\u5f55"
    });

    const request = capturedRequest as {
      input: readonly {
        role?: string;
        content?: readonly { text: string }[];
      }[];
    };
    const developerText = request.input[0]?.content?.[0]?.text ?? "";

    expect(developerText).toContain("bilingual Chinese/English");
    expect(developerText).toContain("\u591a\u5c11\u8bb0\u5f55");
    expect(developerText).toContain("search-metadata");
    expect(developerText).toContain("query-sql");
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

  it("persists session history to a file-backed session store", async () => {
    const filePath = createTempSessionStorePath();
    const registry = new ToolRegistry();
    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });
    const transport = createTransport([
      {
        id: "resp_file_store",
        output_text: "Persistent answer",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Persistent answer" }]
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
      sessionId: "persisted",
      message: "Remember me"
    });

    const reloadedStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    expect(reloadedStore.get("persisted")).toEqual([
      { role: "user", content: "Remember me" },
      { role: "assistant", content: "Persistent answer" }
    ]);

    cleanupTempSessionStore(filePath);
  });

  it("trims persisted file-backed session history to the configured cap", () => {
    const filePath = createTempSessionStorePath();
    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 2
    });

    sessionStore.append("trimmed", [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" }
    ]);
    sessionStore.append("trimmed", [
      { role: "user", content: "second" },
      { role: "assistant", content: "two" }
    ]);

    const reloadedStore = new FileSessionStore({
      filePath,
      maxMessages: 2
    });

    expect(reloadedStore.get("trimmed")).toEqual([
      { role: "user", content: "second" },
      { role: "assistant", content: "two" }
    ]);

    cleanupTempSessionStore(filePath);
  });

  it("rejects invalid file-backed session payloads", () => {
    const filePath = createTempSessionStorePath();

    writeFileSync(filePath, JSON.stringify({ sessions: { bad: [{ role: "system" }] } }), "utf8");

    expect(() =>
      new FileSessionStore({
        filePath,
        maxMessages: 4
      })
    ).toThrowError(/Session store file contains invalid messages/);

    cleanupTempSessionStore(filePath);
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

  it("retries empty non-stream responses and succeeds on the next attempt", async () => {
    const sessionStore = new InMemorySessionStore();
    const transport = createTransport([
      {
        id: "resp_empty",
        output: [
          {
            type: "message",
            role: "assistant",
            content: []
          }
        ]
      },
      {
        id: "resp_recovered",
        output_text: "Recovered after retry",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered after retry" }]
          }
        ]
      }
    ]);
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
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

    await expect(
      executor.executeTurn({
        sessionId: "retry-empty-response",
        message: "Hi"
      })
    ).resolves.toMatchObject({
      outputText: "Recovered after retry"
    });
  });

  it("forwards real upstream stream deltas when the transport supports streaming", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore();
    const createResponse = vi.fn(async () => {
      throw new Error("createResponse should not be used when streamResponse is available");
    });
    const streamResponse = vi.fn(async function* () {
      yield {
        type: "response.output_text.delta",
        delta: "Hello "
      };
      yield {
        type: "response.output_text.delta",
        delta: "stream"
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_native_stream",
          output_text: "Hello stream",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello stream" }]
            }
          ]
        }
      };
    });
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
      transport: {
        createResponse,
        streamResponse
      }
    });
    const deltas: string[] = [];

    for await (const event of executor.streamTurn({
      sessionId: "stream-native",
      message: "Hi"
    })) {
      if (event.type === "response.output_text.delta") {
        deltas.push(event.delta);
      }
    }

    expect(deltas).toEqual(["Hello ", "stream"]);
    expect(sessionStore.get("stream-native")).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello stream" }
    ]);
    expect(createResponse).not.toHaveBeenCalled();
    expect(streamResponse).toHaveBeenCalledTimes(1);
  });

  it("retries empty stream completion payloads and succeeds", async () => {
    let attempt = 0;
    const streamResponse = vi.fn(async function* () {
      attempt += 1;

      if (attempt === 1) {
        yield {
          type: "response.completed",
          response: {
            id: "resp_stream_empty",
            output: [
              {
                type: "message",
                role: "assistant",
                content: []
              }
            ]
          } as never
        };
        return;
      }

      yield {
        type: "response.output_text.delta",
        delta: "Recovered stream"
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_stream_recovered",
          output_text: "Recovered stream",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Recovered stream" }]
            }
          ]
        }
      };
    });
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport: {
        createResponse: vi.fn(async () => {
          throw new Error("createResponse should not be used when streamResponse is available");
        }),
        streamResponse
      }
    });

    await expect(
      executor.executeTurn({
        sessionId: "retry-empty-stream",
        message: "Hi"
      })
    ).resolves.toMatchObject({
      outputText: "Recovered stream"
    });
    expect(streamResponse).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed stream after partial text has already been emitted", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore();
    const streamResponse = vi.fn(async function* () {
      yield {
        type: "response.output_text.delta",
        delta: "partial"
      };

      throw new AppError("socket closed", "OPENAI_REQUEST_FAILED", 502);
    });
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
      transport: {
        createResponse: vi.fn(async () => {
          throw new Error("createResponse should not be used when streamResponse is available");
        }),
        streamResponse
      }
    });
    const events: string[] = [];

    await expect(
      (async () => {
        for await (const event of executor.streamTurn({
          sessionId: "stream-partial-failure",
          message: "Hi"
        })) {
          events.push(event.type);
        }
      })()
    ).rejects.toMatchObject({
      code: "OPENAI_REQUEST_FAILED"
    });

    expect(events).toEqual([
      "session.started",
      "response.output_text.delta",
      "response.failed"
    ]);
    expect(streamResponse).toHaveBeenCalledTimes(1);
  });

  it("completes streams from text deltas when no final response payload is sent", async () => {
    const sessionStore = new InMemorySessionStore();
    const streamResponse = vi.fn(async function* () {
      yield {
        type: "response.output_text.delta",
        delta: "There are "
      };
      yield {
        type: "response.output_text.delta",
        delta: "42 orders."
      };
    });
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
      sessionStore,
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport: {
        createResponse: vi.fn(async () => {
          throw new Error("createResponse should not be used when streamResponse is available");
        }),
        streamResponse
      }
    });
    let completedText = "";

    for await (const event of executor.streamTurn({
      sessionId: "stream-delta-only",
      message: "How many orders?"
    })) {
      if (event.type === "response.completed") {
        completedText = event.outputText;
      }
    }

    expect(completedText).toBe("There are 42 orders.");
    expect(sessionStore.get("stream-delta-only")).toEqual([
      { role: "user", content: "How many orders?" },
      { role: "assistant", content: "There are 42 orders." }
    ]);
  });

  it("normalizes unavailable upstream model channel errors", async () => {
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-unavailable",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport: {
        createResponse: vi.fn(async () => {
          throw new AppError(
            "No available channel for model gpt-unavailable under group default (distributor)",
            "model_not_found",
            404
          );
        })
      }
    });

    await expect(
      executor.executeTurn({
        sessionId: "unavailable-model",
        message: "Hi"
      })
    ).rejects.toMatchObject({
      code: "OPENAI_MODEL_CHANNEL_UNAVAILABLE"
    });
  });

  it("ignores upstream SSE heartbeat chunks without data lines", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            controller.enqueue(encoder.encode("event: ping\n\n"));
            controller.enqueue(
              encoder.encode(
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
              )
            );
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_heartbeat","output_text":"Hello","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n'
              )
            );
            controller.close();
          }
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      )
    );
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      }
    });
    const deltas: string[] = [];

    for await (const event of executor.streamTurn({
      sessionId: "stream-heartbeat",
      message: "Hi"
    })) {
      if (event.type === "response.output_text.delta") {
        deltas.push(event.delta);
      }
    }

    expect(deltas).toEqual(["Hello"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
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

function createTempSessionStorePath(): string {
  const directoryPath = mkdtempSync(join(tmpdir(), "clusterdata-agent-core-"));

  return join(directoryPath, "sessions.json");
}

function cleanupTempSessionStore(filePath: string): void {
  rmSync(dirname(filePath), { recursive: true, force: true });
}
