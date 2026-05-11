import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createLogger, safeErrorMessage } from "@clusterdata/shared";
import { requestJson } from "./api.js";

interface OverviewResponse {
  ok: boolean;
  manifest: {
    projectName: string;
    currentGoal: string;
    nextPriority: string;
    rules: readonly string[];
    summary: string;
  };
  metadata: {
    tableCount: number;
    columnCount: number;
    relationCount: number;
  };
  tools: readonly { name: string; description: string }[];
  security: { allowed: boolean; reason?: string };
}

interface SeriesResponse {
  summary: {
    count: number;
    minimum: number;
    maximum: number;
    average: number;
    trend: "flat" | "rising" | "falling";
  };
}

interface SqlResponse {
  allowed: boolean;
  normalizedSql: string;
  reason?: string;
}

const logger = createLogger("web");

function Panel({
  title,
  children
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function AppShell({
  overview,
  sqlResult,
  seriesResult,
  errorMessage
}: {
  readonly overview: OverviewResponse | null;
  readonly sqlResult: SqlResponse | null;
  readonly seriesResult: SeriesResponse | null;
  readonly errorMessage: string | null;
}): ReactElement {
  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">ClusterDataAgent</p>
          <h1>Monorepo control surface</h1>
        </div>
        <p className="status">{overview ? "connected" : "loading"}</p>
      </header>

      {errorMessage ? <p className="error">{errorMessage}</p> : null}

      <div className="grid">
        <Panel title="Overview">
          {overview ? (
            <dl className="kv">
              <div>
                <dt>Goal</dt>
                <dd>{overview.manifest.currentGoal}</dd>
              </div>
              <div>
                <dt>Next</dt>
                <dd>{overview.manifest.nextPriority}</dd>
              </div>
              <div>
                <dt>Tables</dt>
                <dd>{overview.metadata.tableCount}</dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>{overview.tools.length}</dd>
              </div>
            </dl>
          ) : (
            <p>Loading workspace summary...</p>
          )}
        </Panel>

        <Panel title="SQL Guard">
          {sqlResult ? (
            <pre>{JSON.stringify(sqlResult, null, 2)}</pre>
          ) : (
            <p>Waiting for validation output.</p>
          )}
        </Panel>

        <Panel title="Series Summary">
          {seriesResult ? (
            <pre>{JSON.stringify(seriesResult.summary, null, 2)}</pre>
          ) : (
            <p>Waiting for series analysis.</p>
          )}
        </Panel>

        <Panel title="Prompt Rules">
          <ul className="list">
            {overview?.manifest.rules.map((rule) => <li key={rule}>{rule}</li>) ??
              null}
          </ul>
        </Panel>
      </div>
    </main>
  );
}

export default function App(): ReactElement {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [sqlResult, setSqlResult] = useState<SqlResponse | null>(null);
  const [seriesResult, setSeriesResult] = useState<SeriesResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const payload = await requestJson<OverviewResponse>("/api/overview");
        setOverview(payload);
      } catch (error) {
        const message = safeErrorMessage(error);
        logger.error("failed to load overview", { error: message });
        setErrorMessage(message);
      }
    };

    void load();
  }, []);

  const actions = useMemo(
    () => ({
      validateSql: async () => {
        try {
          const payload = await requestJson<SqlResponse>("/api/sql/validate", {
            method: "POST",
            body: JSON.stringify({ sql: "select * from orders" })
          });
          setSqlResult(payload);
        } catch (error) {
          const message = safeErrorMessage(error);
          logger.error("sql validation failed", { error: message });
          setErrorMessage(message);
        }
      },
      summarizeSeries: async () => {
        try {
          const payload = await requestJson<SeriesResponse>("/api/analysis/series", {
            method: "POST",
            body: JSON.stringify({ points: [1, 2, 3, 4, 8] })
          });
          setSeriesResult(payload);
        } catch (error) {
          const message = safeErrorMessage(error);
          logger.error("series summary failed", { error: message });
          setErrorMessage(message);
        }
      }
    }),
    []
  );

  useEffect(() => {
    void actions.validateSql();
    void actions.summarizeSeries();
  }, [actions]);

  return (
    <AppShell
      overview={overview}
      sqlResult={sqlResult}
      seriesResult={seriesResult}
      errorMessage={errorMessage}
    />
  );
}
