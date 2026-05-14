import { defineConfig } from "prisma/config";

const DEFAULT_DATABASE_URL = "postgresql://postgres:aa@127.0.0.1:5432/clusterdata";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  }
});
