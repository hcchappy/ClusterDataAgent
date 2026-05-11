import { describe, expect, it } from "vitest";
import { buildAgentManifest } from "../src/index.js";

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
});

