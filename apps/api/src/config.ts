import { z } from "zod";
import { AppError } from "@clusterdata/shared";

const ConfigSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().optional().default("")
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = ConfigSchema.safeParse(env);

  if (!parsed.success) {
    throw new AppError("Invalid API configuration", "INVALID_API_CONFIG", 500, {
      issues: parsed.error.issues
    });
  }

  return {
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    databaseUrl: parsed.data.DATABASE_URL
  };
}

