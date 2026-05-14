# ClusterDataAgent - Harness Engineering Roadmap

当前激活阶段：`阶段 9 / security-and-polish`

## 当前状态总览

- 已完成：阶段 1、2、3、4、5、8、9
- 部分完成：阶段 7（图表主题层 polish 仍有收尾）
- 后续迁移：阶段 6 仍保留为 Python/FastAPI/Pandas 方向，但当前线上实现是 TypeScript

---

## 阶段 1：初始化 Monorepo

状态：已完成

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
- API 与 Web 都可以启动
- lint、typecheck、test、build 有统一入口
- Husky `pre-commit` 会执行 `pnpm verify`

---

## 阶段 2：Agent Core

状态：已完成

目标：
- OpenAI Responses API
- Tool Calling
- Streaming
- Memory
- Retry
- AbortController

现状：
- 已支持非流式与流式调用
- 已支持 tool loop、会话记忆、文件持久化记忆
- 已支持超时中止、失败重试、上游 SSE 透传

---

## 阶段 3：Tool System

状态：已完成，后续持续演进

目标：
- Tool Registry
- Tool Discovery
- Tool Hooks
- Metrics
- Timeout
- Retry

现状：
- 已实现工具注册、执行、输入校验、hooks、metrics、timeout、retry
- 已新增命名工具发现与批量注册能力，便于内置工具和扩展点接入

---

## 阶段 4：Metadata Engine

状态：已完成

目标：
- PostgreSQL schema scanner
- Metadata cache
- Relation analysis
- Full text search

现状：
- 已支持 Prisma schema catalog 和 PostgreSQL live schema 扫描
- 已支持缓存、关系推断、metadata search、catalog refresh

---

## 阶段 5：SQL Agent

状态：已完成

目标：
- Metadata-aware SQL generation
- SQL validation
- SQL sandbox
- AST parser
- Dangerous SQL prevention

现状：
- 已支持 AST 解析、SELECT/WITH 校验、危险 SQL 拦截、metadata-aware SQL 生成
- 当前 sandbox 能力通过只读事务、limit 约束、访问控制和安全校验落地

---

## 阶段 6：Python Analysis Service

状态：后续迁移项，当前未启动

目标：
- FastAPI
- Pandas
- Trend analysis
- Anomaly detection
- Time series analysis

现状：
- 当前分析能力已经由 TypeScript `analysis-service` 提供
- 若后续需要 Python 生态或更重的数据处理能力，再迁移到 FastAPI/Pandas

---

## 阶段 7：Chart Engine

状态：部分完成

目标：
- ECharts option generator
- Smart chart selection
- Dark mode
- Large dataset optimization

现状：
- 已实现 ECharts option 生成、智能图表推荐、大数据 sampling/zoom/progressive 优化
- 图表主题层的 dark mode polish 仍可继续增强

---

## 阶段 8：ChatBI Frontend

状态：已完成

目标：
- AI Chat
- Streaming UI
- Chart rendering
- SQL display
- Markdown rendering

现状：
- 已实现 ChatBI 工作台、SSE 聊天、SQL Guardrail、查询历史/CSV、数据画像、图表预览、文档页、中英切换

---

## 阶段 9：Enterprise Security

状态：已完成

目标：
- RBAC
- SQL permission
- Prompt injection protection
- Audit logging
- Tenant isolation

现状：
- 已实现租户隔离、角色访问控制、SQL 读权限、prompt injection 防护、安全审计日志
- API 与前端均已暴露 Access Check 能力
