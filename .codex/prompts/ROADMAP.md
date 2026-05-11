# ClusterDataAgent - Harness Engineering Roadmap

当前激活阶段：`阶段 1 / monorepo`

## 阶段 1：初始化 Monorepo

目标：
- pnpm workspace
- turbo
- TypeScript
- Fastify
- React
- Prisma
- PostgreSQL
- Docker
- ESLint
- Prettier
- Husky

完成标志：
- workspace 可以安装和执行
- 至少一个后端包和一个前端包可以启动
- lint、typecheck、test 有统一入口

建议提交：

```bash
git add .
git commit -m "chore: initialize ClusterDataAgent monorepo"
```

---

## 阶段 2：Agent Core

目标：
- OpenAI Responses API
- Tool Calling
- Streaming
- Memory
- Retry
- AbortController

建议提交：

```bash
git commit -m "feat(agent-core): implement agent execution loop"
```

---

## 阶段 3：Tool System

目标：
- Tool Registry
- Tool Discovery
- Tool Hooks
- Metrics
- Timeout
- Retry

建议提交：

```bash
git commit -m "feat(tool-system): implement tool registry and execution pipeline"
```

---

## 阶段 4：Metadata Engine

目标：
- PostgreSQL schema scanner
- Metadata cache
- Relation analysis
- Full text search

建议提交：

```bash
git commit -m "feat(metadata-engine): implement postgres metadata scanner"
```

---

## 阶段 5：SQL Agent

目标：
- Metadata-aware SQL generation
- SQL validation
- SQL sandbox
- AST parser
- Dangerous SQL prevention

建议提交：

```bash
git commit -m "feat(sql-agent): implement secure sql generation pipeline"
```

---

## 阶段 6：Python Analysis Service

目标：
- FastAPI
- Pandas
- Trend analysis
- Anomaly detection
- Time series analysis

建议提交：

```bash
git commit -m "feat(analysis-service): implement data analysis service"
```

---

## 阶段 7：Chart Engine

目标：
- ECharts option generator
- Smart chart selection
- Dark mode
- Large dataset optimization

建议提交：

```bash
git commit -m "feat(chart-engine): implement intelligent chart generation"
```

---

## 阶段 8：ChatBI Frontend

目标：
- AI Chat
- Streaming UI
- Chart rendering
- SQL display
- Markdown rendering

建议提交：

```bash
git commit -m "feat(web): implement chatbi frontend"
```

---

## 阶段 9：Enterprise Security

目标：
- RBAC
- SQL permission
- Prompt injection protection
- Audit logging
- Tenant isolation

建议提交：

```bash
git commit -m "feat(security): implement enterprise security layer"
```
