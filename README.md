# ClusterDataAgent

Monorepo status:
- workspace scaffolded
- API, web app, and core domain packages are in place
- agent-core chat and streaming endpoints are in place
- web app now uses the chat streaming endpoint as an interactive ChatBI workbench with SQL validation, dataset profiling, and chart recommendation panels
- web workbench now includes an Access Check panel for tenant and role authorization decisions
- metadata-engine now loads the Prisma schema catalog from `packages/database/prisma/schema.prisma`
- sql-agent now validates and generates SELECT SQL against the loaded schema catalog
- analysis-service now profiles JSON datasets with field statistics and data quality warnings
- chart-engine now recommends charts from dataset profiles, including time series, category comparisons, numeric distributions, and outlier views
- tests, lint, typecheck, and build all pass

Current priority:
1. monorepo
2. agent-core
3. tool-system
4. metadata-engine
5. sql-agent
6. analysis-service
7. chart-engine
8. frontend
9. security

Commands:
- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm dev`
- `start.md` contains the startup sequence

Environment:
- Local development now reads the root `.env` file automatically for the API server.
- `OPENAI_API_KEY` enables `/api/chat` and `/api/chat/stream`
- `OPENAI_ENDPOINT` sets the compatible API base or full responses endpoint
- `OPENAI_MODEL` sets the default model for agent requests
- `OPENAI_TIMEOUT_MS` configures the OpenAI request timeout
- `AGENT_MAX_TOOL_CALLS` caps tool loops per turn
- `AGENT_MEMORY_LIMIT` controls in-memory session history size
- API request guardrails are configurable with `API_MAX_*` environment variables for chat text, SQL text, metadata search, dataset profiling, chart inputs, and generated SQL column counts

Apps:
- API: `apps/api`
- Web: `apps/web`
  - Streams chat from `/api/chat/stream`
  - Validates SQL through `/api/sql/validate`
  - Profiles JSON rows through `/api/analysis/profile`
  - Recommends charts through `/api/charts/suggest`
  - Checks tenant-scoped access through `/api/security/check`

Packages:
- `packages/shared`
- `packages/agent-core`
- `packages/tool-system`
- `packages/metadata-engine`
- `packages/sql-agent`
- `packages/analysis-service`
- `packages/chart-engine`
- `packages/security`
- `packages/database`

Database:
- `.env.example` points at the local test PostgreSQL database on `127.0.0.1:5433`.
- Default local test connection: `postgresql://postgres:aa@127.0.0.1:5433/clusterdata`.
- `docker-compose.yml` still provides a fallback PostgreSQL service on `localhost:5432` with password `postgres`.
- Set `METADATA_SOURCE=postgres` to scan the live database schema.
- Set `METADATA_SOURCE=prisma` to use `packages/database/prisma/schema.prisma` as the metadata source.
- `POSTGRES_SCHEMA` selects the scanned PostgreSQL schema and defaults to `public`.

Metadata and SQL:
- `GET /api/overview` includes the loaded table, column, and relation counts plus relation edges.
- `GET /api/metadata/tables` lists the current runtime catalog tables and columns.
- `GET /api/metadata/tables/:tableName` returns one table and its relation edges.
- `GET /api/metadata/relations?tableName=Tenant` filters relation edges for a table.
- `GET /api/metadata/search?q=tenant&limit=5` searches table, column, and relation metadata.
- `POST /api/metadata/refresh` reloads the Prisma schema catalog and updates metadata-backed SQL tools.
- `POST /api/sql/validate` validates only bounded SELECT/WITH statements, rejects unknown tables, unknown columns, ambiguous unqualified columns, unsafe `SELECT INTO`, destructive SQL, and checks alias/join references when metadata is available.
- `POST /api/sql/suggest` generates a safe SELECT from known table and column names.
- `POST /api/analysis/series` summarizes a numeric series.
- `POST /api/analysis/profile` profiles JSON rows, infers field kinds, computes numeric/category/date statistics, and reports missing, mixed, empty, and duplicate quality warnings.
- `POST /api/charts/suggest` accepts either legacy labels/values input or a dataset profile and returns chart recommendations.
- The registered agent tools include `validate-sql`, `generate-sql`, `summarize-series`, `profile-dataset`, `suggest-chart`, and `recommend-charts`.
- Current catalog inference is in-process; use `POST /api/metadata/refresh` after changing the Prisma schema or live PostgreSQL schema.

Security guardrails:
- `GET /api/overview` exposes the active request security limits under `requestSecurity`.
- Chat requests are capped by `API_MAX_SESSION_ID_CHARS`, `API_MAX_CHAT_MESSAGE_CHARS`, and `API_MAX_MODEL_CHARS`.
- SQL validation and suggestion requests are capped by `API_MAX_SQL_CHARS`, `API_MAX_IDENTIFIER_CHARS`, and `API_MAX_SQL_SUGGEST_COLUMNS`.
- Series, dataset, and chart requests are capped by `API_MAX_SERIES_POINTS`, `API_MAX_DATASET_ROWS`, `API_MAX_DATASET_FIELDS`, `API_MAX_DATASET_CELL_CHARS`, `API_MAX_CHART_DATA_POINTS`, and `API_MAX_CHART_RECOMMENDATIONS`.
- Metadata search is capped by `API_MAX_METADATA_SEARCH_CHARS` and `API_MAX_METADATA_SEARCH_LIMIT`.
- `/api/security/check` now validates role and action values explicitly before making an access decision.
- The web workbench includes an Access Check panel that calls `/api/security/check` and shows allow/deny decisions with policy reasons.

SQL examples:
- List metadata:
  - `curl http://127.0.0.1:3001/api/metadata/tables`
- Search metadata:
  - `curl "http://127.0.0.1:3001/api/metadata/search?q=tenant&limit=5"`
- Validate:
  - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 20\"}"`
- Validate a join with aliases:
  - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20\"}"`
- Suggest:
  - `curl -X POST http://127.0.0.1:3001/api/sql/suggest -H "content-type: application/json" -d "{\"tableName\":\"AuditLog\",\"columns\":[\"id\",\"tenantId\",\"action\"],\"limit\":25}"`

Analysis examples:
- Summarize a numeric series:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/series -H "content-type: application/json" -d "{\"points\":[1,2,3,4]}"`
- Profile JSON rows:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\"rows\":[{\"region\":\"north\",\"amount\":10,\"active\":true},{\"region\":\"south\",\"amount\":20,\"active\":false},{\"region\":\"north\",\"amount\":30,\"active\":true}]}"`

Chart examples:
- Legacy chart suggestion:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"title\":\"Revenue\",\"labels\":[\"Jan\",\"Feb\"],\"values\":[10,20],\"hasTimeAxis\":false}"`
- Profile-aware chart recommendations:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"profile\":{\"rowCount\":3,\"fieldCount\":3,\"fields\":[{\"name\":\"createdAt\",\"kind\":\"date\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[\"2026-01-01T00:00:00.000Z\"],\"minimum\":\"2026-01-01T00:00:00.000Z\",\"maximum\":\"2026-01-03T00:00:00.000Z\"},{\"name\":\"revenue\",\"kind\":\"number\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[10,20,30],\"minimum\":10,\"maximum\":30,\"average\":20,\"median\":20,\"standardDeviation\":8.16,\"outliers\":[]},{\"name\":\"region\",\"kind\":\"string\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":2,\"examples\":[\"north\",\"south\"],\"topValues\":[{\"value\":\"north\",\"count\":2},{\"value\":\"south\",\"count\":1}]}],\"quality\":{\"emptyFieldCount\":0,\"highMissingFieldCount\":0,\"mixedFieldCount\":0,\"duplicateRowCount\":0,\"warnings\":[]}},\"maxRecommendations\":3}"`

Web workbench:
- Open `http://127.0.0.1:3000`.
- Use the Conversation panel for streaming agent chat.
- Use SQL Guardrail to validate metadata-aware SQL directly.
- Use Access Check to verify tenant isolation and role/action authorization decisions.
- Use Dataset Profile with JSON rows, then Chart Recommendations to get profile-aware chart suggestions.

PostgreSQL test schema:
- The development scanner was verified against `127.0.0.1:5433/clusterdata` using test tables `cda_customers`, `cda_orders`, and `cda_order_events`.
- The reusable fixture is `packages/database/prisma/postgres-test-schema.sql`.
- The scanner reads `information_schema.columns` plus PostgreSQL foreign key metadata and exposes the result through the same metadata endpoints.

Prompt files:
- `.codex/prompts/SYSTEM_PROMPT.md`
- `.codex/prompts/AUTONOMOUS_OVERNIGHT_PROMPT.md`
- `.codex/prompts/ROADMAP.md`

Agent endpoints:
- `POST /api/chat`
  - request: `{ "sessionId": "demo", "message": "Validate this SQL", "model": "optional-override" }`
  - response: `{ "ok": true, "sessionId": "demo", "outputText": "...", "toolCalls": [], "usage": { ... } }`
- `POST /api/chat/stream`
  - request: same as `/api/chat`
  - response: `text/event-stream` with events `session.started`, `response.output_text.delta`, `tool.call.started`, `tool.call.completed`, `response.completed`, `response.failed`

Notes:
- Agent memory is stored in-process only and is cleared when the API restarts.
- `OPENAI_ENDPOINT` accepts either a base URL like `https://openrouter.ai/api/v1` or a full endpoint like `https://openrouter.ai/api/v1/responses`.
- The Python `analysis-service` roadmap item is still a later phase; current analysis remains TypeScript-based.
