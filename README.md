# ClusterDataAgent

Monorepo status:
- workspace scaffolded
- API, web app, and core domain packages are in place
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

Apps:
- API: `apps/api`
- Web: `apps/web`

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
- `docker-compose.yml` starts PostgreSQL on `localhost:5432`
- `.env.example` contains the default `DATABASE_URL`

Prompt files:
- `.codex/prompts/SYSTEM_PROMPT.md`
- `.codex/prompts/AUTONOMOUS_OVERNIGHT_PROMPT.md`
- `.codex/prompts/ROADMAP.md`
