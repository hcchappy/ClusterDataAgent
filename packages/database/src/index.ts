import { z } from "zod";
import { AppError } from "@clusterdata/shared";

export const DatabaseConfigSchema = z.object({
  databaseUrl: z.string().optional().default("")
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export function summarizeDatabaseConfig(config: DatabaseConfig): {
  readonly configured: boolean;
  readonly dialect: "postgresql" | "unknown";
} {
  const parsed = DatabaseConfigSchema.safeParse(config);

  if (!parsed.success) {
    throw new AppError("Invalid database config", "INVALID_DATABASE_CONFIG", 400, {
      issues: parsed.error.issues
    });
  }

  return {
    configured: parsed.data.databaseUrl.length > 0,
    dialect: parsed.data.databaseUrl.startsWith("postgresql://")
      ? "postgresql"
      : "unknown"
  };
}
