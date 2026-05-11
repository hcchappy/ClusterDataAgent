import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/app.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("api", () => {
  it("returns health information", async () => {
    vi.stubEnv("API_HOST", "127.0.0.1");
    vi.stubEnv("API_PORT", "3001");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@localhost:5432/clusterdata"
    );

    const app = await buildApi();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await app.close();
  });

  it("validates SQL statements", async () => {
    vi.stubEnv("API_HOST", "127.0.0.1");
    vi.stubEnv("API_PORT", "3001");

    const app = await buildApi();
    const response = await app.inject({
      method: "POST",
      url: "/api/sql/validate",
      payload: {
        sql: "select * from orders"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowed).toBe(true);

    await app.close();
  });
});

