import { describe, expect, it } from "vitest";
import { AppError, formatLogEntry, safeErrorMessage } from "../src/index.js";

describe("shared", () => {
  it("formats log entries", () => {
    const entry = JSON.parse(
      formatLogEntry("info", "shared", "boot", { value: 1 })
    ) as {
      level: string;
      scope: string;
      message: string;
      context: { value: number };
    };

    expect(entry.level).toBe("info");
    expect(entry.scope).toBe("shared");
    expect(entry.message).toBe("boot");
    expect(entry.context.value).toBe(1);
  });

  it("normalizes error messages", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
    expect(safeErrorMessage("boom")).toBe("boom");
    expect(safeErrorMessage(null)).toBe("Unexpected error");
  });

  it("preserves app error metadata", () => {
    const error = new AppError("bad request", "BAD_REQUEST", 400, {
      field: "name"
    });

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.statusCode).toBe(400);
    expect(error.details?.field).toBe("name");
  });
});

