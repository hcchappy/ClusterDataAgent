import { z } from "zod";
import { AppError } from "@clusterdata/shared";

export const DevelopmentPrioritySchema = z.enum([
  "monorepo",
  "agent-core",
  "tool-system",
  "metadata-engine",
  "sql-agent",
  "analysis-service",
  "chart-engine",
  "frontend",
  "security"
]);

export const AgentManifestSchema = z.object({
  projectName: z.string().min(1),
  currentGoal: z.string().min(1),
  priorities: z.array(DevelopmentPrioritySchema).min(1),
  rules: z.array(z.string().min(1)).min(1)
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export function buildAgentManifest(manifest: AgentManifest): {
  projectName: string;
  currentGoal: string;
  nextPriority: string;
  rules: readonly string[];
  summary: string;
} {
  const parsed = AgentManifestSchema.safeParse(manifest);

  if (!parsed.success) {
    throw new AppError("Invalid agent manifest", "INVALID_AGENT_MANIFEST", 400, {
      issues: parsed.error.issues
    });
  }

  const [nextPriority] = parsed.data.priorities;

  return {
    projectName: parsed.data.projectName,
    currentGoal: parsed.data.currentGoal,
    nextPriority,
    rules: parsed.data.rules,
    summary: `${parsed.data.projectName}: ${parsed.data.currentGoal}`
  };
}

