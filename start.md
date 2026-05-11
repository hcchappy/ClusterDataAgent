# Start ClusterDataAgent

1. Install dependencies
   - `pnpm install`

   The API server now loads the root `.env` file automatically during local development.

2. Start PostgreSQL
   - Preferred local test database:
     - host: `127.0.0.1`
     - port: `5433`
     - database: `clusterdata`
     - username: `postgres`
     - password: `aa`
   - Fallback docker database:
     - `docker compose up -d postgres`
   - Optional test schema fixture:
     - `packages/database/prisma/postgres-test-schema.sql`

3. Start the project
   - `pnpm dev`

4. Open the apps
   - Web: `http://127.0.0.1:3000`
   - API: `http://127.0.0.1:3001/health`
   - Overview: `http://127.0.0.1:3001/api/overview`
   - The web workbench includes streaming chat, SQL Guardrail, Access Check, Dataset Profile, and Chart Recommendations panels.

5. Enable chat endpoints
   - Set `OPENAI_API_KEY` in your environment or `.env`
   - Optional overrides:
     - `OPENAI_ENDPOINT=https://api.openai.com/v1`
     - `OPENAI_MODEL=gpt-4.1-mini`
     - `OPENAI_TIMEOUT_MS=30000`
     - `AGENT_MAX_TOOL_CALLS=6`
     - `AGENT_MEMORY_LIMIT=20`
   - Optional API guardrail overrides:
     - `API_MAX_CHAT_MESSAGE_CHARS=8000`
     - `API_MAX_SQL_CHARS=20000`
     - `API_MAX_DATASET_ROWS=1000`
     - `API_MAX_DATASET_FIELDS=100`
     - `API_MAX_CHART_DATA_POINTS=5000`
     - `API_MAX_METADATA_SEARCH_LIMIT=100`

6. Try the agent
   - Non-streaming:
     - `curl -X POST http://127.0.0.1:3001/api/chat -H "content-type: application/json" -d "{\"sessionId\":\"demo\",\"message\":\"Validate select * from Tenant limit 20\"}"`
   - Streaming:
     - `curl -N -X POST http://127.0.0.1:3001/api/chat/stream -H "content-type: application/json" -d "{\"sessionId\":\"demo\",\"message\":\"Summarize the series 1,2,3,4\"}"`

7. Try metadata-backed SQL
   - With `METADATA_SOURCE=postgres`, the API scans `DATABASE_URL` and `POSTGRES_SCHEMA`.
   - With `METADATA_SOURCE=prisma`, the API loads `packages/database/prisma/schema.prisma`.
   - List tables:
     - `curl http://127.0.0.1:3001/api/metadata/tables`
   - Get one table:
     - `curl http://127.0.0.1:3001/api/metadata/tables/AuditLog`
   - Search metadata:
     - `curl "http://127.0.0.1:3001/api/metadata/search?q=tenant&limit=5"`
   - Refresh metadata after editing Prisma schema:
     - `curl -X POST http://127.0.0.1:3001/api/metadata/refresh`
   - Validate:
     - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 20\"}"`
   - Validate a PostgreSQL join with aliases:
     - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20\"}"`
   - Suggest:
     - `curl -X POST http://127.0.0.1:3001/api/sql/suggest -H "content-type: application/json" -d "{\"tableName\":\"cda_orders\",\"columns\":[\"id\",\"customer_id\",\"amount\"],\"limit\":25}"`
   - Metadata-backed validation requires bounded queries and rejects unknown tables, unknown columns, ambiguous unqualified columns, unsafe `SELECT INTO`, and destructive SQL.

8. Try analysis profiling
   - Summarize a numeric series:
     - `curl -X POST http://127.0.0.1:3001/api/analysis/series -H "content-type: application/json" -d "{\"points\":[1,2,3,4]}"`
   - Profile JSON rows:
     - `curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\"rows\":[{\"region\":\"north\",\"amount\":10,\"active\":true},{\"region\":\"south\",\"amount\":20,\"active\":false},{\"region\":\"north\",\"amount\":30,\"active\":true}]}"`
   - Dataset profiling infers numeric, string, boolean, date, mixed, and empty fields and returns field statistics plus quality warnings.

9. Try chart recommendations
   - Legacy chart suggestion:
     - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"title\":\"Revenue\",\"labels\":[\"Jan\",\"Feb\"],\"values\":[10,20],\"hasTimeAxis\":false}"`
   - Profile-aware chart recommendations:
     - Call `POST /api/analysis/profile` first, then pass the returned `profile` to `POST /api/charts/suggest` with optional `maxRecommendations`.
   - The chart engine recommends time series, category comparisons, numeric distributions, outlier scatter views, or a table fallback depending on the dataset profile.

10. Try the web workbench
   - Open `http://127.0.0.1:3000`.
   - Paste a bounded SELECT in SQL Guardrail and click `Validate SQL`.
   - Use Access Check to test role, tenant, resource tenant, and action decisions.
   - Paste JSON rows in Dataset Profile and click `Run Profile`.
   - Click `Recommend Charts` to turn the profile into chart recommendations.

11. Inspect request guardrails
   - `curl http://127.0.0.1:3001/api/overview`
   - The `requestSecurity` field shows active limits for chat, SQL, metadata search, dataset profiling, and chart inputs.
   - Oversized or invalid inputs return 400 with an `AppError` code such as `CHAT_MESSAGE_TOO_LARGE`, `SQL_TOO_LARGE`, or `DATASET_ROW_LIMIT_EXCEEDED`.
