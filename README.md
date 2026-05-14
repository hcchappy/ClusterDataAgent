# ClusterDataAgent

Monorepo status:
- workspace scaffolded
- API, web app, and core domain packages are in place
- agent-core chat, native upstream SSE streaming, and session memory are in place
- web app now uses the chat streaming endpoint as an interactive ChatBI workbench with markdown chat rendering, SQL validation, query history/CSV export, dataset profiling, and chart recommendation panels with visual previews
- web app now supports English/Chinese interface switching and includes an in-app documentation page with usage tutorials, API calling examples, and workflow diagrams
- web workbench now includes an Access Check panel for tenant and role authorization decisions
- agent tools now include metadata search with Chinese/English business term expansion so natural-language questions like `订单中有多少记录` can discover `cda_orders` before running read-only SQL
- tool-system now supports named tool discovery and batch tool registration for built-in and future extension points, and the API now registers its built-in tools through that discovery flow
- metadata-engine now loads the Prisma schema catalog from `packages/database/prisma/schema.prisma`
- sql-agent now validates and generates SELECT SQL against the loaded schema catalog
- analysis-service now profiles JSON datasets with field statistics, data quality warnings, and time series trend/anomaly analysis
- chart-engine now recommends charts from dataset profiles, including time series, category comparisons, numeric distributions, outlier views, and large-series sampling hints
- security now blocks common prompt injection attempts in chat requests and emits audit logs for chat, SQL, metadata refresh, and access-check flows
- security now enforces role-aware SQL read permissions across SQL validation, SQL execution, SQL suggestion, and metadata-aware SQL agent tools
- Husky now installs a `pre-commit` hook that runs `pnpm verify`
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

Roadmap status:
- Phase 1 through Phase 5, Phase 8, and Phase 9 are implemented in the current TypeScript stack.
- Phase 7 is implemented for chart recommendation and large-dataset optimization; chart theme polish is still open.
- Phase 6 Python/FastAPI/Pandas remains a later migration target; the current analysis service is TypeScript-based.

Commands:
- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm verify`
- `pnpm dev`
- `start.md` contains the startup sequence

Environment:
- Local development now reads the root `.env` file automatically for the API server.
- `.env.example` is a template only; copy runtime secrets and overrides into the root `.env`.
- `OPENAI_API_KEY` enables `/api/chat` and `/api/chat/stream`
- `OPENAI_ENDPOINT` sets the compatible API base or full responses endpoint
- `OPENAI_MODEL` sets the default model for agent requests
- `OPENAI_TIMEOUT_MS` configures the OpenAI request timeout
- `AGENT_MAX_TOOL_CALLS` caps tool loops per turn
- `AGENT_MEMORY_LIMIT` controls in-memory session history size
- `AGENT_MEMORY_STORE_PATH` enables file-backed session history persistence across API restarts
- `SQL_ACCESS_DEFAULT_ROLE` sets the fallback SQL read role when an API caller or tool does not pass one explicitly
- `SQL_*_ALLOWED_TABLES` and `SQL_*_BLOCKED_COLUMNS` configure per-role SQL table and column permissions for `admin`, `analyst`, and `viewer`
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
- `.env.example` points at the local test PostgreSQL database on `127.0.0.1:5432`.
- Default local test connection: `postgresql://postgres:aa@127.0.0.1:5432/clusterdata`.
- `docker-compose.yml` provides a matching PostgreSQL service on `localhost:5432` with password `postgres`.
- Set `METADATA_SOURCE=postgres` to scan the live database schema.
- Set `METADATA_SOURCE=prisma` to use `packages/database/prisma/schema.prisma` as the metadata source.
- `POSTGRES_SCHEMA` selects the scanned PostgreSQL schema and defaults to `public`.

Metadata and SQL:
- `GET /api/overview` includes the loaded table, column, and relation counts plus relation edges, request guardrails, and the active SQL access policy summary.
- `GET /api/metadata/tables` lists the current runtime catalog tables and columns.
- `GET /api/metadata/tables/:tableName` returns one table and its relation edges.
- `GET /api/metadata/relations?tableName=Tenant` filters relation edges for a table.
- `GET /api/metadata/search?q=tenant&limit=5` searches table, column, and relation metadata.
- `POST /api/metadata/refresh` reloads the Prisma schema catalog and updates metadata-backed SQL tools.
- `POST /api/sql/validate` validates only bounded SELECT/WITH statements, rejects unknown tables, unknown columns, ambiguous unqualified columns, unsafe `SELECT INTO`, destructive SQL, checks alias/join references when metadata is available, and can apply role-aware SQL access decisions from an optional `role` request field.
- `POST /api/sql/query` validates a bounded read-only SQL statement, applies role-aware SQL read permissions, executes it inside a PostgreSQL read-only transaction, and returns rows plus column metadata.
- `POST /api/sql/suggest` generates a safe SELECT from known table and column names and blocks suggestions that would exceed the caller role's SQL access policy.
- `POST /api/analysis/series` summarizes a numeric series.
- `POST /api/analysis/time-series` analyzes time series cadence, moving averages, and anomalies from timestamp/value points.
- `POST /api/analysis/profile` profiles JSON rows, infers field kinds, computes numeric/category/date statistics, and reports missing, mixed, empty, and duplicate quality warnings.
- `POST /api/charts/suggest` accepts either legacy labels/values input or a dataset profile and returns chart recommendations.
- Large legacy chart payloads are automatically sampled for rendering, add zoom controls, and mark progressive rendering hints in the returned chart option metadata.
- The registered agent tools include `search-metadata`, `validate-sql`, `generate-sql`, `query-sql`, `summarize-series`, `analyze-time-series`, `profile-dataset`, `suggest-chart`, and `recommend-charts`.
- The agent prompt is bilingual and instructs Chinese/English data questions to use metadata and SQL tools for factual answers instead of guessing; common terms such as `订单`, `客户`, and `事件` are expanded to likely schema terms.
- Current catalog inference is in-process; use `POST /api/metadata/refresh` after changing the Prisma schema or live PostgreSQL schema.

Security guardrails:
- `GET /api/overview` exposes the active request security limits under `requestSecurity`.
- Chat requests are capped by `API_MAX_SESSION_ID_CHARS`, `API_MAX_CHAT_MESSAGE_CHARS`, and `API_MAX_MODEL_CHARS`.
- Chat requests now reject high-confidence prompt injection attempts such as instruction override, system prompt extraction, and guardrail bypass patterns before the agent is invoked.
- SQL validation and suggestion requests are capped by `API_MAX_SQL_CHARS`, `API_MAX_IDENTIFIER_CHARS`, and `API_MAX_SQL_SUGGEST_COLUMNS`.
- SQL read permissions are role-aware: by default `analyst` can read all tables, `viewer` is limited to `Tenant`, and `viewer` cannot read `Tenant.createdAt` unless the `SQL_*` environment overrides are changed.
- Series, dataset, and chart requests are capped by `API_MAX_SERIES_POINTS`, `API_MAX_DATASET_ROWS`, `API_MAX_DATASET_FIELDS`, `API_MAX_DATASET_CELL_CHARS`, `API_MAX_CHART_DATA_POINTS`, and `API_MAX_CHART_RECOMMENDATIONS`.
- Metadata search is capped by `API_MAX_METADATA_SEARCH_CHARS` and `API_MAX_METADATA_SEARCH_LIMIT`.
- `/api/security/check` now validates role and action values explicitly before making an access decision.
- Security audit logs are emitted with the `security.audit` scope for `/api/chat`, `/api/chat/stream`, `/api/sql/validate`, `/api/sql/query`, `/api/metadata/refresh`, and `/api/security/check`.
- The web workbench includes an Access Check panel that calls `/api/security/check` and shows allow/deny decisions with policy reasons.

SQL examples:
- List metadata:
  - `curl http://127.0.0.1:3001/api/metadata/tables`
- Search metadata:
  - `curl "http://127.0.0.1:3001/api/metadata/search?q=tenant&limit=5"`
- Validate:
  - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 20\"}"`
- Validate as a viewer role:
  - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select createdAt from Tenant limit 1\",\"role\":\"viewer\"}"`
- Validate a join with aliases:
  - `curl -X POST http://127.0.0.1:3001/api/sql/validate -H "content-type: application/json" -d "{\"sql\":\"select o.id, c.name from cda_orders o join cda_customers c on o.customer_id = c.id limit 20\"}"`
- Suggest:
  - `curl -X POST http://127.0.0.1:3001/api/sql/suggest -H "content-type: application/json" -d "{\"tableName\":\"AuditLog\",\"columns\":[\"id\",\"tenantId\",\"action\"],\"limit\":25}"`
- Query:
  - `curl -X POST http://127.0.0.1:3001/api/sql/query -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 20\"}"`

Analysis examples:
- Summarize a numeric series:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/series -H "content-type: application/json" -d "{\"points\":[1,2,3,4]}"`
- Analyze a time series:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/time-series -H "content-type: application/json" -d "{\"points\":[{\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-02T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-03T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-04T00:00:00.000Z\",\"value\":10}],\"movingAverageWindow\":2,\"anomalyThreshold\":1.5}"`
- Profile JSON rows:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\"rows\":[{\"region\":\"north\",\"amount\":10,\"active\":true},{\"region\":\"south\",\"amount\":20,\"active\":false},{\"region\":\"north\",\"amount\":30,\"active\":true}]}"`
- Time series analysis sorts points by timestamp, summarizes the numeric trend, infers cadence regularity, computes trailing moving averages, and flags z-score anomalies.

Chart examples:
- Legacy chart suggestion:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"title\":\"Revenue\",\"labels\":[\"Jan\",\"Feb\"],\"values\":[10,20],\"hasTimeAxis\":false}"`
- Profile-aware chart recommendations:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"profile\":{\"rowCount\":3,\"fieldCount\":3,\"fields\":[{\"name\":\"createdAt\",\"kind\":\"date\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[\"2026-01-01T00:00:00.000Z\"],\"minimum\":\"2026-01-01T00:00:00.000Z\",\"maximum\":\"2026-01-03T00:00:00.000Z\"},{\"name\":\"revenue\",\"kind\":\"number\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[10,20,30],\"minimum\":10,\"maximum\":30,\"average\":20,\"median\":20,\"standardDeviation\":8.16,\"outliers\":[]},{\"name\":\"region\",\"kind\":\"string\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":2,\"examples\":[\"north\",\"south\"],\"topValues\":[{\"value\":\"north\",\"count\":2},{\"value\":\"south\",\"count\":1}]}],\"quality\":{\"emptyFieldCount\":0,\"highMissingFieldCount\":0,\"mixedFieldCount\":0,\"duplicateRowCount\":0,\"warnings\":[]}},\"maxRecommendations\":3}"`
- Large time-series and category payloads are down-sampled before rendering; pie charts collapse long tails into `Other`, and line/bar options expose optimization metadata under `option.meta`.

Web workbench:
- Open `http://127.0.0.1:3000`.
- Use the language selector in the header to switch between English and Chinese.
- Use the Workbench and Docs tabs to switch between the interactive ChatBI workspace and the in-app usage documentation.
- Use the Conversation panel for streaming agent chat.
- Assistant messages render markdown for headings, lists, code blocks, and links.
- Use SQL Guardrail to choose `admin`, `analyst`, or `viewer`, then validate metadata-aware SQL with the intended read policy.
- Successful SQL runs are stored in browser-local history, can be replayed into the editor, and can be exported as CSV.
- Use SQL Guardrail to validate and execute read-only SQL with the selected role, then inspect the returned rows.
- Use Access Check to verify tenant isolation and role/action authorization decisions.
- Use Dataset Profile with JSON rows, then Chart Recommendations to get profile-aware chart suggestions.
- Chart recommendations render inline previews from the profiled dataset rows instead of showing recommendation text alone.
- Inline previews also sample large row sets so the workbench stays responsive when chart inputs grow.

Documentation page:
- The Docs tab includes a usage tutorial for the workbench flow.
- The API calling tutorial includes curl examples for health checks, SQL validation, dataset profiling, and streaming chat.
- The workflow section shows the ChatBI request path and includes Mermaid flowchart source for architecture documentation.

PostgreSQL test schema:
- The development scanner was verified against `127.0.0.1:5432/clusterdata` using test tables `cda_customers`, `cda_orders`, and `cda_order_events`.
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
  - OpenAI-compatible upstream SSE text deltas are forwarded as they arrive; non-streaming transports fall back to chunked completed text so local tests and mocks keep working.

Notes:
- Agent memory uses the configured `AGENT_MEMORY_LIMIT` cap for each session.
- Set `AGENT_MEMORY_STORE_PATH` to persist session history to a local JSON file across API restarts.
- Without `AGENT_MEMORY_STORE_PATH`, agent memory stays in-process and is cleared when the API restarts.
- `OPENAI_ENDPOINT` accepts either a base URL like `https://openrouter.ai/api/v1` or a full endpoint like `https://openrouter.ai/api/v1/responses`.
- `pnpm install` runs the root `prepare` script so Husky can refresh Git hooks locally.
- `pnpm verify` is the shared repository gate used by the Husky `pre-commit` hook.
- The Python `analysis-service` roadmap item is still a later phase; current analysis remains TypeScript-based.
