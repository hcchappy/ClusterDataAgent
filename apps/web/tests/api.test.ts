import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAccess,
  parseSseStream,
  profileDataset,
  recommendCharts,
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
});
