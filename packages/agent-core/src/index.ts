import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AppError,
  createLogger,
  safeErrorMessage,
  type Logger
} from "@clusterdata/shared";
import { type JsonSchema, type ToolRegistry } from "@clusterdata/tool-system";

const MAX_EMPTY_RESPONSE_RETRIES = 1;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_QUERY_RESULT_PREVIEW_ROWS = 25;
const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 512;

export const DevelopmentPrioritySchema = z.enum([
  "monorepo",
  "agent-core",
  "tool-system",
  "metadata-engine",
  "sql-agent",
  "analysis-service",
  "chart-engine",
  "frontend",
  "security"
]);

export const AgentManifestSchema = z.object({
  projectName: z.string().min(1),
  currentGoal: z.string().min(1),
  priorities: z.array(DevelopmentPrioritySchema).min(1),
  rules: z.array(z.string().min(1)).min(1)
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface AgentRuntimeConfig {
  readonly apiKey: string;
  readonly apiEndpoint: string;
  readonly defaultModel: string;
  readonly requestTimeoutMs: number;
  readonly maxToolCalls: number;
  readonly maxRetries: number;
  readonly maxToolResultChars?: number;
}

export interface AgentSessionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AgentSessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly forkedFromSessionId?: string;
  readonly lastMessage?: AgentSessionMessage;
}

export interface AgentSessionRecord extends AgentSessionSummary {
  readonly messages: readonly AgentSessionMessage[];
}

export interface AgentSessionMetadataUpdate {
  readonly title?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface AgentTurnRequest {
  readonly sessionId: string;
  readonly message: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface AgentToolCallRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly output: unknown;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AgentTurnResult {
  readonly sessionId: string;
  readonly outputText: string;
  readonly toolCalls: readonly AgentToolCallRecord[];
  readonly usage?: AgentUsage;
}

export interface AgentObservationError {
  readonly message: string;
  readonly code?: string;
}

export interface AgentToolCallObservation {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly status: "running" | "completed" | "failed";
  readonly output?: unknown;
  readonly error?: AgentObservationError;
}

export interface AgentActiveTurnObservation {
  readonly turnId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly requestMessage: string;
  readonly startedAt: string;
  readonly modelResponseCount: number;
  readonly toolCalls: readonly AgentToolCallObservation[];
}

export interface AgentTurnObservation extends AgentActiveTurnObservation {
  readonly completedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
  readonly outputText?: string;
  readonly outputTextChars: number;
  readonly usage?: AgentUsage;
  readonly error?: AgentObservationError;
}

export interface AgentObservabilityToolMetrics {
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly averageDurationMs: number;
  readonly lastDurationMs: number;
}

export interface AgentObservabilitySummary {
  readonly startedAt: string;
  readonly recentTurnCapacity: number;
  readonly retainedTurnCount: number;
  readonly activeTurnCount: number;
  readonly totalTurns: number;
  readonly completedTurns: number;
  readonly failedTurns: number;
  readonly totalToolCalls: number;
  readonly averageDurationMs: number;
  readonly averageToolCallsPerTurn: number;
  readonly totalOutputTextChars: number;
  readonly lastCompletedAt?: string;
  readonly lastFailedAt?: string;
  readonly tools: Readonly<Record<string, AgentObservabilityToolMetrics>>;
}

export interface AgentObservabilitySnapshot {
  readonly summary: AgentObservabilitySummary;
  readonly activeTurns: readonly AgentActiveTurnObservation[];
  readonly recentTurns: readonly AgentTurnObservation[];
}

export interface AgentObservabilityStore {
  recordTurnStarted(input: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly requestMessage: string;
    readonly startedAt?: string;
  }): void;
  recordModelResponse(input: {
    readonly turnId: string;
  }): void;
  recordToolCallStarted(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly startedAt?: string;
  }): void;
  recordToolCallCompleted(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly output: unknown;
    readonly completedAt?: string;
    readonly durationMs: number;
  }): void;
  recordToolCallFailed(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly error: AgentObservationError;
    readonly completedAt?: string;
    readonly durationMs: number;
  }): void;
  recordTurnCompleted(input: {
    readonly turnId: string;
    readonly outputText: string;
    readonly usage?: AgentUsage;
    readonly completedAt?: string;
  }): AgentTurnObservation;
  recordTurnFailed(input: {
    readonly turnId: string;
    readonly error: AgentObservationError;
    readonly completedAt?: string;
  }): AgentTurnObservation;
  getSnapshot(): AgentObservabilitySnapshot;
  clear(): void;
}

export interface InMemoryAgentObservabilityStoreOptions {
  readonly maxTurns?: number;
  readonly logger?: Logger;
}

export interface AgentEvaluationExpectations {
  readonly outputIncludes?: readonly string[];
  readonly outputExcludes?: readonly string[];
  readonly requiredToolNames?: readonly string[];
  readonly forbiddenToolNames?: readonly string[];
  readonly minToolCalls?: number;
  readonly maxToolCalls?: number;
}

export interface AgentEvaluationCase {
  readonly id: string;
  readonly message: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly expected?: AgentEvaluationExpectations;
}

export interface AgentEvaluationCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface AgentEvaluationCaseResult {
  readonly caseId: string;
  readonly sessionId: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly outputText?: string;
  readonly toolNames: readonly string[];
  readonly toolCalls: readonly AgentToolCallRecord[];
  readonly checks: readonly AgentEvaluationCheckResult[];
  readonly error?: AgentObservationError;
}

export interface AgentEvaluationSuiteRequest {
  readonly name?: string;
  readonly sessionIdPrefix?: string;
  readonly cases: readonly AgentEvaluationCase[];
}

export interface AgentEvaluationSuiteResult {
  readonly runId: string;
  readonly name: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly results: readonly AgentEvaluationCaseResult[];
}

interface MutableAgentToolCallObservation {
  callId: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "running" | "completed" | "failed";
  output?: unknown;
  error?: AgentObservationError;
}

interface MutableAgentActiveTurnObservation {
  turnId: string;
  sessionId: string;
  model: string;
  requestMessage: string;
  startedAt: string;
  modelResponseCount: number;
  toolCalls: MutableAgentToolCallObservation[];
}

interface MutableAgentObservabilityToolMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
}

export class InMemoryAgentObservabilityStore implements AgentObservabilityStore {
  private readonly logger: Logger;
  private readonly maxTurns: number;
  private startedAt: string;
  private readonly activeTurns = new Map<string, MutableAgentActiveTurnObservation>();
  private recentTurns: AgentTurnObservation[] = [];
  private completedTurns = 0;
  private failedTurns = 0;
  private totalTurnDurationMs = 0;
  private totalToolCalls = 0;
  private totalOutputTextChars = 0;
  private lastCompletedAt?: string;
  private lastFailedAt?: string;
  private readonly toolMetrics = new Map<string, MutableAgentObservabilityToolMetrics>();

  public constructor(options: InMemoryAgentObservabilityStoreOptions = {}) {
    if (!Number.isInteger(options.maxTurns ?? 50) || (options.maxTurns ?? 50) <= 0) {
      throw new AppError(
        "Agent observability maxTurns must be a positive integer",
        "INVALID_AGENT_OBSERVABILITY_LIMIT",
        500
      );
    }

    this.logger = options.logger ?? createLogger("agent-core-observability");
    this.maxTurns = options.maxTurns ?? 50;
    this.startedAt = new Date().toISOString();
  }

  public recordTurnStarted(input: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly requestMessage: string;
    readonly startedAt?: string;
  }): void {
    if (this.activeTurns.has(input.turnId)) {
      throw new AppError(
        `Agent turn is already active: ${input.turnId}`,
        "AGENT_TURN_ALREADY_ACTIVE",
        409,
        {
          turnId: input.turnId
        }
      );
    }

    this.activeTurns.set(input.turnId, {
      turnId: input.turnId,
      sessionId: input.sessionId,
      model: input.model,
      requestMessage: input.requestMessage,
      startedAt: input.startedAt ?? new Date().toISOString(),
      modelResponseCount: 0,
      toolCalls: []
    });
  }

  public recordModelResponse(input: { readonly turnId: string }): void {
    this.getActiveTurn(input.turnId).modelResponseCount += 1;
  }

  public recordToolCallStarted(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly startedAt?: string;
  }): void {
    this.getActiveTurn(input.turnId).toolCalls.push({
      callId: input.callId,
      toolName: input.toolName,
      arguments: input.arguments,
      startedAt: input.startedAt ?? new Date().toISOString(),
      status: "running"
    });
  }

  public recordToolCallCompleted(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly output: unknown;
    readonly completedAt?: string;
    readonly durationMs: number;
  }): void {
    const turn = this.getActiveTurn(input.turnId);
    const toolCall = getActiveToolCall(turn, input.callId);

    toolCall.completedAt = input.completedAt ?? new Date().toISOString();
    toolCall.durationMs = input.durationMs;
    toolCall.status = "completed";
    toolCall.output = input.output;

    this.recordToolMetric(toolCall.toolName, input.durationMs, true);
  }

  public recordToolCallFailed(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly error: AgentObservationError;
    readonly completedAt?: string;
    readonly durationMs: number;
  }): void {
    const turn = this.getActiveTurn(input.turnId);
    const toolCall = getActiveToolCall(turn, input.callId);

    toolCall.completedAt = input.completedAt ?? new Date().toISOString();
    toolCall.durationMs = input.durationMs;
    toolCall.status = "failed";
    toolCall.error = input.error;

    this.recordToolMetric(toolCall.toolName, input.durationMs, false);
  }

  public recordTurnCompleted(input: {
    readonly turnId: string;
    readonly outputText: string;
    readonly usage?: AgentUsage;
    readonly completedAt?: string;
  }): AgentTurnObservation {
    const turn = this.getActiveTurn(input.turnId);
    const observation = this.finalizeTurn(turn, {
      status: "completed",
      outputText: input.outputText,
      usage: input.usage,
      completedAt: input.completedAt ?? new Date().toISOString()
    });

    this.completedTurns += 1;
    this.lastCompletedAt = observation.completedAt;

    return observation;
  }

  public recordTurnFailed(input: {
    readonly turnId: string;
    readonly error: AgentObservationError;
    readonly completedAt?: string;
  }): AgentTurnObservation {
    const turn = this.getActiveTurn(input.turnId);
    const observation = this.finalizeTurn(turn, {
      status: "failed",
      error: input.error,
      completedAt: input.completedAt ?? new Date().toISOString()
    });

    this.failedTurns += 1;
    this.lastFailedAt = observation.completedAt;

    return observation;
  }

  public getSnapshot(): AgentObservabilitySnapshot {
    const totalTurns = this.completedTurns + this.failedTurns;

    return {
      summary: {
        startedAt: this.startedAt,
        recentTurnCapacity: this.maxTurns,
        retainedTurnCount: this.recentTurns.length,
        activeTurnCount: this.activeTurns.size,
        totalTurns,
        completedTurns: this.completedTurns,
        failedTurns: this.failedTurns,
        totalToolCalls: this.totalToolCalls,
        averageDurationMs: totalTurns === 0 ? 0 : this.totalTurnDurationMs / totalTurns,
        averageToolCallsPerTurn: totalTurns === 0 ? 0 : this.totalToolCalls / totalTurns,
        totalOutputTextChars: this.totalOutputTextChars,
        lastCompletedAt: this.lastCompletedAt,
        lastFailedAt: this.lastFailedAt,
        tools: Object.fromEntries(
          Array.from(this.toolMetrics.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, metrics]) => [
              name,
              {
                calls: metrics.calls,
                successes: metrics.successes,
                failures: metrics.failures,
                averageDurationMs:
                  metrics.calls === 0 ? 0 : metrics.totalDurationMs / metrics.calls,
                lastDurationMs: metrics.lastDurationMs
              }
            ])
        )
      },
      activeTurns: Array.from(this.activeTurns.values())
        .map((turn) => cloneActiveTurnObservation(turn))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      recentTurns: this.recentTurns.map((turn) => cloneTurnObservation(turn))
    };
  }

  public clear(): void {
    this.activeTurns.clear();
    this.recentTurns = [];
    this.completedTurns = 0;
    this.failedTurns = 0;
    this.totalTurnDurationMs = 0;
    this.totalToolCalls = 0;
    this.totalOutputTextChars = 0;
    this.lastCompletedAt = undefined;
    this.lastFailedAt = undefined;
    this.toolMetrics.clear();
    this.startedAt = new Date().toISOString();

    this.logger.info("agent observability cleared", {
      maxTurns: this.maxTurns
    });
  }

  private finalizeTurn(
    turn: MutableAgentActiveTurnObservation,
    input:
      | {
          readonly status: "completed";
          readonly outputText: string;
          readonly usage?: AgentUsage;
          readonly completedAt: string;
        }
      | {
          readonly status: "failed";
          readonly error: AgentObservationError;
          readonly completedAt: string;
        }
  ): AgentTurnObservation {
    this.activeTurns.delete(turn.turnId);

    const durationMs = Math.max(
      Date.parse(input.completedAt) - Date.parse(turn.startedAt),
      0
    );
    const outputText = input.status === "completed" ? input.outputText : undefined;
    const observation: AgentTurnObservation = {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      model: turn.model,
      requestMessage: turn.requestMessage,
      startedAt: turn.startedAt,
      completedAt: input.completedAt,
      durationMs,
      modelResponseCount: turn.modelResponseCount,
      toolCalls: turn.toolCalls.map((toolCall) => cloneToolCallObservation(toolCall)),
      status: input.status,
      outputText,
      outputTextChars: outputText?.length ?? 0,
      usage: input.status === "completed" ? input.usage : undefined,
      error: input.status === "failed" ? input.error : undefined
    };

    this.recentTurns.unshift(observation);
    this.recentTurns = this.recentTurns.slice(0, this.maxTurns);
    this.totalTurnDurationMs += durationMs;
    this.totalToolCalls += observation.toolCalls.length;
    this.totalOutputTextChars += observation.outputTextChars;

    return observation;
  }

  private getActiveTurn(turnId: string): MutableAgentActiveTurnObservation {
    const turn = this.activeTurns.get(turnId);

    if (!turn) {
      throw new AppError(`Unknown active agent turn: ${turnId}`, "AGENT_TURN_NOT_FOUND", 404, {
        turnId
      });
    }

    return turn;
  }

  private recordToolMetric(
    toolName: string,
    durationMs: number,
    succeeded: boolean
  ): void {
    const current = this.toolMetrics.get(toolName) ?? {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastDurationMs: 0
    };

    current.calls += 1;
    current.totalDurationMs += durationMs;
    current.lastDurationMs = durationMs;

    if (succeeded) {
      current.successes += 1;
    } else {
      current.failures += 1;
    }

    this.toolMetrics.set(toolName, current);
  }
}

export type AgentStreamEvent =
  | {
      readonly type: "session.started";
      readonly sessionId: string;
      readonly model: string;
    }
  | {
      readonly type: "response.output_text.delta";
      readonly sessionId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool.call.started";
      readonly sessionId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool.call.completed";
      readonly sessionId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly output: unknown;
    }
  | {
      readonly type: "response.completed";
      readonly sessionId: string;
      readonly outputText: string;
      readonly toolCalls: readonly AgentToolCallRecord[];
      readonly usage?: AgentUsage;
    }
  | {
      readonly type: "response.failed";
      readonly sessionId: string;
      readonly error: string;
      readonly code: string;
    };

export interface SessionStore {
  get(sessionId: string): readonly AgentSessionMessage[];
  read(sessionId: string): AgentSessionRecord | undefined;
  append(sessionId: string, messages: readonly AgentSessionMessage[]): void;
  updateMetadata(
    sessionId: string,
    metadata: AgentSessionMetadataUpdate
  ): AgentSessionRecord | undefined;
  fork(
    sessionId: string,
    nextSessionId: string,
    metadata?: AgentSessionMetadataUpdate
  ): AgentSessionRecord;
  list(): readonly AgentSessionSummary[];
  delete(sessionId: string): boolean;
  clear(): number;
}

interface StoredAgentSession {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: AgentSessionMessage[];
  readonly metadata?: {
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly forkedFromSessionId?: string;
  };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredAgentSession>();
  private readonly maxMessages: number;

  public constructor(maxMessages = 20) {
    if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
      throw new AppError("Memory limit must be a positive integer", "INVALID_MEMORY_LIMIT", 500);
    }

    this.maxMessages = maxMessages;
  }

  public get(sessionId: string): readonly AgentSessionMessage[] {
    return cloneSessionMessages(this.sessions.get(sessionId)?.messages ?? []);
  }

  public read(sessionId: string): AgentSessionRecord | undefined {
    return buildSessionRecord(sessionId, this.sessions.get(sessionId));
  }

  public append(sessionId: string, messages: readonly AgentSessionMessage[]): void {
    const now = new Date().toISOString();
    const current = this.sessions.get(sessionId);
    const nextMessages = [
      ...(current?.messages ? cloneSessionMessages(current.messages) : []),
      ...cloneSessionMessages(messages)
    ].slice(-this.maxMessages);

    this.sessions.set(sessionId, {
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      messages: nextMessages,
      metadata: cloneSessionMetadata(current?.metadata)
    });
  }

  public updateMetadata(
    sessionId: string,
    metadata: AgentSessionMetadataUpdate
  ): AgentSessionRecord | undefined {
    const current = this.sessions.get(sessionId);

    if (!current) {
      return undefined;
    }

    this.sessions.set(sessionId, {
      ...current,
      updatedAt: new Date().toISOString(),
      metadata: mergeSessionMetadata(current.metadata, metadata)
    });

    return this.read(sessionId);
  }

  public fork(
    sessionId: string,
    nextSessionId: string,
    metadata: AgentSessionMetadataUpdate = {}
  ): AgentSessionRecord {
    const source = this.sessions.get(sessionId);

    if (!source) {
      throw new AppError(`Unknown agent session: ${sessionId}`, "AGENT_SESSION_NOT_FOUND", 404, {
        sessionId
      });
    }

    if (this.sessions.has(nextSessionId)) {
      throw new AppError(`Agent session already exists: ${nextSessionId}`, "AGENT_SESSION_EXISTS", 409, {
        sessionId: nextSessionId
      });
    }

    const now = new Date().toISOString();

    this.sessions.set(nextSessionId, {
      createdAt: now,
      updatedAt: now,
      messages: cloneSessionMessages(source.messages),
      metadata: buildForkSessionMetadata(source, sessionId, metadata)
    });

    return this.read(nextSessionId)!;
  }

  public list(): readonly AgentSessionSummary[] {
    return buildSessionSummaries(this.sessions);
  }

  public delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  public clear(): number {
    const deletedCount = this.sessions.size;

    this.sessions.clear();

    return deletedCount;
  }
}

export interface FileSessionStoreOptions {
  readonly filePath: string;
  readonly maxMessages?: number;
  readonly logger?: Logger;
}

export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, StoredAgentSession>();

  public constructor(options: FileSessionStoreOptions) {
    if (!Number.isInteger(options.maxMessages ?? 20) || (options.maxMessages ?? 20) <= 0) {
      throw new AppError("Memory limit must be a positive integer", "INVALID_MEMORY_LIMIT", 500);
    }

    this.filePath = options.filePath.trim();

    if (this.filePath.length === 0) {
      throw new AppError("filePath is required", "SESSION_STORE_PATH_REQUIRED", 500);
    }

    this.maxMessages = options.maxMessages ?? 20;
    this.logger = options.logger ?? createLogger("agent-core-session-store");
    this.loadFromDisk();
  }

  public get(sessionId: string): readonly AgentSessionMessage[] {
    return cloneSessionMessages(this.sessions.get(sessionId)?.messages ?? []);
  }

  public read(sessionId: string): AgentSessionRecord | undefined {
    return buildSessionRecord(sessionId, this.sessions.get(sessionId));
  }

  public append(sessionId: string, messages: readonly AgentSessionMessage[]): void {
    const now = new Date().toISOString();
    const current = this.sessions.get(sessionId);
    const nextMessages = [
      ...(current?.messages ? cloneSessionMessages(current.messages) : []),
      ...cloneSessionMessages(messages)
    ].slice(-this.maxMessages);

    this.sessions.set(sessionId, {
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      messages: nextMessages,
      metadata: cloneSessionMetadata(current?.metadata)
    });
    this.persistToDisk();
  }

  public updateMetadata(
    sessionId: string,
    metadata: AgentSessionMetadataUpdate
  ): AgentSessionRecord | undefined {
    const current = this.sessions.get(sessionId);

    if (!current) {
      return undefined;
    }

    this.sessions.set(sessionId, {
      ...current,
      updatedAt: new Date().toISOString(),
      metadata: mergeSessionMetadata(current.metadata, metadata)
    });
    this.persistToDisk();
    this.logger.info("session store metadata updated", {
      filePath: this.filePath,
      sessionId
    });

    return this.read(sessionId);
  }

  public fork(
    sessionId: string,
    nextSessionId: string,
    metadata: AgentSessionMetadataUpdate = {}
  ): AgentSessionRecord {
    const source = this.sessions.get(sessionId);

    if (!source) {
      throw new AppError(`Unknown agent session: ${sessionId}`, "AGENT_SESSION_NOT_FOUND", 404, {
        sessionId
      });
    }

    if (this.sessions.has(nextSessionId)) {
      throw new AppError(`Agent session already exists: ${nextSessionId}`, "AGENT_SESSION_EXISTS", 409, {
        sessionId: nextSessionId
      });
    }

    const now = new Date().toISOString();

    this.sessions.set(nextSessionId, {
      createdAt: now,
      updatedAt: now,
      messages: cloneSessionMessages(source.messages),
      metadata: buildForkSessionMetadata(source, sessionId, metadata)
    });
    this.persistToDisk();
    this.logger.info("session store session forked", {
      filePath: this.filePath,
      sessionId,
      nextSessionId
    });

    return this.read(nextSessionId)!;
  }

  public list(): readonly AgentSessionSummary[] {
    return buildSessionSummaries(this.sessions);
  }

  public delete(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);

    if (deleted) {
      this.persistToDisk();
      this.logger.info("session store session deleted", {
        filePath: this.filePath,
        sessionId,
        sessionCount: this.sessions.size
      });
    }

    return deleted;
  }

  public clear(): number {
    const deletedCount = this.sessions.size;

    this.sessions.clear();
    this.persistToDisk();
    this.logger.info("session store cleared", {
      filePath: this.filePath,
      deletedCount
    });

    return deletedCount;
  }

  private loadFromDisk(): void {
    ensureParentDirectory(this.filePath);

    if (!existsSync(this.filePath)) {
      this.persistToDisk();
      this.logger.info("session store created", {
        filePath: this.filePath,
        sessionCount: 0
      });

      return;
    }

    let rawText: string;

    try {
      rawText = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new AppError("Session store file could not be read", "SESSION_STORE_READ_FAILED", 500, {
        filePath: this.filePath,
        error: safeErrorMessage(error)
      });
    }

    const loadedStore = parsePersistedSessions(rawText, this.filePath);

    for (const [sessionId, session] of loadedStore.sessions.entries()) {
      this.sessions.set(sessionId, {
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages.slice(-this.maxMessages),
        ...(session.metadata ? { metadata: cloneSessionMetadata(session.metadata) } : {})
      });
    }

    if (loadedStore.version === 1) {
      this.persistToDisk();
      this.logger.info("session store upgraded", {
        filePath: this.filePath,
        sessionCount: this.sessions.size,
        version: 2
      });
    }

    this.logger.info("session store loaded", {
      filePath: this.filePath,
      sessionCount: this.sessions.size
    });
  }

  private persistToDisk(): void {
    try {
      ensureParentDirectory(this.filePath);
      writeFileSync(
        this.filePath,
        JSON.stringify(buildPersistedSessions(this.sessions), null, 2),
        "utf8"
      );
      this.logger.info("session store persisted", {
        filePath: this.filePath,
        sessionCount: this.sessions.size
      });
    } catch (error) {
      throw new AppError("Session store file could not be written", "SESSION_STORE_WRITE_FAILED", 500, {
        filePath: this.filePath,
        error: safeErrorMessage(error)
      });
    }
  }
}

export interface ResponsesTransport {
  createResponse(request: OpenAIResponseRequest): Promise<OpenAIResponse>;
  streamResponse?(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void>;
}

export interface AgentExecutorOptions {
  readonly toolRegistry: ToolRegistry;
  readonly sessionStore: SessionStore;
  readonly config: AgentRuntimeConfig;
  readonly instructions?: string;
  readonly logger?: Logger;
  readonly transport?: ResponsesTransport;
  readonly observabilityStore?: AgentObservabilityStore;
}

export class AgentExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly config: AgentRuntimeConfig;
  private readonly instructions: string;
  private readonly logger: Logger;
  private readonly transport: ResponsesTransport;
  private readonly observabilityStore: AgentObservabilityStore;

  public constructor(options: AgentExecutorOptions) {
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.config = options.config;
    this.instructions =
      options.instructions ??
      [
        "You are ClusterDataAgent, a bilingual Chinese/English data analysis assistant.",
        "For database, table, metric, count, list, aggregation, chart, access, or safety questions, use the available tools instead of guessing.",
        "For Chinese business terms, map common words to likely metadata search terms before querying tools, for example 订单/order/orders, 客户/customer/customers, 事件/event/events.",
        "When the user asks how many records/多少记录/多少条/count, first find the relevant table with search-metadata when the table is not explicit, then execute a safe read-only count query with query-sql when available.",
        "Keep SQL read-only, bounded, and metadata-aware. Answer in the same language as the user unless they ask otherwise.",
        "Be concise and explicit, and include the table or SQL result basis for data answers."
      ].join(" ");
    this.logger = options.logger ?? createLogger("agent-core");
    this.observabilityStore =
      options.observabilityStore ??
      new InMemoryAgentObservabilityStore({
        logger: this.logger
      });
    this.transport =
      options.transport ??
      new OpenAIResponsesTransport({
        apiKey: options.config.apiKey,
        apiEndpoint: options.config.apiEndpoint,
        requestTimeoutMs: options.config.requestTimeoutMs,
        maxRetries: options.config.maxRetries,
        logger: this.logger
      });
  }

  public getObservabilitySnapshot(): AgentObservabilitySnapshot {
    return this.observabilityStore.getSnapshot();
  }

  public clearObservability(): void {
    this.observabilityStore.clear();
  }

  public async runEvaluationSuite(
    request: AgentEvaluationSuiteRequest
  ): Promise<AgentEvaluationSuiteResult> {
    const parsed = validateAgentEvaluationSuiteRequest(request);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const sessionIdPrefix = parsed.sessionIdPrefix ?? `eval-${runId}`;
    const results: AgentEvaluationCaseResult[] = [];

    this.logger.info("agent evaluation started", {
      runId,
      name: parsed.name,
      caseCount: parsed.cases.length
    });

    for (const evaluationCase of parsed.cases) {
      const sessionId =
        evaluationCase.sessionId?.trim() || `${sessionIdPrefix}-${evaluationCase.id}`;
      const caseStartedAtMs = Date.now();
      const shouldCleanupSession = typeof evaluationCase.sessionId === "undefined";

      try {
        const result = await this.executeTurn({
          sessionId,
          message: evaluationCase.message,
          model: evaluationCase.model
        });
        const checks = buildAgentEvaluationChecks(evaluationCase, result);
        const caseResult: AgentEvaluationCaseResult = {
          caseId: evaluationCase.id,
          sessionId,
          passed: checks.every((check) => check.passed),
          durationMs: Date.now() - caseStartedAtMs,
          outputText: result.outputText,
          toolNames: result.toolCalls.map((toolCall) => toolCall.toolName),
          toolCalls: result.toolCalls,
          checks
        };

        results.push(caseResult);
        this.logger.info("agent evaluation case completed", {
          runId,
          caseId: evaluationCase.id,
          sessionId,
          passed: caseResult.passed,
          durationMs: caseResult.durationMs,
          toolCallCount: result.toolCalls.length
        });
      } catch (error) {
        const appError = normalizeAgentError(error);
        const caseResult: AgentEvaluationCaseResult = {
          caseId: evaluationCase.id,
          sessionId,
          passed: false,
          durationMs: Date.now() - caseStartedAtMs,
          toolNames: [],
          toolCalls: [],
          checks: [
            {
              name: "execution.succeeded",
              passed: false,
              expected: true,
              actual: appError.code
            }
          ],
          error: {
            message: appError.message,
            code: appError.code
          }
        };

        results.push(caseResult);
        this.logger.error("agent evaluation case failed", {
          runId,
          caseId: evaluationCase.id,
          sessionId,
          durationMs: caseResult.durationMs,
          code: appError.code,
          error: appError.message
        });
      } finally {
        if (shouldCleanupSession) {
          this.sessionStore.delete(sessionId);
        }
      }
    }

    const completedAt = new Date().toISOString();
    const passedCases = results.filter((result) => result.passed).length;
    const report: AgentEvaluationSuiteResult = {
      runId,
      name: parsed.name,
      startedAt,
      completedAt,
      durationMs: Date.now() - startedAtMs,
      totalCases: results.length,
      passedCases,
      failedCases: results.length - passedCases,
      results
    };

    this.logger.info("agent evaluation completed", {
      runId,
      name: parsed.name,
      totalCases: report.totalCases,
      passedCases: report.passedCases,
      failedCases: report.failedCases,
      durationMs: report.durationMs
    });

    return report;
  }

  public async executeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    let result: AgentTurnResult | undefined;

    for await (const event of this.streamTurn(request)) {
      if (event.type === "response.completed") {
        result = {
          sessionId: event.sessionId,
          outputText: event.outputText,
          toolCalls: event.toolCalls,
          usage: event.usage
        };
      }
    }

    if (!result) {
      throw new AppError("Agent execution failed", "AGENT_EXECUTION_FAILED", 500);
    }

    return result;
  }

  public async *streamTurn(
    request: AgentTurnRequest
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult, void> {
    const parsed = validateTurnRequest(request);
    const model = parsed.model ?? this.config.defaultModel;
    const observation = new AgentTurnObserver(this.observabilityStore, this.logger, {
      turnId: randomUUID(),
      sessionId: parsed.sessionId,
      model,
      requestMessage: parsed.message
    });

    yield {
      type: "session.started",
      sessionId: parsed.sessionId,
      model
    };

    try {
      let completed: AgentTurnResult | undefined;

      for await (const event of this.runTurnStream(parsed, model, observation)) {
        if (isCompletedEvent(event)) {
          completed = {
            sessionId: event.sessionId,
            outputText: event.outputText,
            toolCalls: event.toolCalls,
            usage: event.usage
          };
        }

        yield event;
      }

      if (!completed) {
        throw new AppError("Agent execution completed without a final event", "MISSING_COMPLETION_EVENT", 500);
      }

      return completed;
    } catch (error) {
      const appError = normalizeAgentError(error);
      observation.recordTurnFailed(appError);
      yield {
        type: "response.failed",
        sessionId: parsed.sessionId,
        error: appError.message,
        code: appError.code
      };
      throw appError;
    }
  }

  private async *runTurnStream(
    request: AgentTurnRequest,
    model: string,
    observation: AgentTurnObserver
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult, void> {
    const history = this.sessionStore.get(request.sessionId);
    const conversation = buildConversationInput(
      this.instructions,
      history,
      request.message
    );
    const toolCalls: AgentToolCallRecord[] = [];
    let totalToolCalls = 0;
    let emptyResponseRetries = 0;
    let latestResponse: OpenAIResponse | undefined;

    this.logger.info("agent turn started", {
      sessionId: request.sessionId,
      model,
      historyCount: history.length
    });

    while (true) {
      let streamedOutputText = "";
      let latestStreamResponse: OpenAIResponse | undefined;

      for await (const event of this.createResponseEventStreamWithRetry({
        model,
        input: conversation,
        tools: buildToolDefinitions(this.toolRegistry),
        signal: request.signal
      })) {
        assertAbortSignal(request.signal);

        if (isOutputTextDeltaStreamEvent(event)) {
          streamedOutputText += event.delta;
          yield {
            type: "response.output_text.delta",
            sessionId: request.sessionId,
            delta: event.delta
          };
          continue;
        }

        const completedResponse = extractCompletedStreamResponse(event);

        if (completedResponse) {
          latestStreamResponse = completedResponse;
          continue;
        }

        if (isFailedOpenAIStreamEvent(event)) {
          throw buildOpenAIStreamEventError(event);
        }
      }

      latestResponse = latestStreamResponse;

      if (!latestResponse) {
        if (streamedOutputText.length > 0) {
          latestResponse = buildSyntheticTextResponse(streamedOutputText);
        } else {
          throw new AppError(
            "OpenAI stream completed without a response payload",
            "OPENAI_STREAM_MISSING_RESPONSE",
            502
          );
        }
      }

      observation.recordModelResponse();
      const functionCalls = latestResponse.output.filter(isFunctionCallItem);

      if (functionCalls.length === 0) {
        let outputText = streamedOutputText;

        if (outputText.length === 0) {
          const extractedOutputText = tryExtractOutputText(latestResponse);

          if (!extractedOutputText) {
            if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
              emptyResponseRetries += 1;
              this.logger.warn("agent empty response retrying", {
                sessionId: request.sessionId,
                model,
                responseId: latestResponse.id,
                outputItemCount: latestResponse.output.length,
                retry: emptyResponseRetries
              });
              continue;
            }

            throw new AppError("Model returned an empty response", "EMPTY_MODEL_RESPONSE", 502, {
              sessionId: request.sessionId,
              model,
              responseId: latestResponse.id,
              outputItemCount: latestResponse.output.length
            });
          }

          outputText = extractedOutputText;
        }

        this.sessionStore.append(request.sessionId, [
          {
            role: "user",
            content: request.message
          },
          {
            role: "assistant",
            content: outputText
          }
        ]);

        this.logger.info("agent turn completed", {
          sessionId: request.sessionId,
          model,
          toolCallCount: toolCalls.length
        });

        const result = {
          sessionId: request.sessionId,
          outputText,
          toolCalls,
          usage: latestResponse.usage
            ? {
                inputTokens: latestResponse.usage.input_tokens,
                outputTokens: latestResponse.usage.output_tokens,
                totalTokens: latestResponse.usage.total_tokens
              }
            : undefined
        };
        observation.recordTurnCompleted(result);

        yield {
          type: "response.completed",
          sessionId: request.sessionId,
          outputText: result.outputText,
          toolCalls: result.toolCalls,
          usage: result.usage
        };

        return result;
      }

      emptyResponseRetries = 0;

      for (const functionCall of functionCalls) {
        assertAbortSignal(request.signal);
        totalToolCalls += 1;

        if (totalToolCalls > this.config.maxToolCalls) {
          throw new AppError(
            "Agent exceeded the configured tool call limit",
            "AGENT_TOOL_LIMIT_EXCEEDED",
            500,
            {
              sessionId: request.sessionId,
              maxToolCalls: this.config.maxToolCalls
            }
          );
        }

        const parsedArguments = parseFunctionArguments(
          functionCall.arguments,
          functionCall.name
        );
        const toolStartedAtMs = Date.now();

        observation.recordToolCallStarted({
          callId: functionCall.call_id,
          toolName: functionCall.name,
          arguments: parsedArguments
        });
        yield {
          type: "tool.call.started",
          sessionId: request.sessionId,
          callId: functionCall.call_id,
          toolName: functionCall.name,
          arguments: parsedArguments
        };
        let toolResult: unknown;

        try {
          toolResult = await this.toolRegistry.execute(functionCall.name, parsedArguments, {
            requestId: latestResponse.id,
            metadata: {
              sessionId: request.sessionId
            },
            logger: this.logger
          });
        } catch (error) {
          observation.recordToolCallFailed(
            functionCall.call_id,
            normalizeObservationError(error),
            Date.now() - toolStartedAtMs
          );
          throw error;
        }

        const governedToolResult = governToolResultForModel(
          functionCall.name,
          toolResult,
          this.config.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
        );
        observation.recordToolCallCompleted(
          functionCall.call_id,
          governedToolResult,
          Date.now() - toolStartedAtMs
        );
        yield {
          type: "tool.call.completed",
          sessionId: request.sessionId,
          callId: functionCall.call_id,
          toolName: functionCall.name,
          output: governedToolResult
        };

        toolCalls.push({
          callId: functionCall.call_id,
          toolName: functionCall.name,
          arguments: parsedArguments,
          output: governedToolResult
        });

        conversation.push({
          type: "function_call",
          call_id: functionCall.call_id,
          name: functionCall.name,
          arguments: functionCall.arguments
        });
        conversation.push({
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: JSON.stringify(governedToolResult)
        });
      }

    }
  }

  private async *createResponseEventStreamWithRetry(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
    if (!this.transport.streamResponse) {
      const response = await this.createResponseWithRetry(request);

      for (const event of buildFallbackResponseEvents(response)) {
        yield event;
      }

      return;
    }

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      let emittedEvent = false;

      try {
        for await (const event of this.transport.streamResponse(request)) {
          emittedEvent = true;
          yield event;
        }

        return;
      } catch (error) {
        const appError = normalizeAgentError(error);

        if (
          !emittedEvent &&
          attempt <= this.config.maxRetries &&
          isRetryableOpenAIError(appError)
        ) {
          this.logger.warn("agent streaming response retrying", {
            attempt,
            code: appError.code,
            error: appError.message
          });
          continue;
        }

        throw appError;
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }

  private async createResponseWithRetry(
    request: OpenAIResponseRequest
  ): Promise<OpenAIResponse> {
    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      try {
        return await this.transport.createResponse(request);
      } catch (error) {
        const appError = normalizeAgentError(error);

        if (attempt <= this.config.maxRetries && isRetryableOpenAIError(appError)) {
          this.logger.warn("agent response retrying", {
            attempt,
            code: appError.code,
            error: appError.message
          });
          continue;
        }

        throw appError;
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }
}

class AgentTurnObserver {
  private readonly store: AgentObservabilityStore;
  private readonly logger: Logger;
  private readonly turnId: string;
  private finalized = false;

  public constructor(
    store: AgentObservabilityStore,
    logger: Logger,
    input: {
      readonly turnId: string;
      readonly sessionId: string;
      readonly model: string;
      readonly requestMessage: string;
    }
  ) {
    this.store = store;
    this.logger = logger;
    this.turnId = input.turnId;

    this.safeRecord("recordTurnStarted", () =>
      this.store.recordTurnStarted({
        turnId: input.turnId,
        sessionId: input.sessionId,
        model: input.model,
        requestMessage: input.requestMessage
      })
    );
  }

  public recordModelResponse(): void {
    this.safeRecord("recordModelResponse", () =>
      this.store.recordModelResponse({
        turnId: this.turnId
      })
    );
  }

  public recordToolCallStarted(input: {
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): void {
    this.safeRecord("recordToolCallStarted", () =>
      this.store.recordToolCallStarted({
        turnId: this.turnId,
        ...input
      })
    );
  }

  public recordToolCallCompleted(
    callId: string,
    output: unknown,
    durationMs: number
  ): void {
    this.safeRecord("recordToolCallCompleted", () =>
      this.store.recordToolCallCompleted({
        turnId: this.turnId,
        callId,
        output,
        durationMs
      })
    );
  }

  public recordToolCallFailed(
    callId: string,
    error: AgentObservationError,
    durationMs: number
  ): void {
    this.safeRecord("recordToolCallFailed", () =>
      this.store.recordToolCallFailed({
        turnId: this.turnId,
        callId,
        error,
        durationMs
      })
    );
  }

  public recordTurnCompleted(result: AgentTurnResult): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.safeRecord("recordTurnCompleted", () =>
      this.store.recordTurnCompleted({
        turnId: this.turnId,
        outputText: result.outputText,
        usage: result.usage
      })
    );
  }

  public recordTurnFailed(error: AppError): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.safeRecord("recordTurnFailed", () =>
      this.store.recordTurnFailed({
        turnId: this.turnId,
        error: {
          message: error.message,
          code: error.code
        }
      })
    );
  }

  private safeRecord(action: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.logger.error("agent observability update failed", {
        action,
        turnId: this.turnId,
        error: safeErrorMessage(error)
      });
    }
  }
}

interface OpenAIResponseRequest {
  readonly model: string;
  readonly input: readonly OpenAIInputItem[];
  readonly tools: readonly OpenAIFunctionTool[];
  readonly signal?: AbortSignal;
}

interface OpenAIUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

interface OpenAIResponse {
  readonly id: string;
  readonly output: readonly OpenAIOutputItem[];
  readonly output_text?: string;
  readonly usage?: OpenAIUsage;
}

interface OpenAIResponseOutputTextDeltaEvent {
  readonly type: "response.output_text.delta";
  readonly delta: string;
}

interface OpenAIResponseCompletedStreamEvent {
  readonly type: "response.completed";
  readonly response: OpenAIResponse;
}

interface OpenAIResponseFailedStreamEvent {
  readonly type: "response.failed";
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
  };
  readonly response?: {
    readonly error?: {
      readonly message?: string;
      readonly code?: string;
    };
  };
}

interface OpenAIErrorStreamEvent {
  readonly type: "error";
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
  };
}

type OpenAIResponseStreamEvent =
  | OpenAIResponseOutputTextDeltaEvent
  | OpenAIResponseCompletedStreamEvent
  | OpenAIResponseFailedStreamEvent
  | OpenAIErrorStreamEvent
  | (Readonly<Record<string, unknown>> & { readonly type: string });

type OpenAIOutputItem =
  | {
      readonly type: "message";
      readonly role: "assistant";
      readonly content: readonly {
        readonly type: string;
        readonly text?: string;
      }[];
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    };

type OpenAIInputItem =
  | {
      readonly type: "message";
      readonly role: "developer" | "user" | "assistant";
      readonly content: readonly {
        readonly type: "input_text" | "output_text";
        readonly text: string;
      }[];
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "function_call_output";
      readonly call_id: string;
      readonly output: string;
    };

interface OpenAIFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

interface OpenAIResponsesTransportOptions {
  readonly apiKey: string;
  readonly apiEndpoint: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
}

class OpenAIResponsesTransport implements ResponsesTransport {
  private readonly apiKey: string;
  private readonly apiEndpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;

  public constructor(options: OpenAIResponsesTransportOptions) {
    this.apiKey = options.apiKey;
    this.apiEndpoint = resolveResponsesApiEndpoint(options.apiEndpoint);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxRetries = options.maxRetries;
    this.logger = options.logger;
  }

  public async createResponse(request: OpenAIResponseRequest): Promise<OpenAIResponse> {
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const requestAbort = createRequestAbortController(
        request.signal,
        this.requestTimeoutMs
      );

      try {
        const response = await this.sendRequest(
          request,
          requestAbort.abortController.signal
        );
        const payload = (await response.json()) as Partial<OpenAIResponse>;

        if (!response.ok) {
          const appError = await buildOpenAIHttpError(response, payload);

          if (attempt <= this.maxRetries && isRetryableOpenAIStatus(response.status)) {
            this.logger.warn("openai request retrying", {
              attempt,
              statusCode: response.status,
              error: appError.message
            });
            continue;
          }

          throw appError;
        }

        return payload as OpenAIResponse;
      } catch (error) {
        const normalizedError = normalizeOpenAITransportError(error);

        if (attempt <= this.maxRetries && isRetryableOpenAIError(normalizedError)) {
          this.logger.warn("openai transport retrying", {
            attempt,
            code: normalizedError.code,
            error: normalizedError.message
          });
          continue;
        }

        throw normalizedError;
      } finally {
        requestAbort.dispose();
      }
    }

    throw new AppError("OpenAI retries exhausted", "OPENAI_RETRY_EXHAUSTED", 502);
  }

  public async *streamResponse(
    request: OpenAIResponseRequest
  ): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
    const requestAbort = createRequestAbortController(
      request.signal,
      this.requestTimeoutMs
    );

    try {
      const response = await this.sendRequest(
        request,
        requestAbort.abortController.signal,
        {
          accept: "text/event-stream"
        },
        true
      );

      if (!response.ok) {
        throw await buildOpenAIHttpError(response);
      }

      if (!response.body) {
        throw new AppError("OpenAI stream body was empty", "OPENAI_EMPTY_STREAM", 502);
      }

      for await (const event of parseOpenAIResponseStream(response.body)) {
        yield event;
      }
    } catch (error) {
      throw normalizeOpenAITransportError(error);
    } finally {
      requestAbort.dispose();
    }
  }

  private async sendRequest(
    request: OpenAIResponseRequest,
    signal: AbortSignal,
    extraHeaders?: Readonly<Record<string, string>>,
    stream = false
  ): Promise<Response> {
    return await fetch(this.apiEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        tools: request.tools,
        tool_choice: "auto",
        stream
      }),
      signal
    });
  }
}

function validateTurnRequest(request: AgentTurnRequest): AgentTurnRequest {
  if (request.sessionId.trim().length === 0) {
    throw new AppError("sessionId is required", "SESSION_ID_REQUIRED", 400);
  }

  if (request.message.trim().length === 0) {
    throw new AppError("message is required", "MESSAGE_REQUIRED", 400);
  }

  return {
    sessionId: request.sessionId.trim(),
    message: request.message.trim(),
    model: request.model?.trim() || undefined,
    signal: request.signal
  };
}

function validateAgentEvaluationSuiteRequest(
  request: AgentEvaluationSuiteRequest
): {
  readonly name: string;
  readonly sessionIdPrefix?: string;
  readonly cases: readonly AgentEvaluationCase[];
} {
  const name = request.name?.trim() || "analysis-agent";
  const sessionIdPrefix = request.sessionIdPrefix?.trim() || undefined;

  if (!Array.isArray(request.cases) || request.cases.length === 0) {
    throw new AppError(
      "At least one evaluation case is required",
      "AGENT_EVALUATION_CASES_REQUIRED",
      400
    );
  }

  return {
    name,
    sessionIdPrefix,
    cases: request.cases.map((evaluationCase, index) =>
      validateAgentEvaluationCase(evaluationCase, index)
    )
  };
}

function validateAgentEvaluationCase(
  evaluationCase: AgentEvaluationCase,
  index: number
): AgentEvaluationCase {
  const id = typeof evaluationCase.id === "string" ? evaluationCase.id.trim() : "";
  const message =
    typeof evaluationCase.message === "string" ? evaluationCase.message.trim() : "";
  const model =
    typeof evaluationCase.model === "string" && evaluationCase.model.trim().length > 0
      ? evaluationCase.model.trim()
      : undefined;
  const sessionId =
    typeof evaluationCase.sessionId === "string" &&
    evaluationCase.sessionId.trim().length > 0
      ? evaluationCase.sessionId.trim()
      : undefined;

  if (id.length === 0) {
    throw new AppError(
      `Evaluation case ${index + 1} is missing an id`,
      "AGENT_EVALUATION_CASE_ID_REQUIRED",
      400,
      {
        index
      }
    );
  }

  if (message.length === 0) {
    throw new AppError(
      `Evaluation case ${id} is missing a message`,
      "AGENT_EVALUATION_CASE_MESSAGE_REQUIRED",
      400,
      {
        caseId: id
      }
    );
  }

  return {
    id,
    message,
    model,
    sessionId,
    expected: validateAgentEvaluationExpectations(evaluationCase.expected, id)
  };
}

function validateAgentEvaluationExpectations(
  expected: AgentEvaluationExpectations | undefined,
  caseId: string
): AgentEvaluationExpectations | undefined {
  if (!expected) {
    return undefined;
  }

  if (
    typeof expected.minToolCalls !== "undefined" &&
    (!Number.isInteger(expected.minToolCalls) || expected.minToolCalls < 0)
  ) {
    throw new AppError(
      "Evaluation minToolCalls must be a non-negative integer",
      "AGENT_EVALUATION_MIN_TOOL_CALLS_INVALID",
      400,
      {
        caseId,
        minToolCalls: expected.minToolCalls
      }
    );
  }

  if (
    typeof expected.maxToolCalls !== "undefined" &&
    (!Number.isInteger(expected.maxToolCalls) || expected.maxToolCalls < 0)
  ) {
    throw new AppError(
      "Evaluation maxToolCalls must be a non-negative integer",
      "AGENT_EVALUATION_MAX_TOOL_CALLS_INVALID",
      400,
      {
        caseId,
        maxToolCalls: expected.maxToolCalls
      }
    );
  }

  if (
    typeof expected.minToolCalls !== "undefined" &&
    typeof expected.maxToolCalls !== "undefined" &&
    expected.minToolCalls > expected.maxToolCalls
  ) {
    throw new AppError(
      "Evaluation minToolCalls cannot exceed maxToolCalls",
      "AGENT_EVALUATION_TOOL_CALL_RANGE_INVALID",
      400,
      {
        caseId,
        minToolCalls: expected.minToolCalls,
        maxToolCalls: expected.maxToolCalls
      }
    );
  }

  return {
    outputIncludes: validateEvaluationTextList(expected.outputIncludes, "outputIncludes", caseId),
    outputExcludes: validateEvaluationTextList(expected.outputExcludes, "outputExcludes", caseId),
    requiredToolNames: validateEvaluationTextList(
      expected.requiredToolNames,
      "requiredToolNames",
      caseId
    ),
    forbiddenToolNames: validateEvaluationTextList(
      expected.forbiddenToolNames,
      "forbiddenToolNames",
      caseId
    ),
    minToolCalls: expected.minToolCalls,
    maxToolCalls: expected.maxToolCalls
  };
}

function validateEvaluationTextList(
  values: readonly string[] | undefined,
  field: string,
  caseId: string
): readonly string[] | undefined {
  if (typeof values === "undefined") {
    return undefined;
  }

  if (!Array.isArray(values)) {
    throw new AppError(
      `Evaluation ${field} must be an array`,
      "AGENT_EVALUATION_TEXT_LIST_INVALID",
      400,
      {
        caseId,
        field
      }
    );
  }

  return values.map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AppError(
        `Evaluation ${field} contains an invalid value`,
        "AGENT_EVALUATION_TEXT_VALUE_INVALID",
        400,
        {
          caseId,
          field,
          index
        }
      );
    }

    return value.trim();
  });
}

function buildAgentEvaluationChecks(
  evaluationCase: AgentEvaluationCase,
  result: AgentTurnResult
): readonly AgentEvaluationCheckResult[] {
  const checks: AgentEvaluationCheckResult[] = [
    {
      name: "execution.succeeded",
      passed: true,
      expected: true,
      actual: true
    }
  ];
  const expected = evaluationCase.expected;

  if (!expected) {
    return checks;
  }

  const outputTextLower = result.outputText.toLowerCase();
  const toolNames = result.toolCalls.map((toolCall) => toolCall.toolName);

  for (const expectedText of expected.outputIncludes ?? []) {
    checks.push({
      name: `output.includes:${expectedText}`,
      passed: outputTextLower.includes(expectedText.toLowerCase()),
      expected: expectedText,
      actual: result.outputText
    });
  }

  for (const expectedText of expected.outputExcludes ?? []) {
    checks.push({
      name: `output.excludes:${expectedText}`,
      passed: !outputTextLower.includes(expectedText.toLowerCase()),
      expected: expectedText,
      actual: result.outputText
    });
  }

  for (const toolName of expected.requiredToolNames ?? []) {
    checks.push({
      name: `tool.required:${toolName}`,
      passed: toolNames.includes(toolName),
      expected: toolName,
      actual: toolNames
    });
  }

  for (const toolName of expected.forbiddenToolNames ?? []) {
    checks.push({
      name: `tool.forbidden:${toolName}`,
      passed: !toolNames.includes(toolName),
      expected: toolName,
      actual: toolNames
    });
  }

  if (typeof expected.minToolCalls === "number") {
    checks.push({
      name: "tool.minCalls",
      passed: result.toolCalls.length >= expected.minToolCalls,
      expected: expected.minToolCalls,
      actual: result.toolCalls.length
    });
  }

  if (typeof expected.maxToolCalls === "number") {
    checks.push({
      name: "tool.maxCalls",
      passed: result.toolCalls.length <= expected.maxToolCalls,
      expected: expected.maxToolCalls,
      actual: result.toolCalls.length
    });
  }

  return checks;
}

function normalizeObservationError(error: unknown): AgentObservationError {
  const appError = normalizeAgentError(error);

  return {
    message: appError.message,
    code: appError.code
  };
}

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw new AppError("Agent request was aborted", "AGENT_REQUEST_ABORTED", 499);
}

function createRequestAbortController(
  signal: AbortSignal | undefined,
  timeoutMs: number
): {
  readonly abortController: AbortController;
  dispose(): void;
} {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  const onAbort = () => abortController.abort();

  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    abortController,
    dispose: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function cloneSessionMessages(
  messages: readonly AgentSessionMessage[]
): AgentSessionMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function cloneStoredSession(session: StoredAgentSession): StoredAgentSession {
  return {
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: cloneSessionMessages(session.messages),
    ...(session.metadata ? { metadata: cloneSessionMetadata(session.metadata) } : {})
  };
}

function cloneSessionMetadata(
  metadata:
    | {
        readonly title?: string;
        readonly tags?: readonly string[];
        readonly forkedFromSessionId?: string;
      }
    | undefined
): StoredAgentSession["metadata"] {
  if (!metadata) {
    return undefined;
  }

  return {
    ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
    ...(Array.isArray(metadata.tags) ? { tags: [...metadata.tags] } : {}),
    ...(typeof metadata.forkedFromSessionId === "string"
      ? { forkedFromSessionId: metadata.forkedFromSessionId }
      : {})
  };
}

function mergeSessionMetadata(
  current:
    | {
        readonly title?: string;
        readonly tags?: readonly string[];
        readonly forkedFromSessionId?: string;
      }
    | undefined,
  update: AgentSessionMetadataUpdate
): StoredAgentSession["metadata"] {
  const nextTitle =
    typeof update.title === "undefined"
      ? current?.title
      : normalizeOptionalSessionText(update.title);
  const nextTags =
    typeof update.tags === "undefined" ? current?.tags : normalizeOptionalSessionTags(update.tags);
  const nextForkedFromSessionId = current?.forkedFromSessionId;

  if (!nextTitle && (!nextTags || nextTags.length === 0) && !nextForkedFromSessionId) {
    return undefined;
  }

  return {
    ...(nextTitle ? { title: nextTitle } : {}),
    ...(nextTags && nextTags.length > 0 ? { tags: nextTags } : {}),
    ...(nextForkedFromSessionId ? { forkedFromSessionId: nextForkedFromSessionId } : {})
  };
}

function buildForkSessionMetadata(
  source: StoredAgentSession,
  sourceSessionId: string,
  update: AgentSessionMetadataUpdate
): StoredAgentSession["metadata"] {
  const sourceMetadata = cloneSessionMetadata(source.metadata);
  const forkTitle =
    typeof update.title === "undefined"
      ? sourceMetadata?.title
        ? `${sourceMetadata.title} (fork)`
        : undefined
      : normalizeOptionalSessionText(update.title);
  const forkTags =
    typeof update.tags === "undefined"
      ? sourceMetadata?.tags
      : normalizeOptionalSessionTags(update.tags);

  if (!forkTitle && (!forkTags || forkTags.length === 0) && sourceSessionId.length === 0) {
    return undefined;
  }

  return {
    ...(forkTitle ? { title: forkTitle } : {}),
    ...(forkTags && forkTags.length > 0 ? { tags: forkTags } : {}),
    forkedFromSessionId: sourceSessionId
  };
}

function normalizeOptionalSessionText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalSessionTags(
  tags: readonly string[] | null | undefined
): readonly string[] | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];

  return normalized.length > 0 ? normalized : undefined;
}

function buildSessionRecord(
  sessionId: string,
  session: StoredAgentSession | undefined
): AgentSessionRecord | undefined {
  if (!session) {
    return undefined;
  }

  return {
    sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    ...(session.metadata?.title ? { title: session.metadata.title } : {}),
    ...(session.metadata?.tags?.length ? { tags: [...session.metadata.tags] } : {}),
    ...(session.metadata?.forkedFromSessionId
      ? { forkedFromSessionId: session.metadata.forkedFromSessionId }
      : {}),
    lastMessage:
      session.messages.length > 0
        ? {
            role: session.messages[session.messages.length - 1]!.role,
            content: session.messages[session.messages.length - 1]!.content
          }
        : undefined,
    messages: cloneSessionMessages(session.messages)
  };
}

function buildSessionSummaries(
  sessions: ReadonlyMap<string, StoredAgentSession>
): readonly AgentSessionSummary[] {
  return Array.from(sessions.entries())
    .sort(
      ([leftSessionId, leftSession], [rightSessionId, rightSession]) =>
        rightSession.updatedAt.localeCompare(leftSession.updatedAt) ||
        leftSessionId.localeCompare(rightSessionId)
    )
    .map(([sessionId, session]) => ({
      sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      ...(session.metadata?.title ? { title: session.metadata.title } : {}),
      ...(session.metadata?.tags?.length ? { tags: [...session.metadata.tags] } : {}),
      ...(session.metadata?.forkedFromSessionId
        ? { forkedFromSessionId: session.metadata.forkedFromSessionId }
        : {}),
      lastMessage:
        session.messages.length > 0
          ? {
              role: session.messages[session.messages.length - 1]!.role,
              content: session.messages[session.messages.length - 1]!.content
            }
          : undefined
    }));
}

function parsePersistedSessions(
  rawText: string,
  filePath: string
): {
  readonly version: 1 | 2;
  readonly sessions: Map<string, StoredAgentSession>;
} {
  let parsed: unknown;

  try {
    parsed = rawText.trim().length === 0 ? { sessions: {} } : JSON.parse(rawText);
  } catch (error) {
    throw new AppError("Session store file is not valid JSON", "INVALID_SESSION_STORE", 500, {
      filePath,
      error: safeErrorMessage(error)
    });
  }

  if (!isPlainObject(parsed)) {
    throw new AppError("Session store file must contain an object", "INVALID_SESSION_STORE", 500, {
      filePath
    });
  }

  const version = parsed.version;
  const sessions = parsed.sessions;

  if (!isPlainObject(sessions)) {
    throw new AppError("Session store file must contain a sessions object", "INVALID_SESSION_STORE", 500, {
      filePath
    });
  }

  const loadedSessions = new Map<string, StoredAgentSession>();
  const normalizedVersion = version === 2 ? 2 : 1;

  for (const [sessionId, rawSession] of Object.entries(sessions)) {
    if (normalizedVersion === 1) {
      if (!Array.isArray(rawSession) || !rawSession.every(isAgentSessionMessage)) {
        throw new AppError(
          "Session store file contains invalid messages",
          "INVALID_SESSION_STORE",
          500,
          {
            filePath,
            sessionId
          }
        );
      }

      const upgradedAt = new Date().toISOString();

      loadedSessions.set(sessionId, {
        createdAt: upgradedAt,
        updatedAt: upgradedAt,
        messages: cloneSessionMessages(rawSession)
      });
      continue;
    }

    if (!isStoredAgentSession(rawSession)) {
      throw new AppError("Session store file contains invalid sessions", "INVALID_SESSION_STORE", 500, {
        filePath,
        sessionId
      });
    }

    loadedSessions.set(sessionId, cloneStoredSession(rawSession));
  }

  return {
    version: normalizedVersion,
    sessions: loadedSessions
  };
}

function buildPersistedSessions(
  sessions: ReadonlyMap<string, StoredAgentSession>
): {
  readonly version: 2;
  readonly sessions: Readonly<Record<string, StoredAgentSession>>;
} {
  return {
    version: 2,
    sessions: Object.fromEntries(
      Array.from(sessions.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, session]) => [sessionId, cloneStoredSession(session)])
    )
  };
}

function buildConversationInput(
  instructions: string,
  history: readonly AgentSessionMessage[],
  message: string
): OpenAIInputItem[] {
  return [
    {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: instructions
        }
      ]
    },
    ...history.map((entry): OpenAIInputItem => ({
      type: "message",
      role: entry.role,
      content: [
        {
          type: entry.role === "assistant" ? "output_text" : "input_text",
          text: entry.content
        }
      ] as readonly {
        readonly type: "input_text" | "output_text";
        readonly text: string;
      }[]
    })),
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: message
        }
      ]
    }
  ];
}

function buildToolDefinitions(toolRegistry: ToolRegistry): readonly OpenAIFunctionTool[] {
  return toolRegistry.list().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters:
      tool.inputSchema ??
      ({
        type: "object",
        properties: {},
        additionalProperties: true
      } satisfies JsonSchema)
  }));
}

function tryExtractOutputText(response: OpenAIResponse): string | undefined {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const text = response.output
    .filter(
      (item): item is Extract<OpenAIOutputItem, { type: "message" }> => item.type === "message"
    )
    .flatMap((item) => item.content)
    .map((content) => extractMessageContentText(content))
    .join("")
    .trim();

  return text.length > 0 ? text : undefined;
}

function extractMessageContentText(content: { readonly type: string; readonly text?: string }): string {
  if (typeof content.text === "string") {
    return content.text;
  }

  const refusal = (content as { readonly refusal?: string }).refusal;

  return typeof refusal === "string" ? refusal : "";
}

function parseFunctionArguments(
  rawArguments: string,
  toolName: string
): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("arguments must be an object");
    }

    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new AppError("Invalid tool arguments from model", "INVALID_TOOL_ARGUMENTS", 502, {
      toolName,
      error: safeErrorMessage(error)
    });
  }
}

function governToolResultForModel(
  toolName: string,
  result: unknown,
  maxToolResultChars: number
): unknown {
  if (toolName === "query-sql" && isReadOnlyQueryLikeResult(result)) {
    return summarizeQueryToolResult(result, maxToolResultChars);
  }

  const serialized = safeStringify(result);

  if (serialized.length <= maxToolResultChars) {
    return result;
  }

  return {
    toolName,
    truncated: true,
    originalSerializedChars: serialized.length,
    preview: serialized.slice(0, Math.min(maxToolResultChars, DEFAULT_TOOL_RESULT_PREVIEW_CHARS)),
    note: "Tool output was truncated before being returned to the model context."
  };
}

function summarizeQueryToolResult(
  result: {
    readonly columns: readonly string[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number;
    readonly durationMs: number;
    readonly validation?: unknown;
  },
  maxToolResultChars: number
): unknown {
  const maxPreviewRows = Math.max(
    1,
    Math.min(DEFAULT_QUERY_RESULT_PREVIEW_ROWS, result.rows.length)
  );
  let previewRows = result.rows.slice(0, maxPreviewRows);
  let serialized = safeStringify({
    columns: result.columns,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    validation: result.validation,
    previewRows
  });

  while (previewRows.length > 1 && serialized.length > maxToolResultChars) {
    previewRows = previewRows.slice(0, Math.max(1, Math.floor(previewRows.length / 2)));
    serialized = safeStringify({
      columns: result.columns,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      validation: result.validation,
      previewRows
    });
  }

  if (serialized.length <= maxToolResultChars) {
    return {
      columns: result.columns,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      validation: result.validation,
      previewRows,
      previewRowCount: previewRows.length,
      truncated: previewRows.length < result.rows.length,
      omittedRowCount: Math.max(result.rows.length - previewRows.length, 0)
    };
  }

  return {
    columns: result.columns,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    validation: result.validation,
    truncated: true,
    note: "Query result rows were omitted because the serialized tool output exceeded the configured limit."
  };
}

function isReadOnlyQueryLikeResult(
  value: unknown
): value is {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly durationMs: number;
  readonly validation?: unknown;
} {
  return (
    isPlainObject(value) &&
    Array.isArray(value.columns) &&
    value.columns.every((column) => typeof column === "string") &&
    Array.isArray(value.rows) &&
    typeof value.rowCount === "number" &&
    typeof value.durationMs === "number"
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function getActiveToolCall(
  turn: MutableAgentActiveTurnObservation,
  callId: string
): MutableAgentToolCallObservation {
  const toolCall = turn.toolCalls.find((entry) => entry.callId === callId);

  if (!toolCall) {
    throw new AppError(`Unknown active tool call: ${callId}`, "AGENT_TOOL_CALL_NOT_FOUND", 404, {
      turnId: turn.turnId,
      callId
    });
  }

  return toolCall;
}

function cloneToolCallObservation(
  toolCall: MutableAgentToolCallObservation | AgentToolCallObservation
): AgentToolCallObservation {
  return {
    callId: toolCall.callId,
    toolName: toolCall.toolName,
    arguments: { ...toolCall.arguments },
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
    durationMs: toolCall.durationMs,
    status: toolCall.status,
    output: toolCall.output,
    error: toolCall.error
      ? {
          message: toolCall.error.message,
          code: toolCall.error.code
        }
      : undefined
  };
}

function cloneActiveTurnObservation(
  turn: MutableAgentActiveTurnObservation | AgentActiveTurnObservation
): AgentActiveTurnObservation {
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    model: turn.model,
    requestMessage: turn.requestMessage,
    startedAt: turn.startedAt,
    modelResponseCount: turn.modelResponseCount,
    toolCalls: turn.toolCalls.map((toolCall) => cloneToolCallObservation(toolCall))
  };
}

function cloneTurnObservation(turn: AgentTurnObservation): AgentTurnObservation {
  return {
    ...cloneActiveTurnObservation(turn),
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    status: turn.status,
    outputText: turn.outputText,
    outputTextChars: turn.outputTextChars,
    usage: turn.usage,
    error: turn.error
      ? {
          message: turn.error.message,
          code: turn.error.code
        }
      : undefined
  };
}

function isFunctionCallItem(
  item: OpenAIOutputItem
): item is Extract<OpenAIOutputItem, { type: "function_call" }> {
  return item.type === "function_call";
}

function* buildFallbackResponseEvents(
  response: OpenAIResponse
): Generator<OpenAIResponseStreamEvent, void, void> {
  const functionCalls = response.output.filter(isFunctionCallItem);

  if (functionCalls.length === 0) {
    const outputText = tryExtractOutputText(response);

    if (outputText) {
      for (const delta of chunkText(outputText)) {
        yield {
          type: "response.output_text.delta",
          delta
        };
      }
    }
  }

  yield {
    type: "response.completed",
    response
  };
}

function chunkText(text: string, chunkSize = 80): readonly string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }

  return chunks;
}

function isCompletedEvent(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "response.completed" }> {
  return event.type === "response.completed";
}

function isOutputTextDeltaStreamEvent(
  event: OpenAIResponseStreamEvent
): event is OpenAIResponseOutputTextDeltaEvent {
  return event.type === "response.output_text.delta" && typeof event.delta === "string";
}

function extractCompletedStreamResponse(
  event: OpenAIResponseStreamEvent
): OpenAIResponse | undefined {
  if (event.type !== "response.completed") {
    return undefined;
  }

  if (isOpenAIResponse((event as OpenAIResponseCompletedStreamEvent).response)) {
    return (event as OpenAIResponseCompletedStreamEvent).response;
  }

  if (isOpenAIResponse(event)) {
    return event;
  }

  throw new AppError(
    "OpenAI stream completed with an invalid response payload",
    "INVALID_OPENAI_STREAM_RESPONSE",
    502
  );
}

function buildSyntheticTextResponse(outputText: string): OpenAIResponse {
  return {
    id: `synthetic_stream_${Date.now()}`,
    output_text: outputText,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }]
      }
    ]
  };
}

function isFailedOpenAIStreamEvent(
  event: OpenAIResponseStreamEvent
): event is OpenAIResponseFailedStreamEvent | OpenAIErrorStreamEvent {
  return event.type === "response.failed" || event.type === "error";
}

function buildOpenAIStreamEventError(event: OpenAIResponseFailedStreamEvent | OpenAIErrorStreamEvent): AppError {
  const details = extractOpenAIStreamErrorDetails(event);

  return new AppError(details.message, details.code, 502, {
    eventType: event.type
  });
}

function isRetryableOpenAIStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

function isRetryableOpenAIError(error: AppError): boolean {
  return error.statusCode === 504 || error.statusCode === 502 || isRetryableOpenAIStatus(error.statusCode);
}

function normalizeAgentError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (isUnavailableModelChannelError(error.message, error.code)) {
      return new AppError(
        buildUnavailableModelChannelMessage(error.message),
        "OPENAI_MODEL_CHANNEL_UNAVAILABLE",
        error.statusCode,
        error.details
      );
    }

    return error;
  }

  return new AppError("Agent execution failed", "AGENT_EXECUTION_FAILED", 500, {
    error: safeErrorMessage(error)
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentSessionMessage(value: unknown): value is AgentSessionMessage {
  return (
    isPlainObject(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string"
  );
}

function isStoredAgentSession(value: unknown): value is StoredAgentSession {
  return (
    isPlainObject(value) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isAgentSessionMessage) &&
    (typeof value.metadata === "undefined" || isStoredSessionMetadata(value.metadata))
  );
}

function isStoredSessionMetadata(
  value: unknown
): value is NonNullable<StoredAgentSession["metadata"]> {
  return (
    isPlainObject(value) &&
    (typeof value.title === "undefined" || typeof value.title === "string") &&
    (typeof value.forkedFromSessionId === "undefined" ||
      typeof value.forkedFromSessionId === "string") &&
    (typeof value.tags === "undefined" ||
      (Array.isArray(value.tags) && value.tags.every((entry) => typeof entry === "string")))
  );
}

function isOpenAIResponse(value: unknown): value is OpenAIResponse {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.output)
  );
}

async function buildOpenAIHttpError(
  response: Response,
  payload?: Partial<OpenAIResponse>
): Promise<AppError> {
  const errorPayload =
    payload && isPlainObject(payload) ? payload : await parseOpenAIErrorPayload(response);
  const errorDetails = extractOpenAIErrorDetails(errorPayload);

  return new AppError(
    errorDetails.message,
    errorDetails.code,
    response.status
  );
}

async function parseOpenAIErrorPayload(
  response: Response
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const responseText = await response.text();

  if (responseText.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseText) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return {
      error: {
        message: responseText
      }
    };
  }
}

function extractOpenAIErrorDetails(
  payload: unknown
): {
  readonly message: string;
  readonly code: string;
} {
  if (!isPlainObject(payload)) {
    return {
      message: "OpenAI request failed",
      code: "OPENAI_RESPONSE_ERROR"
    };
  }

  const nestedError = isPlainObject(payload.error) ? payload.error : undefined;
  const message =
    (typeof nestedError?.message === "string" && nestedError.message.trim().length > 0
      ? nestedError.message
      : typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : "OpenAI request failed");
  const code =
    (typeof nestedError?.code === "string" && nestedError.code.trim().length > 0
      ? nestedError.code
      : typeof payload.code === "string" && payload.code.trim().length > 0
        ? payload.code
        : "OPENAI_RESPONSE_ERROR");

  if (isUnavailableModelChannelError(message, code)) {
    return {
      message: buildUnavailableModelChannelMessage(message),
      code: "OPENAI_MODEL_CHANNEL_UNAVAILABLE"
    };
  }

  return {
    message,
    code
  };
}

function extractOpenAIStreamErrorDetails(
  payload: unknown
): {
  readonly message: string;
  readonly code: string;
} {
  if (!isPlainObject(payload)) {
    return {
      message: "OpenAI streaming request failed",
      code: "OPENAI_STREAM_ERROR"
    };
  }

  const directError = isPlainObject(payload.error) ? payload.error : undefined;
  const nestedResponse = isPlainObject(payload.response) ? payload.response : undefined;
  const nestedError = isPlainObject(nestedResponse?.error) ? nestedResponse.error : undefined;
  const error = directError ?? nestedError;
  const message =
    typeof error?.message === "string" && error.message.trim().length > 0
      ? error.message
      : "OpenAI streaming request failed";
  const code =
    typeof error?.code === "string" && error.code.trim().length > 0
      ? error.code
      : "OPENAI_STREAM_ERROR";

  if (isUnavailableModelChannelError(message, code)) {
    return {
      message: buildUnavailableModelChannelMessage(message),
      code: "OPENAI_MODEL_CHANNEL_UNAVAILABLE"
    };
  }

  return {
    message,
    code
  };
}

function isUnavailableModelChannelError(message: string, code: string): boolean {
  return (
    code === "model_not_found" &&
    /no available channel for model/i.test(message)
  );
}

function buildUnavailableModelChannelMessage(upstreamMessage: string): string {
  return `The configured upstream model is not available in the current provider group. Update OPENAI_MODEL, OPENAI_ENDPOINT, or the API key/channel configuration. Upstream message: ${upstreamMessage}`;
}

function normalizeOpenAITransportError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (isUnavailableModelChannelError(error.message, error.code)) {
      return new AppError(
        buildUnavailableModelChannelMessage(error.message),
        "OPENAI_MODEL_CHANNEL_UNAVAILABLE",
        error.statusCode,
        error.details
      );
    }

    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new AppError("OpenAI request timed out", "OPENAI_TIMEOUT", 504);
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("Agent request was aborted", "AGENT_REQUEST_ABORTED", 499);
  }

  return new AppError("OpenAI request failed", "OPENAI_REQUEST_FAILED", 502, {
    error: safeErrorMessage(error)
  });
}

async function* parseOpenAIResponseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIResponseStreamEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r/g, "");

      while (true) {
        const boundaryIndex = buffer.indexOf("\n\n");

        if (boundaryIndex === -1) {
          break;
        }

        const chunk = buffer.slice(0, boundaryIndex).trim();
        buffer = buffer.slice(boundaryIndex + 2);

        if (chunk.length === 0) {
          continue;
        }

        const event = parseOpenAIStreamChunk(chunk);

        if (event) {
          yield event;
        }
      }
    }

    const trailing = buffer.trim();

    if (trailing.length > 0) {
      const event = parseOpenAIStreamChunk(trailing);

      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOpenAIStreamChunk(chunk: string): OpenAIResponseStreamEvent | undefined {
  const lines = chunk.split("\n");
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line[5] === " " ? line.slice(6) : line.slice(5)));

  if (dataLines.length === 0) {
    if (isIgnorableSseChunk(lines)) {
      return undefined;
    }

    throw new AppError("Malformed OpenAI SSE payload", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk
    });
  }

  const rawData = dataLines.join("\n").trim();

  if (rawData === "[DONE]") {
    return undefined;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawData);
  } catch (error) {
    throw new AppError("Invalid JSON in OpenAI SSE payload", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk,
      error: safeErrorMessage(error)
    });
  }

  if (!isPlainObject(payload) || typeof payload.type !== "string") {
    throw new AppError("OpenAI SSE payload is missing a type", "INVALID_OPENAI_STREAM_EVENT", 502, {
      chunk
    });
  }

  if (eventName && payload.type !== eventName) {
    throw new AppError("OpenAI SSE event type mismatch", "INVALID_OPENAI_STREAM_EVENT", 502, {
      eventName,
      payloadType: payload.type
    });
  }

  return payload as OpenAIResponseStreamEvent;
}

function isIgnorableSseChunk(lines: readonly string[]): boolean {
  return lines.every((line) => {
    const trimmed = line.trim();

    return (
      trimmed.length === 0 ||
      trimmed.startsWith(":") ||
      trimmed.startsWith("event:") ||
      trimmed.startsWith("id:") ||
      trimmed.startsWith("retry:")
    );
  });
}

export function resolveResponsesApiEndpoint(endpoint: string): string {
  const normalized = endpoint.trim();

  if (normalized.length === 0) {
    return "https://api.openai.com/v1/responses";
  }

  if (normalized.endsWith("/responses")) {
    return normalized;
  }

  return `${normalized.replace(/\/+$/, "")}/responses`;
}

export function buildAgentManifest(manifest: AgentManifest): {
  projectName: string;
  currentGoal: string;
  nextPriority: string;
  rules: readonly string[];
  summary: string;
} {
  const parsed = AgentManifestSchema.safeParse(manifest);

  if (!parsed.success) {
    throw new AppError("Invalid agent manifest", "INVALID_AGENT_MANIFEST", 400, {
      issues: parsed.error.issues
    });
  }

  const [nextPriority] = parsed.data.priorities;

  return {
    projectName: parsed.data.projectName,
    currentGoal: parsed.data.currentGoal,
    nextPriority,
    rules: parsed.data.rules,
    summary: `${parsed.data.projectName}: ${parsed.data.currentGoal}`
  };
}
