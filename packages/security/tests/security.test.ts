import { describe, expect, it } from "vitest";
import {
  assertAccess,
  assertAccessRequestInput,
  assertChatRequestSecurity,
  assertDatasetProfileRequestSecurity,
  assertSqlRequestSecurity,
  assertTimeSeriesRequestSecurity,
  authorizeAccess,
  buildRequestSecurityPolicy
} from "../src/index.js";

describe("security", () => {
  it("blocks cross-tenant access", () => {
    const decision = authorizeAccess({
      role: "analyst",
      tenantId: "a",
      resourceTenantId: "b",
      action: "read"
    });

    expect(decision.allowed).toBe(false);
  });

  it("allows same-tenant read access", () => {
    expect(() =>
      assertAccess({
        role: "viewer",
        tenantId: "a",
        resourceTenantId: "a",
        action: "read"
      })
    ).not.toThrow();
  });

  it("rejects invalid access request fields", () => {
    expect(() =>
      assertAccessRequestInput({
        role: "owner",
        tenantId: "a",
        resourceTenantId: "a",
        action: "read"
      })
    ).toThrow("Invalid security role");

    expect(() =>
      assertAccessRequestInput({
        role: "viewer",
        tenantId: "a",
        resourceTenantId: "a",
        action: "export"
      })
    ).toThrow("Invalid security action");
  });

  it("guards chat request size", () => {
    const policy = buildRequestSecurityPolicy({
      maxChatMessageChars: 4
    });

    expect(() =>
      assertChatRequestSecurity(
        {
          sessionId: "session",
          message: "hello"
        },
        policy
      )
    ).toThrow("message is too large");
  });

  it("guards SQL request size and null bytes", () => {
    const policy = buildRequestSecurityPolicy({
      maxSqlChars: 10
    });

    expect(() =>
      assertSqlRequestSecurity(
        {
          sql: "select * from Tenant limit 10"
        },
        policy
      )
    ).toThrow("sql is too large");

    expect(() =>
      assertSqlRequestSecurity({
        sql: "select \0"
      })
    ).toThrow("SQL cannot contain null bytes");
  });

  it("guards dataset row and field limits", () => {
    const policy = buildRequestSecurityPolicy({
      maxDatasetRows: 1,
      maxDatasetFields: 1
    });

    expect(() =>
      assertDatasetProfileRequestSecurity(
        {
          rows: [{ region: "north" }, { region: "south" }]
        },
        policy
      )
    ).toThrow("Too many dataset rows");

    expect(() =>
      assertDatasetProfileRequestSecurity(
        {
          rows: [{ region: "north", amount: 10 }]
        },
        policy
      )
    ).toThrow("Too many dataset fields");
  });

  it("guards time series point and window limits", () => {
    const policy = buildRequestSecurityPolicy({
      maxSeriesPoints: 1
    });

    expect(() =>
      assertTimeSeriesRequestSecurity(
        {
          points: [
            { timestamp: "2026-01-01T00:00:00.000Z", value: 1 },
            { timestamp: "2026-01-02T00:00:00.000Z", value: 2 }
          ]
        },
        policy
      )
    ).toThrow("Too many time series points");

    expect(() =>
      assertTimeSeriesRequestSecurity({
        points: [{ timestamp: "2026-01-01T00:00:00.000Z", value: 1 }],
        movingAverageWindow: 0
      })
    ).toThrow("movingAverageWindow must be a positive integer");
  });
});

