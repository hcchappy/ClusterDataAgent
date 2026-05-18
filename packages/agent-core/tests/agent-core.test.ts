import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("governs large query tool outputs before returning them to the model loop", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "query-sql",
      description: "Execute a read-only query",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"],
        additionalProperties: false
      },
      execute: () => ({
        columns: ["id", "name"],
        rows: Array.from({ length: 80 }, (_unused, index) => ({
          id: `tenant-${index + 1}`,
          name: `Tenant ${index + 1}`
        })),
        rowCount: 80,
        durationMs: 12,
        validation: {
          allowed: true,
          normalizedSql: "select id, name from Tenant limit 80",
          referencedTables: ["Tenant"],
          referencedColumns: ["id", "name"],
          limit: 80
        }
      })
    });

    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore: new InMemorySessionStore(4),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0,
        maxToolResultChars: 800
      },
      transport: createTransport([
        {
          id: "resp_tool_large",
          output: [
            {
              type: "function_call",
              call_id: "call_query_1",
              name: "query-sql",
              arguments: "{\"sql\":\"select id, name from Tenant limit 80\"}"
            }
          ]
        },
        {
          id: "resp_done_large",
          output_text: "Loaded a preview",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Loaded a preview" }]
            }
          ]
        }
      ])
    });

    const result = await executor.executeTurn({
      sessionId: "large-query-session",
      message: "Show me tenants"
    });

    expect(result.toolCalls).toEqual([
      {
        callId: "call_query_1",
        toolName: "query-sql",
        arguments: {
          sql: "select id, name from Tenant limit 80"
        },
        output: expect.objectContaining({
          rowCount: 80,
          previewRowCount: expect.any(Number),
          truncated: true
        })
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

  it("lists session summaries from the in-memory session store", () => {
    const sessionStore = new InMemorySessionStore(4);

    sessionStore.append("beta", [
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" }
    ]);
    sessionStore.append("alpha", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" }
    ]);

    expect(sessionStore.list()).toEqual([
      {
        sessionId: "alpha",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        messageCount: 2,
        lastMessage: {
          role: "assistant",
          content: "answer one"
        }
      },
      {
        sessionId: "beta",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        messageCount: 2,
        lastMessage: {
          role: "assistant",
          content: "answer two"
        }
      }
    ]);
  });

  it("deletes and clears in-memory session history", () => {
    const sessionStore = new InMemorySessionStore(4);

    sessionStore.append("alpha", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" }
    ]);
    sessionStore.append("beta", [
      { role: "user", content: "second" }
    ]);

    expect(sessionStore.delete("alpha")).toBe(true);
    expect(sessionStore.get("alpha")).toEqual([]);
    expect(sessionStore.delete("missing")).toBe(false);
    expect(sessionStore.clear()).toBe(1);
    expect(sessionStore.list()).toEqual([]);
  });

  it("lists and deletes persisted file-backed sessions", () => {
    const filePath = createTempSessionStorePath();
    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    sessionStore.append("persisted-a", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" }
    ]);
    sessionStore.append("persisted-b", [
      { role: "user", content: "second" }
    ]);

    const storedSessions = sessionStore.list();

    expect(storedSessions).toHaveLength(2);
    expect(storedSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "persisted-a",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          messageCount: 2,
          lastMessage: {
            role: "assistant",
            content: "answer one"
          }
        }),
        expect.objectContaining({
          sessionId: "persisted-b",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          messageCount: 1,
          lastMessage: {
            role: "user",
            content: "second"
          }
        })
      ])
    );
    expect(
      storedSessions[0]!.updatedAt.localeCompare(storedSessions[1]!.updatedAt)
    ).toBeGreaterThanOrEqual(0);
    expect(sessionStore.delete("persisted-a")).toBe(true);

    const reloadedStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    expect(reloadedStore.list()).toEqual([
      {
        sessionId: "persisted-b",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        messageCount: 1,
        lastMessage: {
          role: "user",
          content: "second"
        }
      }
    ]);

    cleanupTempSessionStore(filePath);
  });

  it("reads full session records with timestamps", () => {
    const sessionStore = new InMemorySessionStore(4);

    sessionStore.append("alpha", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" }
    ]);

    expect(sessionStore.read("alpha")).toEqual({
      sessionId: "alpha",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      messageCount: 2,
      lastMessage: {
        role: "assistant",
        content: "answer one"
      },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer one" }
      ]
    });
    expect(sessionStore.read("missing")).toBeUndefined();
  });

  it("updates session metadata in memory", () => {
    const sessionStore = new InMemorySessionStore(4);

    sessionStore.append("alpha", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" }
    ]);

    const updated = sessionStore.updateMetadata("alpha", {
      title: "Revenue Review",
      tags: ["finance", "q2", "finance"]
    });

    expect(updated).toEqual({
      sessionId: "alpha",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      messageCount: 2,
      title: "Revenue Review",
      tags: ["finance", "q2"],
      lastMessage: {
        role: "assistant",
        content: "answer one"
      },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer one" }
      ]
    });
    expect(sessionStore.list()[0]).toMatchObject({
      sessionId: "alpha",
      title: "Revenue Review",
      tags: ["finance", "q2"]
    });
  });

  it("forks persisted sessions with copied metadata and history", () => {
    const filePath = createTempSessionStorePath();
    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    sessionStore.append("source-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ]);
    sessionStore.updateMetadata("source-session", {
      title: "North Region Review",
      tags: ["north", "ops"]
    });

    const forked = sessionStore.fork("source-session", "fork-session");
    const reloadedStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    expect(forked).toMatchObject({
      sessionId: "fork-session",
      title: "North Region Review (fork)",
      tags: ["north", "ops"],
      forkedFromSessionId: "source-session",
      messageCount: 2
    });
    expect(reloadedStore.read("fork-session")).toMatchObject({
      sessionId: "fork-session",
      title: "North Region Review (fork)",
      tags: ["north", "ops"],
      forkedFromSessionId: "source-session",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" }
      ]
    });

    cleanupTempSessionStore(filePath);
  });

  it("upgrades version 1 persisted session files to version 2 records", () => {
    const filePath = createTempSessionStorePath();

    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          sessions: {
            legacy: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "world" }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });
    const session = sessionStore.read("legacy");

    expect(session).toEqual({
      sessionId: "legacy",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      messageCount: 2,
      lastMessage: {
        role: "assistant",
        content: "world"
      },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" }
      ]
    });

    sessionStore.append("legacy", [
      { role: "user", content: "again" },
      { role: "assistant", content: "done" }
    ]);

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      version: 2,
      sessions: {
        legacy: {
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "world" },
            { role: "user", content: "again" },
            { role: "assistant", content: "done" }
          ]
        }
      }
    });

    cleanupTempSessionStore(filePath);
  });

  it("clears persisted file-backed sessions and writes the empty state to disk", () => {
    const filePath = createTempSessionStorePath();
    const sessionStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    sessionStore.append("persisted", [
      { role: "user", content: "Remember me" },
      { role: "assistant", content: "I did" }
    ]);

    expect(sessionStore.clear()).toBe(1);

    const reloadedStore = new FileSessionStore({
      filePath,
      maxMessages: 4
    });

    expect(reloadedStore.list()).toEqual([]);
    expect(reloadedStore.get("persisted")).toEqual([]);

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

  it("stops streaming turns when the caller aborts the request", async () => {
    const sessionStore = new InMemorySessionStore();
    const controller = new AbortController();
    const streamResponse = vi.fn(async function* (request) {
      yield {
        type: "response.output_text.delta",
        delta: "partial"
      };

      if (request.signal?.aborted) {
        throw new AppError("Agent request was aborted", "AGENT_REQUEST_ABORTED", 499);
      }

      yield {
        type: "response.output_text.delta",
        delta: "late"
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
    const events: string[] = [];
    let partialText = "";

    await expect(
      (async () => {
        for await (const event of executor.streamTurn({
          sessionId: "stream-aborted",
          message: "Hi",
          signal: controller.signal
        })) {
          events.push(event.type);

          if (event.type === "response.output_text.delta") {
            partialText += event.delta;
            controller.abort();
          }
        }
      })()
    ).rejects.toMatchObject({
      code: "AGENT_REQUEST_ABORTED"
    });

    expect(events).toEqual([
      "session.started",
      "response.output_text.delta",
      "response.failed"
    ]);
    expect(partialText).toBe("partial");
    expect(sessionStore.get("stream-aborted")).toEqual([]);
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

  it("captures completed turn observability with tool traces", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "validate-sql",
      description: "validates a SQL statement",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"],
        additionalProperties: false
      },
      execute: ({ sql }: { sql: string }) => ({
        allowed: true,
        normalizedSql: sql
      })
    });

    const executor = new AgentExecutor({
      toolRegistry: registry,
      sessionStore: new InMemorySessionStore(4),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport: createTransport([
        {
          id: "resp_observe_tool",
          output: [
            {
              type: "function_call",
              call_id: "call_observe_1",
              name: "validate-sql",
              arguments: "{\"sql\":\"select 1\"}"
            }
          ]
        },
        {
          id: "resp_observe_final",
          output_text: "The query is safe.",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The query is safe." }]
            }
          ]
        }
      ])
    });

    await executor.executeTurn({
      sessionId: "observe-success",
      message: "Can I run select 1?"
    });

    const snapshot = executor.getObservabilitySnapshot();

    expect(snapshot.summary).toMatchObject({
      totalTurns: 1,
      completedTurns: 1,
      failedTurns: 0,
      totalToolCalls: 1
    });
    expect(snapshot.summary.tools["validate-sql"]).toMatchObject({
      calls: 1,
      successes: 1,
      failures: 0
    });
    expect(snapshot.recentTurns[0]).toMatchObject({
      sessionId: "observe-success",
      status: "completed",
      modelResponseCount: 2,
      outputText: "The query is safe."
    });
    expect(snapshot.recentTurns[0]?.toolCalls[0]).toMatchObject({
      callId: "call_observe_1",
      toolName: "validate-sql",
      status: "completed"
    });
  });

  it("captures failed turn observability", async () => {
    const executor = new AgentExecutor({
      toolRegistry: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(4),
      config: {
        apiKey: "test-key",
        apiEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-test",
        requestTimeoutMs: 1000,
        maxToolCalls: 4,
        maxRetries: 0
      },
      transport: {
        createResponse: async () => {
          throw new AppError("upstream unavailable", "OPENAI_REQUEST_FAILED", 502);
        }
      }
    });

    await expect(
      executor.executeTurn({
        sessionId: "observe-failure",
        message: "Hi"
      })
    ).rejects.toMatchObject({
      code: "OPENAI_REQUEST_FAILED"
    });

    const snapshot = executor.getObservabilitySnapshot();

    expect(snapshot.summary).toMatchObject({
      totalTurns: 1,
      completedTurns: 0,
      failedTurns: 1,
      totalToolCalls: 0
    });
    expect(snapshot.recentTurns[0]).toMatchObject({
      sessionId: "observe-failure",
      status: "failed",
      error: {
        code: "OPENAI_REQUEST_FAILED"
      }
    });
  });

  it("runs evaluation suites with pass and fail results", async () => {
    const registry = new ToolRegistry();
    const sessionStore = new InMemorySessionStore(8);

    registry.register({
      name: "validate-sql",
      description: "validates a SQL statement",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"],
        additionalProperties: false
      },
      execute: ({ sql }: { sql: string }) => ({
        allowed: true,
        normalizedSql: sql
      })
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
      transport: createTransport([
        {
          id: "resp_eval_tool",
          output: [
            {
              type: "function_call",
              call_id: "call_eval_1",
              name: "validate-sql",
              arguments: "{\"sql\":\"select 1\"}"
            }
          ]
        },
        {
          id: "resp_eval_final",
          output_text: "The query is safe.",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The query is safe." }]
            }
          ]
        },
        {
          id: "resp_eval_plain",
          output_text: "Hello there",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello there" }]
            }
          ]
        }
      ])
    });

    const report = await executor.runEvaluationSuite({
      name: "smoke",
      cases: [
        {
          id: "sql-safety",
          message: "Can I run select 1?",
          expected: {
            requiredToolNames: ["validate-sql"],
            outputIncludes: ["safe"],
            minToolCalls: 1
          }
        },
        {
          id: "missing-tool",
          message: "Say hi",
          expected: {
            requiredToolNames: ["validate-sql"]
          }
        }
      ]
    });

    expect(report).toMatchObject({
      name: "smoke",
      totalCases: 2,
      passedCases: 1,
      failedCases: 1
    });
    expect(report.results[0]).toMatchObject({
      caseId: "sql-safety",
      passed: true,
      toolNames: ["validate-sql"]
    });
    expect(report.results[1]).toMatchObject({
      caseId: "missing-tool",
      passed: false,
      toolNames: []
    });
    expect(report.results[1]?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "tool.required:validate-sql",
          passed: false
        })
      ])
    );
    expect(sessionStore.list()).toEqual([]);
    expect(executor.getObservabilitySnapshot().summary.totalTurns).toBe(2);
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
