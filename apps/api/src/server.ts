import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, safeErrorMessage } from "@clusterdata/shared";
import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";

const logger = createLogger("api-server");
const moduleDir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(moduleDir, "../../../.env");

dotenv.config({ path: rootEnvPath, override: true });

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const app = await buildApi();

  try {
    await app.listen({
      host: config.host,
      port: config.port
    });

    logger.info("API server listening", {
      host: config.host,
      port: config.port
    });
  } catch (error) {
    logger.error("API server failed to start", {
      error: safeErrorMessage(error)
    });

    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error("Unhandled API bootstrap error", {
    error: safeErrorMessage(error)
  });

  process.exitCode = 1;
});

