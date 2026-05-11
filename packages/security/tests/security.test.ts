import { describe, expect, it } from "vitest";
import { authorizeAccess, assertAccess } from "../src/index.js";

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
});

