import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeDatasetInsights,
  clearAgentSessions,
  checkAccess,
  deleteAgentSession,
  executeSemanticQuery,
  executeSqlQuery,
  forkAgentSession,
  getAgentSession,
  getMetadataInsights,
  getOperatorRuntime,
  getSemanticInsights,
  getSqlQueryJob,
  getSqlQueryJobResult,
  generateSemanticSql,
  listAgentSessions,
  requestJson,
  parseSseStream,
  profileDataset,
  recommendCharts,
  searchMetadata,
  searchSemantics,
  startSqlQueryJob,
  streamChat,
  updateAgentSession,
  validateSql,
  type DatasetProfile
} from "../src/api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web api helpers", () => {
  it("parses text and completion events from an sse stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: session.started\ndata: {"type":"session.started","sessionId":"a","model":"gpt-test"}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sessionId":"a","delta":"Hello"}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'event: response.completed\ndata: {"type":"response.completed","sessionId":"a","outputText":"Hello","toolCalls":[]}\n\n'
          )
        );
        controller.close();
      }
    });
    const events = [];

    for await (const event of parseSseStream(stream)) {
      events.push(event.type);
    }

    expect(events).toEqual([
      "session.started",
      "response.output_text.delta",
      "response.completed"
    ]);
  });

  it("calls SQL validation endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          allowed: true,
          normalizedSql: "select id from Tenant limit 20"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await validateSql("select id from Tenant limit 20");

    expect(result.allowed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sql: "select id from Tenant limit 20" })
      })
    );
  });

  it("calls SQL query endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          columns: ["id", "name"],
          rows: [{ id: "tenant-a", name: "Tenant A" }],
          rowCount: 1,
          durationMs: 8,
          validation: {
            allowed: true,
            normalizedSql: "select id, name from Tenant limit 1",
            referencedTables: ["Tenant"],
            referencedColumns: ["id", "name"],
            limit: 1
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await executeSqlQuery("select id, name from Tenant limit 1");

    expect(result.rowCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sql: "select id, name from Tenant limit 1" })
      })
    );
  });

  it("passes role-aware SQL requests when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          allowed: false,
          normalizedSql: "select createdAt from Tenant limit 1",
          reason: "Role viewer cannot read columns: Tenant.createdAt"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await validateSql("select createdAt from Tenant limit 1", {
      role: "viewer"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sql: "select createdAt from Tenant limit 1",
          role: "viewer"
        })
      })
    );
  });

  it("passes role-aware SQL query requests when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          columns: ["id"],
          rows: [{ id: "tenant-a" }],
          rowCount: 1,
          durationMs: 9,
          validation: {
            allowed: true,
            normalizedSql: "select id from Tenant limit 1",
            referencedTables: ["Tenant"],
            referencedColumns: ["id"],
            limit: 1
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await executeSqlQuery("select id from Tenant limit 1", {
      role: "viewer"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sql: "select id from Tenant limit 1",
          role: "viewer"
        })
      })
    );
  });

  it("calls dataset profile endpoint", async () => {
    const profile: DatasetProfile = {
      rowCount: 1,
      fieldCount: 1,
      fields: [
        {
          name: "revenue",
          kind: "number",
          count: 1,
          missingCount: 0,
          missingRatio: 0,
          distinctCount: 1,
          examples: [10]
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

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ profile }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(profileDataset([{ revenue: 10 }])).resolves.toEqual(profile);
  });

  it("calls dataset insights endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          profile: {
            rowCount: 2,
            fieldCount: 2,
            fields: [],
            quality: {
              emptyFieldCount: 0,
              highMissingFieldCount: 0,
              mixedFieldCount: 0,
              duplicateRowCount: 0,
              warnings: []
            }
          },
          insights: [
            {
              kind: "trend",
              title: "revenue trend",
              summary: "revenue rose across 2 time buckets.",
              fields: ["createdAt", "revenue"]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(
      analyzeDatasetInsights([
        { createdAt: "2026-01-01T00:00:00.000Z", revenue: 10 },
        { createdAt: "2026-01-02T00:00:00.000Z", revenue: 20 }
      ])
    ).resolves.toMatchObject({
      insights: [
        expect.objectContaining({
          kind: "trend"
        })
      ]
    });
  });

  it("calls chart recommendation endpoint", async () => {
    const profile: DatasetProfile = {
      rowCount: 1,
      fieldCount: 1,
      fields: [
        {
          name: "revenue",
          kind: "number",
          count: 1,
          missingCount: 0,
          missingRatio: 0,
          distinctCount: 1,
          examples: [10]
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

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          recommendations: [
            {
              kind: "histogram",
              title: "revenue distribution",
              dimensions: ["revenue"],
              metrics: ["revenue"],
              score: 0.78,
              reason: "Numeric fields can be inspected for spread, skew, and outliers"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(recommendCharts(profile, 3)).resolves.toHaveLength(1);
  });

  it("calls security check endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: {
            allowed: false,
            reason: "Viewer role is read-only",
            code: "VIEWER_READ_ONLY"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const decision = await checkAccess({
      role: "viewer",
      tenantId: "tenant-a",
      resourceTenantId: "tenant-a",
      action: "write"
    });

    expect(decision.allowed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/security/check",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          role: "viewer",
          tenantId: "tenant-a",
          resourceTenantId: "tenant-a",
          action: "write"
        })
      })
    );
  });

  it("passes an abort signal to the streaming chat request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          }
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      )
    );
    const controller = new AbortController();

    await streamChat(
      {
        sessionId: "session-a",
        message: "hello"
      },
      () => {},
      {
        signal: controller.signal
      }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/chat/stream",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal
      })
    );
  });

  it("passes pagination and cache controls to the SQL query endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          columns: ["id"],
          rows: [{ id: "tenant-b" }],
          rowCount: 42,
          durationMs: 6,
          page: {
            offset: 20,
            limit: 10,
            returnedRows: 1,
            hasMore: true
          },
          cache: {
            key: "query:test",
            hit: true,
            createdAt: "2026-05-18T09:00:00.000Z",
            expiresAt: "2026-05-18T09:05:00.000Z"
          },
          validation: {
            allowed: true,
            normalizedSql: "select id from Tenant limit 42",
            referencedTables: ["Tenant"],
            referencedColumns: ["id"],
            limit: 42
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await executeSqlQuery("select id from Tenant limit 42", {
      role: "analyst",
      offset: 20,
      pageLimit: 10,
      useCache: false
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sql: "select id from Tenant limit 42",
          role: "analyst",
          offset: 20,
          pageLimit: 10,
          useCache: false
        })
      })
    );
  });

  it("starts async SQL query jobs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            jobId: "job-1",
            status: "running",
            submittedAt: "2026-05-18T09:00:00.000Z",
            startedAt: "2026-05-18T09:00:00.000Z",
            expiresAt: "2026-05-18T09:15:00.000Z"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      startSqlQueryJob("select id from Tenant limit 1", {
        role: "viewer"
      })
    ).resolves.toMatchObject({
      jobId: "job-1",
      status: "running"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query/async",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sql: "select id from Tenant limit 1",
          role: "viewer"
        })
      })
    );
  });

  it("loads async SQL query job status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            jobId: "job-2",
            status: "completed",
            submittedAt: "2026-05-18T09:00:00.000Z",
            startedAt: "2026-05-18T09:00:00.000Z",
            completedAt: "2026-05-18T09:00:01.000Z",
            expiresAt: "2026-05-18T09:15:00.000Z",
            rowCount: 2,
            durationMs: 8
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(getSqlQueryJob("job-2")).resolves.toMatchObject({
      jobId: "job-2",
      status: "completed"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query/jobs/job-2",
      expect.any(Object)
    );
  });

  it("loads async SQL query job results with pagination", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            columns: ["id"],
            rows: [{ id: "tenant-c" }],
            rowCount: 42,
            durationMs: 6,
            page: {
              offset: 10,
              limit: 10,
              returnedRows: 1,
              hasMore: true
            },
            cache: {
              key: "query:test",
              hit: true,
              createdAt: "2026-05-18T09:00:00.000Z",
              expiresAt: "2026-05-18T09:05:00.000Z"
            },
            validation: {
              allowed: true,
              normalizedSql: "select id from Tenant limit 42",
              referencedTables: ["Tenant"],
              referencedColumns: ["id"],
              limit: 42
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      getSqlQueryJobResult("job-3", {
        offset: 10,
        pageLimit: 10
      })
    ).resolves.toMatchObject({
      rowCount: 42,
      page: {
        offset: 10,
        limit: 10
      }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/sql/query/jobs/job-3/result?offset=10&pageLimit=10",
      expect.any(Object)
    );
  });

  it("loads metadata insights for the workbench explorer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          insights: {
            summary: {
              tableCount: 2,
              columnCount: 4,
              relationCount: 1
            },
            dataTypes: [{ dataType: "text", count: 2 }],
            relationHotspots: [{ tableName: "orders", relationCount: 1 }],
            tables: [
              {
                tableName: "orders",
                columnCount: 3,
                relationCount: 1,
                sampleColumns: [{ name: "id", dataType: "integer" }],
                relatedTables: ["customers"],
                starterQuery: "select id from orders limit 20"
              }
            ]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(getMetadataInsights(4)).resolves.toMatchObject({
      tables: [expect.objectContaining({ tableName: "orders" })]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/metadata/insights?limit=4",
      expect.any(Object)
    );
  });

  it("searches metadata for explorer queries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              type: "column",
              tableName: "orders",
              columnName: "customer_id",
              score: 91
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(searchMetadata("customer", 6)).resolves.toEqual([
      expect.objectContaining({
        tableName: "orders",
        columnName: "customer_id"
      })
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/metadata/search?q=customer&limit=6",
      expect.any(Object)
    );
  });

  it("loads semantic insights for the semantic explorer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          insights: {
            summary: {
              modelCount: 2,
              metricCount: 3,
              dimensionCount: 7,
              ownerCount: 2
            },
            models: [
              {
                modelId: "tenant",
                label: "Tenant",
                tableName: "Tenant",
                dimensionCount: 3,
                metricCount: 1
              }
            ],
            metrics: [
              {
                metricId: "tenant_count",
                label: "Tenant Count",
                modelId: "tenant",
                aggregation: "count",
                allowedDimensionCount: 2
              }
            ],
            owners: [
              {
                owner: "platform",
                modelCount: 1,
                metricCount: 1
              }
            ]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(getSemanticInsights(2, 4)).resolves.toMatchObject({
      metrics: [expect.objectContaining({ metricId: "tenant_count" })]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/semantic/insights?modelLimit=2&metricLimit=4",
      expect.any(Object)
    );
  });

  it("searches semantics for metric and dimension queries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              type: "metric",
              id: "tenant_count",
              label: "Tenant Count",
              modelId: "tenant",
              tableName: "Tenant",
              score: 100
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(searchSemantics("tenant count", 5)).resolves.toEqual([
      expect.objectContaining({
        id: "tenant_count"
      })
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/semantic/search?q=tenant%20count&limit=5",
      expect.any(Object)
    );
  });

  it("calls semantic sql generation endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            modelId: "tenant",
            modelLabel: "Tenant",
            metricIds: ["tenant_count"],
            dimensionIds: ["tenant.name"],
            limit: 10,
            sql: 'select "name" as "tenant_name", count("id") as "tenant_count"\nfrom "Tenant"\ngroup by "name"\norder by "tenant_count" desc\nlimit 10',
            metrics: [],
            dimensions: [],
            filters: [],
            referencedTables: ["Tenant"],
            referencedColumns: ["Tenant.id", "Tenant.name"]
          },
          sql: 'select "name" as "tenant_name", count("id") as "tenant_count"\nfrom "Tenant"\ngroup by "name"\norder by "tenant_count" desc\nlimit 10'
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(
      generateSemanticSql({
        metricIds: ["tenant_count"],
        dimensionIds: ["tenant.name"],
        limit: 10
      })
    ).resolves.toMatchObject({
      query: expect.objectContaining({
        metricIds: ["tenant_count"]
      })
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/semantic/sql",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          metricIds: ["tenant_count"],
          dimensionIds: ["tenant.name"],
          limit: 10
        })
      })
    );
  });

  it("calls semantic query execution endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            modelId: "tenant",
            modelLabel: "Tenant",
            metricIds: ["tenant_count"],
            dimensionIds: ["tenant.name"],
            limit: 10,
            sql: 'select "name" as "tenant_name", count("id") as "tenant_count"\nfrom "Tenant"\ngroup by "name"\norder by "tenant_count" desc\nlimit 10',
            metrics: [],
            dimensions: [],
            filters: [],
            referencedTables: ["Tenant"],
            referencedColumns: ["Tenant.id", "Tenant.name"]
          },
          sql: 'select "name" as "tenant_name", count("id") as "tenant_count"\nfrom "Tenant"\ngroup by "name"\norder by "tenant_count" desc\nlimit 10',
          columns: ["tenant_name", "tenant_count"],
          rows: [{ tenant_name: "Tenant A", tenant_count: 1 }],
          rowCount: 1,
          durationMs: 7,
          validation: {
            allowed: true,
            normalizedSql: 'select "name" as "tenant_name", count("id") as "tenant_count"\nfrom "Tenant"\ngroup by "name"\norder by "tenant_count" desc\nlimit 10'
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(
      executeSemanticQuery({
        metricIds: ["tenant_count"],
        dimensionIds: ["tenant.name"],
        limit: 10
      })
    ).resolves.toMatchObject({
      rowCount: 1,
      columns: ["tenant_name", "tenant_count"]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/semantic/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          metricIds: ["tenant_count"],
          dimensionIds: ["tenant.name"],
          limit: 10
        })
      })
    );
  });

  it("surfaces structured streaming chat errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          message: "Too many chat requests",
          code: "CHAT_RATE_LIMITED",
          error: {
            message: "Too many chat requests",
            code: "CHAT_RATE_LIMITED",
            statusCode: 429,
            requestId: "req-stream-1",
            details: {
              retryAfterMs: 4200
            }
          }
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(
      streamChat(
        {
          sessionId: "session-a",
          message: "hello"
        },
        () => {}
      )
    ).rejects.toMatchObject({
      message: "Too many chat requests",
      code: "CHAT_RATE_LIMITED",
      statusCode: 429,
      requestId: "req-stream-1"
    });
  });

  it("sends the operator header when listing agent sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await listAgentSessions({ apiKey: "operator-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when loading one agent session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session: {
            sessionId: "session-a",
            createdAt: "2026-05-12T14:00:00.000Z",
            updatedAt: "2026-05-12T14:05:00.000Z",
            messageCount: 2,
            messages: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" }
            ]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await getAgentSession("session-a", { apiKey: "operator-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions/session-a",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when updating one agent session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session: {
            sessionId: "session-a",
            createdAt: "2026-05-12T14:00:00.000Z",
            updatedAt: "2026-05-12T14:05:00.000Z",
            messageCount: 2,
            title: "Revenue Review",
            tags: ["finance", "q2"],
            messages: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" }
            ]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await updateAgentSession(
      "session-a",
      {
        title: "Revenue Review",
        tags: ["finance", "q2"]
      },
      { apiKey: "operator-secret" }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions/session-a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          title: "Revenue Review",
          tags: ["finance", "q2"]
        }),
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when forking one agent session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sourceSessionId: "session-a",
          session: {
            sessionId: "session-b",
            createdAt: "2026-05-12T14:06:00.000Z",
            updatedAt: "2026-05-12T14:06:00.000Z",
            messageCount: 2,
            title: "Revenue Review (fork)",
            tags: ["finance", "q2"],
            forkedFromSessionId: "session-a",
            messages: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" }
            ]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await forkAgentSession(
      "session-a",
      {
        title: "Revenue Review (fork)",
        tags: ["finance", "q2"]
      },
      { apiKey: "operator-secret" }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions/session-a/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Revenue Review (fork)",
          tags: ["finance", "q2"]
        }),
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when deleting one agent session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "session-a",
          deleted: true
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await deleteAgentSession("session-a", { apiKey: "operator-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions/session-a",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when clearing agent sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          deletedCount: 2
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await clearAgentSessions({ apiKey: "operator-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/agent/sessions",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("sends the operator header when loading operator runtime", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          runtime: {
            startedAt: "2026-05-12T14:00:00.000Z",
            uptimeMs: 240000,
            activeRequests: 1,
            activeChatStreams: 0,
            totalRequests: 12,
            rateLimitedRequests: 1,
            lastMetadataRefreshAt: "2026-05-12T13:55:00.000Z",
            statusCounts: {
              success: 10,
              clientError: 1,
              serverError: 1
            },
            chatStreams: {
              started: 4,
              completed: 3,
              aborted: 1,
              failed: 0
            },
            routes: [
              {
                route: "/api/chat/stream",
                requests: 4
              }
            ]
          },
          sessionCount: 2,
          toolCount: 9,
          toolMetrics: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await getOperatorRuntime({ apiKey: "operator-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/ops/runtime",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-operator-api-key": "operator-secret"
        })
      })
    );
  });

  it("reports non-JSON API responses with the requested URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html><title>Vite App</title>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );

    await expect(requestJson("/api/overview")).rejects.toThrow(
      "Expected JSON from http://127.0.0.1:3001/api/overview"
    );
  });

  it("surfaces structured API errors with the server message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          message: "SQL read access denied",
          code: "SQL_ACCESS_DENIED",
          error: {
            message: "SQL read access denied",
            code: "SQL_ACCESS_DENIED",
            statusCode: 403,
            requestId: "req-123"
          }
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(requestJson("/api/sql/query")).rejects.toMatchObject({
      message: "SQL read access denied",
      code: "SQL_ACCESS_DENIED",
      statusCode: 403,
      requestId: "req-123"
    });
  });
});
