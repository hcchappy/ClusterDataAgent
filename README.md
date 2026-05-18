# ClusterDataAgent

Monorepo status:
- workspace scaffolded
- API, web app, and core domain packages are in place
- agent-core chat, native upstream SSE streaming, cancel propagation, and session memory are in place
- web app now uses the chat streaming endpoint as an interactive ChatBI workbench with markdown chat rendering, SQL validation, query history/CSV export, dataset profiling, and chart recommendation panels with visual previews
- web app streaming chat now supports an in-flight Stop action that aborts upstream work while preserving partial output
- web app now supports English/Chinese interface switching and includes an in-app documentation page with detailed usage manuals, API calling examples, and an optimized workflow diagram
- web workbench now includes an Access Check panel for tenant and role authorization decisions
- agent session storage now persists structured `version: 2` session records with `createdAt`, `updatedAt`, and full message history, while auto-upgrading legacy `version: 1` files on load
- web workbench now includes Session Admin and Runtime Ops panels for loading, retitling, tagging, forking, resuming, deleting, and clearing stored agent sessions plus viewing request/chat runtime telemetry with an operator API key
- analysis-agent execution now records in-memory turn traces, tool-call traces, aggregate observability metrics, and operator-triggered evaluation suite reports for regression checks
- tool governance now supports environment-driven allow/block lists and summarizes active governance settings in the API overview and web workbench
- API failures now return a structured error envelope with top-level `message`/`code` plus nested error metadata including `statusCode` and `requestId`
- SQL query execution now supports async background jobs, in-memory result caching, and server-backed pagination; the web workbench polls async SQL jobs, browses cached pages, and still supports collapsible large cells plus CSV export
- API operator, chat, and SQL endpoints now enforce in-memory rate limits with `retry-after` hints and redact operator/auth headers from Fastify logs
- metadata-engine now builds curated catalog insights for the workbench, including top tables, data-type mix, relation hotspots, and starter SQL snippets
- metadata-engine now also loads a semantic catalog with business-ready models, dimensions, metric ownership metadata, synonym search, curated metric SQL generation, and metadata-derived fallback semantics for injected catalogs
- agent tools now include metadata search with Chinese/English business term expansion so natural-language questions like `订单中有多少记录` can discover `cda_orders` before running read-only SQL
- agent tools now also include semantic metric discovery plus semantic SQL/query execution so KPI questions can resolve through `search-semantics`, `generate-metric-sql`, and `query-metric`
- tool-system now supports named tool discovery and batch tool registration for built-in and future extension points, and the API now registers its built-in tools through that discovery flow
- metadata-engine now loads the Prisma schema catalog from `packages/database/prisma/schema.prisma`
- sql-agent now validates and generates SELECT SQL against the loaded schema catalog
- analysis-service now profiles JSON datasets with field statistics, data quality warnings, and time series trend/anomaly analysis
- analysis-service now also generates reusable dataset insight cards for quality, trend, breakdown, and correlation analysis
- chart-engine now recommends charts from dataset profiles, including time series, category comparisons, numeric distributions, outlier views, and large-series sampling hints
- chart-engine now applies polished dark and light ECharts themes across titles, axes, legends, tooltips, zoom controls, and web previews
- security now blocks common prompt injection attempts in chat requests and emits audit logs for operator session admin, chat, SQL, metadata refresh, and access-check flows
- security now enforces role-aware SQL read permissions across SQL validation, SQL execution, SQL suggestion, and metadata-aware SQL agent tools
- web workbench now includes Metadata Explorer and Analysis Insights panels so operators can pivot from schema exploration to dataset interpretation without leaving the console
- Turbo task outputs now match the current no-emit TypeScript packages while caching the web app's `dist` build output without missing-output warnings
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
- Phase 7 is implemented for chart recommendation, large-dataset optimization, and dark/light chart theme polish.
- Phase 6 Python/FastAPI/Pandas remains a later migration target; the current analysis service is TypeScript-based.

Commands:
- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm verify`
- `pnpm dev`
- Root workspace commands now invoke `turbo` through `pnpm exec ... --ui=stream` so non-interactive shells and CI-style runs exit cleanly with package logs streamed to stdout.
- `start.md` contains the startup sequence

Environment:
- Local development now reads the root `.env` file automatically for the API server.
- `.env.example` is a template only; copy runtime secrets and overrides into the root `.env`.
- Prisma CLI commands in `packages/database` use `packages/database/prisma.config.ts`, which reads `DATABASE_URL` for Prisma 7 validation and generation and falls back to the documented local test database URL.
- `OPENAI_API_KEY` enables `/api/chat` and `/api/chat/stream`
- `OPENAI_ENDPOINT` sets the compatible API base or full responses endpoint
- `OPENAI_MODEL` sets the default model for agent requests
- `OPENAI_TIMEOUT_MS` configures the OpenAI request timeout
- `SEMANTIC_CATALOG_PATH` optionally points at a semantic catalog JSON file; when omitted, Prisma mode defaults to `packages/database/semantic/catalog.json`, PostgreSQL mode defaults to `packages/database/semantic/postgres-catalog.json`, and injected metadata catalogs fall back to generated row-count semantics
- `AGENT_MAX_TOOL_CALLS` caps tool loops per turn
- `AGENT_ALLOWED_TOOLS` optionally restricts the registered built-in tools to an allowlist
- `AGENT_BLOCKED_TOOLS` removes named built-in tools from registration
- `AGENT_MAX_TOOL_RESULT_CHARS` caps the size of tool output returned to the model context; large query results are summarized before they are fed back into the agent loop
- `AGENT_MEMORY_LIMIT` controls in-memory session history size
- `AGENT_MEMORY_STORE_PATH` enables file-backed session history persistence across API restarts and allows runtime session inspection/cleanup to survive API restarts; the persisted JSON format is `version: 2` with per-session `createdAt`, `updatedAt`, `messages`, and optional session metadata (`title`, `tags`, `forkedFromSessionId`)
- `OPERATOR_API_KEY` enables the operator session administration endpoints and is required through the `x-operator-api-key` request header
- `SQL_ACCESS_DEFAULT_ROLE` sets the fallback SQL read role when an API caller or tool does not pass one explicitly
- `SQL_*_ALLOWED_TABLES` and `SQL_*_BLOCKED_COLUMNS` configure per-role SQL table and column permissions for `admin`, `analyst`, and `viewer`
- `SQL_QUERY_CACHE_TTL_MS` and `SQL_QUERY_CACHE_MAX_ENTRIES` control the in-memory SQL result cache used by synchronous paging and async query follow-up fetches
- `SQL_ASYNC_JOB_TTL_MS` and `SQL_ASYNC_JOB_MAX_ENTRIES` control how long async SQL job records stay queryable and how many completed/running jobs are retained in memory
- API request guardrails are configurable with `API_MAX_*` environment variables for session ids/titles/tags, chat text, SQL text, metadata search, dataset profiling, chart inputs, and generated SQL column counts
- API rate limits are configurable with `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX_CHAT_REQUESTS`, `API_RATE_LIMIT_MAX_OPERATOR_REQUESTS`, and `API_RATE_LIMIT_MAX_SQL_REQUESTS`

Apps:
- API: `apps/api`
- Web: `apps/web`
  - Streams chat from `/api/chat/stream`
  - Explores curated schema insights through `/api/metadata/insights` and `/api/metadata/search`
  - Validates SQL through `/api/sql/validate`
  - Profiles JSON rows through `/api/analysis/profile`
  - Generates dataset insight cards through `/api/analysis/insights`
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
- The default semantic catalogs live at `packages/database/semantic/catalog.json` for the Prisma demo schema and `packages/database/semantic/postgres-catalog.json` for the reusable PostgreSQL fixture.
- `POSTGRES_SCHEMA` selects the scanned PostgreSQL schema and defaults to `public`.

Metadata and SQL:
- `GET /api/overview` includes the loaded table, column, and relation counts plus relation edges, semantic model/metric counts, request guardrails, the active SQL access policy summary, and the current agent session count.
- `GET /api/overview` also reports `toolGovernance.allowedTools`, `toolGovernance.blockedTools`, `toolGovernance.maxToolResultChars`, and the public `runtime` request/stream snapshot.
- `GET /health/ready` returns readiness checks for metadata, semantic catalog loading, session storage, tool registration, chat configuration, database query support, and public runtime counters.
- `GET /api/agent/sessions` lists the stored agent session ids, `createdAt`, `updatedAt`, message counts, optional `title`/`tags`/`forkedFromSessionId`, and latest message previews.
- `GET /api/agent/sessions/:sessionId` returns the full stored message history plus `createdAt`, `updatedAt`, `messageCount`, optional session metadata, and `lastMessage` for one agent session.
- `PATCH /api/agent/sessions/:sessionId` updates the stored session `title` and `tags`.
- `POST /api/agent/sessions/:sessionId/fork` clones a stored session into a new branch session, copies its history, and records `forkedFromSessionId`.
- `DELETE /api/agent/sessions/:sessionId` removes one stored agent session.
- `DELETE /api/agent/sessions` clears all stored agent sessions and returns the deleted session count.
- `GET /api/ops/runtime` returns operator-only runtime telemetry including status counts, chat stream lifecycle counts, route request hotspots, session count, and tool metrics.
- `GET /api/ops/analysis-agent` returns operator-only analysis-agent observability including recent turn traces, active turn state, per-tool agent metrics, and the latest evaluation report if one has been run.
- `POST /api/ops/analysis-agent/evals` runs an operator-only analysis-agent evaluation suite against the current executor, returns per-case pass/fail checks, and stores the latest report in memory for later inspection.
- Operator session endpoints return `503 OPERATOR_API_KEY_NOT_CONFIGURED` until `OPERATOR_API_KEY` is set, then require `x-operator-api-key`.
- `GET /api/metadata/tables` lists the current runtime catalog tables and columns.
- `GET /api/metadata/tables/:tableName` returns one table and its relation edges.
- `GET /api/metadata/relations?tableName=Tenant` filters relation edges for a table.
- `GET /api/metadata/insights?limit=8` returns curated top tables, data-type counts, relation hotspots, and starter SQL snippets for the workbench metadata explorer.
- `GET /api/metadata/search?q=tenant&limit=5` searches table, column, and relation metadata.
- `POST /api/metadata/refresh` reloads the Prisma schema catalog and updates metadata-backed SQL tools.
- `GET /api/semantic/catalog` returns the loaded semantic models, dimensions, metrics, and semantic summary counts.
- `GET /api/semantic/insights?modelLimit=6&metricLimit=10` returns curated semantic models, metrics, and owner summaries for a semantic explorer.
- `GET /api/semantic/search?q=tenant%20count&limit=5` searches semantic models, dimensions, and metrics by label, id, description, and synonyms.
- `POST /api/semantic/sql` builds a semantic metric query into safe SQL with grouping dimensions, optional time grain, and validated filters.
- `POST /api/semantic/query` generates semantic SQL, applies SQL role access policy, executes the query, and returns rows plus validation metadata.
- `POST /api/sql/validate` validates only bounded SELECT/WITH statements, rejects unknown tables, unknown columns, ambiguous unqualified columns, unsafe `SELECT INTO`, destructive SQL, checks alias/join references when metadata is available, and can apply role-aware SQL access decisions from an optional `role` request field.
- `POST /api/sql/query` validates a bounded read-only SQL statement, applies role-aware SQL read permissions, executes it inside a PostgreSQL read-only transaction or serves it from the in-memory query cache, and returns paged rows plus column metadata, validation metadata, `page`, and `cache`.
- `POST /api/sql/query/async` validates and starts a background SQL query job, immediately returning a `jobId`; cache hits can complete the job immediately without another database round-trip.
- `GET /api/sql/query/jobs/:jobId` returns async SQL query job status, expiry, cache key, and completion summary once the background job finishes.
- `GET /api/sql/query/jobs/:jobId/result?offset=0&pageLimit=50` returns one paged slice of a completed async SQL query result.
- `POST /api/sql/suggest` generates a safe SELECT from known table and column names and blocks suggestions that would exceed the caller role's SQL access policy.
- `POST /api/analysis/series` summarizes a numeric series.
- `POST /api/analysis/time-series` analyzes time series cadence, moving averages, and anomalies from timestamp/value points.
- `POST /api/analysis/profile` profiles JSON rows, infers field kinds, computes numeric/category/date statistics, and reports missing, mixed, empty, and duplicate quality warnings.
- `POST /api/analysis/insights` profiles JSON rows and returns prioritized insight cards for quality watchouts, trends, breakdowns, and correlations.
- `POST /api/charts/suggest` accepts either legacy labels/values input or a dataset profile and returns chart recommendations; pass optional `theme: "dark" | "light"` to style generated chart options.
- Large legacy chart payloads are automatically sampled for rendering, add zoom controls, and mark progressive rendering hints in the returned chart option metadata.
- The registered agent tools include `search-metadata`, `search-semantics`, `generate-metric-sql`, `query-metric`, `validate-sql`, `generate-sql`, `query-sql`, `summarize-series`, `analyze-time-series`, `profile-dataset`, `suggest-chart`, and `recommend-charts`.
- The agent prompt is bilingual and instructs Chinese/English data questions to use metadata and SQL tools for factual answers instead of guessing; common terms such as `订单`, `客户`, and `事件` are expanded to likely schema terms.
- Current catalog inference is in-process; use `POST /api/metadata/refresh` after changing the Prisma schema or live PostgreSQL schema.

Security guardrails:
- `GET /api/overview` exposes the active request security limits under `requestSecurity`.
- Session metadata updates are capped by `API_MAX_SESSION_ID_CHARS`, `API_MAX_SESSION_TITLE_CHARS`, `API_MAX_SESSION_TAGS`, and `API_MAX_SESSION_TAG_CHARS`.
- Chat requests are capped by `API_MAX_SESSION_ID_CHARS`, `API_MAX_CHAT_MESSAGE_CHARS`, and `API_MAX_MODEL_CHARS`.
- Chat requests now reject high-confidence prompt injection attempts such as instruction override, system prompt extraction, and guardrail bypass patterns before the agent is invoked.
- SQL validation and suggestion requests are capped by `API_MAX_SQL_CHARS`, `API_MAX_IDENTIFIER_CHARS`, and `API_MAX_SQL_SUGGEST_COLUMNS`.
- SQL read permissions are role-aware: by default `analyst` can read all tables, `viewer` is limited to `Tenant`, and `viewer` cannot read `Tenant.createdAt` unless the `SQL_*` environment overrides are changed.
- Series, dataset, and chart requests are capped by `API_MAX_SERIES_POINTS`, `API_MAX_DATASET_ROWS`, `API_MAX_DATASET_FIELDS`, `API_MAX_DATASET_CELL_CHARS`, `API_MAX_CHART_DATA_POINTS`, and `API_MAX_CHART_RECOMMENDATIONS`.
- Metadata search is capped by `API_MAX_METADATA_SEARCH_CHARS` and `API_MAX_METADATA_SEARCH_LIMIT`.
- Chat, operator, and SQL endpoints are rate-limited in-memory per requester window and return `429` plus `retry-after` when callers exceed the configured bucket.
- `/api/security/check` now validates role and action values explicitly before making an access decision.
- Security audit logs are emitted with the `security.audit` scope for `/api/agent/sessions`, `/api/agent/sessions/:sessionId`, `/api/chat`, `/api/chat/stream`, `/api/sql/validate`, `/api/sql/query`, `/api/metadata/refresh`, and `/api/security/check`.
- Fastify logging now redacts `authorization`, `cookie`, and `x-operator-api-key`, and operator API key checks use constant-time comparison.
- The web workbench includes an Access Check panel that calls `/api/security/check` and shows allow/deny decisions with policy reasons.

SQL examples:
- List metadata:
  - `curl http://127.0.0.1:3001/api/metadata/tables`
- Search metadata:
  - `curl "http://127.0.0.1:3001/api/metadata/search?q=tenant&limit=5"`
- Search semantics:
  - `curl "http://127.0.0.1:3001/api/semantic/search?q=tenant%20count&limit=5"`
- Load semantic insights:
  - `curl "http://127.0.0.1:3001/api/semantic/insights?modelLimit=4&metricLimit=6"`
- Generate semantic SQL:
  - `curl -X POST http://127.0.0.1:3001/api/semantic/sql -H "content-type: application/json" -d "{\"metricIds\":[\"tenant_count\"],\"dimensionIds\":[\"tenant.name\"],\"limit\":10}"`
- Execute a semantic query:
  - `curl -X POST http://127.0.0.1:3001/api/semantic/query -H "content-type: application/json" -d "{\"metricIds\":[\"audit_log_count\"],\"dimensionIds\":[\"auditLog.action\"],\"timeGrain\":\"day\",\"limit\":30}"`
- Load metadata insights:
  - `curl "http://127.0.0.1:3001/api/metadata/insights?limit=6"`
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
- Query with pagination:
  - `curl -X POST http://127.0.0.1:3001/api/sql/query -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 200\",\"offset\":50,\"pageLimit\":50}"`
- Start async query:
  - `curl -X POST http://127.0.0.1:3001/api/sql/query/async -H "content-type: application/json" -d "{\"sql\":\"select id, name from Tenant limit 200\"}"`
- Poll async query status:
  - `curl http://127.0.0.1:3001/api/sql/query/jobs/<jobId>`
- Read async query result page:
  - `curl "http://127.0.0.1:3001/api/sql/query/jobs/<jobId>/result?offset=0&pageLimit=50"`
- Inspect analysis-agent observability:
  - `curl http://127.0.0.1:3001/api/ops/analysis-agent -H "x-operator-api-key: <operator-key>"`
- Run the default analysis-agent evaluation suite:
  - `curl -X POST http://127.0.0.1:3001/api/ops/analysis-agent/evals -H "x-operator-api-key: <operator-key>" -H "content-type: application/json" -d "{}"`

Analysis examples:
- Summarize a numeric series:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/series -H "content-type: application/json" -d "{\"points\":[1,2,3,4]}"`
- Analyze a time series:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/time-series -H "content-type: application/json" -d "{\"points\":[{\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-02T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-03T00:00:00.000Z\",\"value\":1},{\"timestamp\":\"2026-01-04T00:00:00.000Z\",\"value\":10}],\"movingAverageWindow\":2,\"anomalyThreshold\":1.5}"`
- Profile JSON rows:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/profile -H "content-type: application/json" -d "{\"rows\":[{\"region\":\"north\",\"amount\":10,\"active\":true},{\"region\":\"south\",\"amount\":20,\"active\":false},{\"region\":\"north\",\"amount\":30,\"active\":true}]}"`
- Generate dataset insights:
  - `curl -X POST http://127.0.0.1:3001/api/analysis/insights -H "content-type: application/json" -d "{\"rows\":[{\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"revenue\":10,\"cost\":5,\"region\":\"north\"},{\"createdAt\":\"2026-01-02T00:00:00.000Z\",\"revenue\":20,\"cost\":10,\"region\":\"north\"},{\"createdAt\":\"2026-01-03T00:00:00.000Z\",\"revenue\":40,\"cost\":20,\"region\":\"south\"}]}"`
- Time series analysis sorts points by timestamp, summarizes the numeric trend, infers cadence regularity, computes trailing moving averages, and flags z-score anomalies.

Chart examples:
- Legacy chart suggestion:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"title\":\"Revenue\",\"labels\":[\"Jan\",\"Feb\"],\"values\":[10,20],\"hasTimeAxis\":false}"`
- Profile-aware chart recommendations:
  - `curl -X POST http://127.0.0.1:3001/api/charts/suggest -H "content-type: application/json" -d "{\"profile\":{\"rowCount\":3,\"fieldCount\":3,\"fields\":[{\"name\":\"createdAt\",\"kind\":\"date\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[\"2026-01-01T00:00:00.000Z\"],\"minimum\":\"2026-01-01T00:00:00.000Z\",\"maximum\":\"2026-01-03T00:00:00.000Z\"},{\"name\":\"revenue\",\"kind\":\"number\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":3,\"examples\":[10,20,30],\"minimum\":10,\"maximum\":30,\"average\":20,\"median\":20,\"standardDeviation\":8.16,\"outliers\":[]},{\"name\":\"region\",\"kind\":\"string\",\"count\":3,\"missingCount\":0,\"missingRatio\":0,\"distinctCount\":2,\"examples\":[\"north\",\"south\"],\"topValues\":[{\"value\":\"north\",\"count\":2},{\"value\":\"south\",\"count\":1}]}],\"quality\":{\"emptyFieldCount\":0,\"highMissingFieldCount\":0,\"mixedFieldCount\":0,\"duplicateRowCount\":0,\"warnings\":[]}},\"maxRecommendations\":3}"`
- Large time-series and category payloads are down-sampled before rendering; pie charts collapse long tails into `Other`, and line/bar options expose optimization metadata under `option.meta`.
- Chart options include theme-aware backgrounds, palettes, title text, axes, split lines, tooltips, legends, zoom sliders, and optimization metadata under `option.meta.theme`.

Web workbench:
- Open `http://127.0.0.1:3000`.
- Keep the API running at `http://127.0.0.1:3001`; the Agent Overview panel loads `/api/overview` and now shows an explicit failure message instead of an endless loading state when that API is unreachable.
- The web client reads `VITE_API_BASE_URL` first and then `WEB_API_BASE_URL`; set either value to `http://127.0.0.1:3001` for a direct API URL.
- The web dev server uses a strict `3000` port so it will fail fast instead of drifting onto the API port when `3000` is already occupied.
- The Vite dev proxy is opt-in. Set `WEB_ENABLE_API_PROXY=true` and optionally `WEB_API_PROXY_TARGET=http://127.0.0.1:3001` only when you intentionally want same-origin `/api` forwarding.
- Restart the web dev server after changing API base URL or proxy settings.
- Use the language selector in the header to switch between English and Chinese.
- Use the Workbench and Docs tabs to switch between the interactive ChatBI workspace and the in-app usage documentation.
- Use the Conversation panel for streaming agent chat.
- Use the Send/Stop primary action to cancel a live stream; canceling aborts upstream agent work and preserves any partial assistant text already shown.
- Assistant messages render markdown for headings, lists, code blocks, and links.
- Use SQL Guardrail to choose `admin`, `analyst`, or `viewer`, then validate metadata-aware SQL with the intended read policy.
- Use Metadata Explorer to browse top tables, data types, and relation hotspots, search schema terms, then send starter SQL directly into SQL Guardrail.
- Successful SQL runs are stored in browser-local history, can be replayed into the editor, and can be exported as CSV.
- Use SQL Guardrail to validate and execute read-only SQL with the selected role; the workbench now starts SQL runs asynchronously, polls the job, and reads result pages from the cached query output.
- Use Access Check to verify tenant isolation and role/action authorization decisions.
- Use Dataset Profile with JSON rows to generate both field statistics and Analysis Insights cards before asking for chart recommendations.
- Analysis Insights highlights quality watchouts, trends, category breakdowns, and correlations so chart selection starts from actual dataset signals.
- Use the Chart Theme selector to preview recommendations in polished dark or light styling.
- Chart recommendations render inline previews from the profiled dataset rows instead of showing recommendation text alone.
- Inline previews also sample large row sets so the workbench stays responsive when chart inputs grow.
- Use Session Admin to paste the `OPERATOR_API_KEY`, inspect session metadata limits, load stored sessions, save session titles/tags, fork a session into a parallel branch, continue an existing session in the main conversation panel, or delete/clear persisted sessions.
- Use Runtime Ops to load operator telemetry for uptime, request totals, rate-limited counts, chat stream lifecycle counts, and the busiest API routes.
- New drafts generate a fresh browser session id immediately, and loading a stored session replaces the visible chat transcript with the persisted conversation.
- Use Tool Governance in the right sidebar to inspect the currently allowed tools, blocked tools, and model-side tool result size cap.
- If `/api/overview` is unavailable, Agent Overview, Tool Governance, and Workspace Signals now show an explicit failure state instead of staying in a loading loop.
- Large SQL result sets are shown as a server-backed preview table with page controls and collapsible large cells; export transparently reloads the full cached result before writing CSV when the visible page is only a slice.

Documentation page:
- The Docs tab includes a usage tutorial for the workbench flow.
- The detailed manual covers Conversation, SQL Guardrail, Dataset Profile, Chart Recommendations, and Access Check workflows.
- The API calling tutorial includes curl examples for health checks, SQL validation, SQL execution, dataset profiling, chart recommendations, access checks, and streaming chat.
- The workflow section shows an optimized visual ChatBI request map and includes Mermaid flowchart source for architecture documentation.

PostgreSQL test schema:
- The development scanner was verified against `127.0.0.1:5432/clusterdata` using test tables `cda_customers`, `cda_orders`, and `cda_order_events`.
- The reusable fixture is `packages/database/prisma/postgres-test-schema.sql`.
- Prisma CLI configuration lives in `packages/database/prisma.config.ts`; it uses `DATABASE_URL` when set and otherwise falls back to `postgresql://postgres:aa@127.0.0.1:5432/clusterdata`. Run `pnpm db:validate` after changing the Prisma schema or database package config.
- The fixture resets and reseeds the `cda_*` demo tables with 8 customers, 80 orders, and lifecycle events for created, paid, pending-review, and refunded orders.
- `cda_orders` is generated as 20 consecutive daily buckets from `2026-04-25` through `2026-05-14`, with exactly 4 orders per day for chart, profiling, and SQL trend demos.
- Apply the fixture with `psql "postgresql://postgres:aa@127.0.0.1:5432/clusterdata" -f packages/database/prisma/postgres-test-schema.sql`.
- Quick fixture checks:
  - `select count(*) from cda_orders;`
  - `select created_at::date as order_date, count(*) from cda_orders group by order_date order by order_date;`
  - `select status, channel, count(*) from cda_orders group by status, channel order by status, channel;`
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
  - Closing the client connection, or pressing Stop in the web workbench, aborts upstream OpenAI and tool work.
- `GET /api/agent/sessions`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - response: `{ "ok": true, "sessions": [{ "sessionId": "demo", "createdAt": "...", "updatedAt": "...", "messageCount": 2, "title": "Revenue Review", "tags": ["finance"], "forkedFromSessionId": "source-demo", "lastMessage": { "role": "assistant", "content": "..." } }] }`
- `GET /api/agent/sessions/:sessionId`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - response: `{ "ok": true, "session": { "sessionId": "demo", "createdAt": "...", "updatedAt": "...", "messageCount": 2, "title": "Revenue Review", "tags": ["finance"], "forkedFromSessionId": "source-demo", "lastMessage": { "role": "assistant", "content": "..." }, "messages": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }] } }`
- `PATCH /api/agent/sessions/:sessionId`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - request: `{ "title": "Revenue Review", "tags": ["finance", "q2"] }`
  - response: `{ "ok": true, "session": { "sessionId": "demo", "title": "Revenue Review", "tags": ["finance", "q2"] } }`
- `POST /api/agent/sessions/:sessionId/fork`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - request: `{ "sessionId": "demo-branch", "title": "Revenue Review Branch", "tags": ["finance", "branch"] }`
  - response: `{ "ok": true, "sourceSessionId": "demo", "session": { "sessionId": "demo-branch", "forkedFromSessionId": "demo" } }`
- `DELETE /api/agent/sessions/:sessionId`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - response: `{ "ok": true, "sessionId": "demo", "deleted": true }`
- `DELETE /api/agent/sessions`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - response: `{ "ok": true, "deletedCount": 3 }`
- `GET /api/ops/runtime`
  - requires header: `x-operator-api-key: <OPERATOR_API_KEY>`
  - response: `{ "ok": true, "runtime": { "startedAt": "...", "uptimeMs": 240000, "activeRequests": 1, "activeChatStreams": 0, "totalRequests": 12, "rateLimitedRequests": 1, "statusCounts": { "success": 10, "clientError": 1, "serverError": 1 }, "chatStreams": { "started": 4, "completed": 3, "aborted": 1, "failed": 0 }, "routes": [{ "route": "/api/chat/stream", "requests": 4 }] }, "sessionCount": 2, "toolCount": 9, "toolMetrics": {} }`

Notes:
- Agent memory uses the configured `AGENT_MEMORY_LIMIT` cap for each session.
- Set `AGENT_MEMORY_STORE_PATH` to persist session history to a local JSON file across API restarts.
- Existing `version: 1` session-store files are upgraded in place to `version: 2` the next time the API loads them.
- Structured API errors use the shape `{ ok: false, message, code, error: { message, code, statusCode, details?, requestId? } }`.
- Streaming chat requests now surface the same structured API errors as JSON endpoints when the server rejects the stream before SSE begins.
- Large `query-sql` tool outputs are summarized before they are returned to the model so the agent can reason over row counts, columns, validation, and preview rows without overflowing context.
- Without `AGENT_MEMORY_STORE_PATH`, agent memory stays in-process and is cleared when the API restarts.
- `OPENAI_ENDPOINT` accepts either a base URL like `https://openrouter.ai/api/v1` or a full endpoint like `https://openrouter.ai/api/v1/responses`.
- `pnpm install` runs the root `prepare` script so Husky can refresh Git hooks locally.
- `pnpm verify` is the shared repository gate used by the Husky `pre-commit` hook.
- The Python `analysis-service` roadmap item is still a later phase; current analysis remains TypeScript-based.
