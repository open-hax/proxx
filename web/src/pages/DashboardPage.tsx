import { useEffect, useMemo, useState } from "react";

import {
  getUsageOverview,
  listCredentials,
  listRequestLogs,
  type KeyPoolStatus,
  type RequestLogEntry,
  type UsageAccountSummary,
  type UsageOverview,
} from "../lib/api";

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatServiceTier(entry: RequestLogEntry): string {
  if (!entry.serviceTier) {
    return "Standard";
  }

  if (entry.serviceTierSource === "fast_mode") {
    return "Fast mode";
  }

  if (entry.serviceTier === "priority") {
    return "Priority";
  }

  return entry.serviceTier.replace(/[_-]+/g, " ");
}

function metricTone(value: number, inverse = false): string {
  if (value <= 0) {
    return "dashboard-metric-neutral";
  }

  if (inverse) {
    return value >= 5 ? "dashboard-metric-danger" : value >= 1 ? "dashboard-metric-warn" : "dashboard-metric-good";
  }

  return value >= 1 ? "dashboard-metric-good" : "dashboard-metric-neutral";
}

function miniBars(values: readonly { readonly t: string; readonly v: number }[]): JSX.Element {
  const max = values.reduce((current, point) => Math.max(current, point.v), 0);
  return (
    <div className="dashboard-sparkbars" aria-hidden="true">
      {values.map((point) => {
        const height = max > 0 ? Math.max((point.v / max) * 100, 8) : 8;
        return <span key={point.t} style={{ height: `${height}%` }} />;
      })}
    </div>
  );
}

function donutSegments(accounts: readonly UsageAccountSummary[]): JSX.Element {
  const total = accounts.reduce((sum, account) => sum + account.totalTokens, 0);
  if (total <= 0) {
    return <div className="dashboard-donut-empty">No token activity yet</div>;
  }

  let offset = 0;
  return (
    <svg viewBox="0 0 120 120" className="dashboard-donut-chart" aria-hidden="true">
      <circle cx="60" cy="60" r="42" className="dashboard-donut-track" />
      {accounts.slice(0, 6).map((account, index) => {
        const share = account.totalTokens / total;
        const length = share * 264;
        const element = (
          <circle
            key={`${account.providerId}-${account.accountId}`}
            cx="60"
            cy="60"
            r="42"
            className={`dashboard-donut-segment dashboard-donut-segment-${index % 6}`}
            strokeDasharray={`${length} 264`}
            strokeDashoffset={-offset}
          />
        );
        offset += length;
        return element;
      })}
    </svg>
  );
}

function serviceTierShareBars(summary: UsageOverview["summary"]): JSX.Element {
  const tiers = [
    { label: "Fast mode", value: summary.serviceTierRequests24h.fastMode, className: "dashboard-tier-fast_mode" },
    { label: "Priority", value: summary.serviceTierRequests24h.priority, className: "dashboard-tier-explicit" },
    { label: "Standard", value: summary.serviceTierRequests24h.standard, className: "dashboard-tier-none" },
  ];
  const total = tiers.reduce((sum, tier) => sum + tier.value, 0);

  if (total <= 0) {
    return <div className="dashboard-account-empty">No tiered request activity yet.</div>;
  }

  return (
    <div className="dashboard-tier-summary">
      {tiers.map((tier) => {
        const percent = total > 0 ? (tier.value / total) * 100 : 0;
        return (
          <div key={tier.label} className="dashboard-tier-summary-row">
            <div className="dashboard-tier-summary-labels">
              <strong>{tier.label}</strong>
              <small>{formatCompactNumber(tier.value)} req · {formatPercent(percent)}</small>
            </div>
            <div className="dashboard-tier-summary-track" aria-hidden="true">
              <span className={`dashboard-tier-summary-fill ${tier.className}`} style={{ width: `${Math.max(percent, tier.value > 0 ? 6 : 0)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [keyPoolStatuses, setKeyPoolStatuses] = useState<Record<string, KeyPoolStatus>>({});
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextOverview, credentials, nextLogs] = await Promise.all([
          getUsageOverview(),
          listCredentials(false),
          listRequestLogs({ limit: 12 }),
        ]);
        if (!cancelled) {
          setOverview(nextOverview);
          setKeyPoolStatuses(credentials.keyPoolStatuses);
          setRequestLogs(nextLogs);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const topAccounts = useMemo(() => overview?.accounts.slice(0, 6) ?? [], [overview]);
  const recentAccounts = useMemo(() => (overview?.accounts ?? []).slice(0, 10), [overview]);
  const providerStatuses = useMemo(() => Object.values(keyPoolStatuses).sort((a, b) => a.providerId.localeCompare(b.providerId)), [keyPoolStatuses]);

  return (
    <div className="dashboard-layout">
      <section className="dashboard-hero panel-sheen">
        <div>
          <p className="dashboard-kicker">Single Proxy Control Tower</p>
          <h2>Codex usage visibility without leaving your proxy.</h2>
          <p>
            Watch request volume, token burn, account health, and recent traffic from the same OpenAI-compatible edge.
          </p>
        </div>
        <div className="dashboard-hero-meta">
          <span>Updated {formatDate(overview?.generatedAt ?? null)}</span>
          <span>Auto-refresh every 30s</span>
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}

      <section className="dashboard-metrics-grid">
        <article className={`dashboard-metric-card ${metricTone(overview?.summary.requests24h ?? 0)}`}>
          <span>Requests / 24h</span>
          <strong>{loading ? "..." : formatCompactNumber(overview?.summary.requests24h ?? 0)}</strong>
          {overview ? miniBars(overview.trends.requests) : <div className="dashboard-sparkbars dashboard-sparkbars-placeholder" />}
        </article>
        <article className={`dashboard-metric-card ${metricTone(overview?.summary.tokens24h ?? 0)}`}>
          <span>Tokens / 24h</span>
          <strong>{loading ? "..." : formatCompactNumber(overview?.summary.tokens24h ?? 0)}</strong>
          <small>
            In {formatCompactNumber(overview?.summary.promptTokens24h ?? 0)} / Out {formatCompactNumber(overview?.summary.completionTokens24h ?? 0)}
          </small>
        </article>
        <article className={`dashboard-metric-card ${metricTone(overview?.summary.errorRate24h ?? 0, true)}`}>
          <span>Error Rate</span>
          <strong>{loading ? "..." : formatPercent(overview?.summary.errorRate24h ?? 0)}</strong>
          {overview ? miniBars(overview.trends.errors) : <div className="dashboard-sparkbars dashboard-sparkbars-placeholder" />}
        </article>
        <article className={`dashboard-metric-card ${metricTone(overview?.summary.activeAccounts ?? 0)}`}>
          <span>Active Accounts</span>
          <strong>{loading ? "..." : formatCompactNumber(overview?.summary.activeAccounts ?? 0)}</strong>
          <small>
            Top model {overview?.summary.topModel ?? "-"} · Top provider {overview?.summary.topProvider ?? "-"}
          </small>
        </article>
      </section>

      <section className="dashboard-detail-grid">
        <article className="dashboard-panel panel-sheen">
          <header className="dashboard-panel-header">
            <div>
              <h3>Account Token Share</h3>
              <p>Who is carrying the last 24h load.</p>
            </div>
          </header>
          <div className="dashboard-donut-wrap">
            {donutSegments(topAccounts)}
            <div className="dashboard-donut-legend">
              {topAccounts.map((account, index) => (
                <div key={`${account.providerId}-${account.accountId}`} className="dashboard-legend-row">
                  <span className={`dashboard-legend-swatch dashboard-donut-segment-${index % 6}`} />
                  <div>
                    <strong>{account.displayName}</strong>
                    <small>{formatCompactNumber(account.totalTokens)} tokens</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </article>

        <article className="dashboard-panel panel-sheen">
          <header className="dashboard-panel-header">
            <div>
              <h3>Service Tier Mix</h3>
              <p>How the last 24h request volume splits across fast mode, priority, and standard traffic.</p>
            </div>
          </header>
          {overview ? serviceTierShareBars(overview.summary) : <div className="dashboard-account-empty">Loading tier mix…</div>}
        </article>
      </section>

      <section className="dashboard-panel panel-sheen">
        <header className="dashboard-panel-header">
          <div>
            <h3>Traffic Trend</h3>
            <p>Hourly request and token movement.</p>
          </div>
        </header>
        <div className="dashboard-trend-grid">
          <div>
            <span className="dashboard-chart-label">Requests</span>
            {overview ? miniBars(overview.trends.requests) : <div className="dashboard-sparkbars dashboard-sparkbars-placeholder" />}
          </div>
          <div>
            <span className="dashboard-chart-label">Tokens</span>
            {overview ? miniBars(overview.trends.tokens) : <div className="dashboard-sparkbars dashboard-sparkbars-placeholder" />}
          </div>
        </div>
      </section>

      <section className="dashboard-detail-grid dashboard-detail-grid-wide">
        <article className="dashboard-panel panel-sheen">
          <header className="dashboard-panel-header">
            <div>
              <h3>Provider Pool Status</h3>
              <p>Availability, cooldown pressure, and account counts per upstream provider.</p>
            </div>
          </header>
          <div className="dashboard-provider-grid">
            {providerStatuses.length === 0 ? (
              <div className="dashboard-account-empty">No provider status available yet.</div>
            ) : providerStatuses.map((status) => (
              <article key={status.providerId} className="dashboard-provider-card">
                <div className="dashboard-provider-card-header">
                  <strong>{status.providerId}</strong>
                  <span className={`dashboard-status-pill dashboard-status-${status.cooldownAccounts > 0 ? "cooldown" : "healthy"}`}>
                    {status.authType}
                  </span>
                </div>
                <dl>
                  <div><dt>Total</dt><dd>{formatCompactNumber(status.totalAccounts)}</dd></div>
                  <div><dt>Available</dt><dd>{formatCompactNumber(status.availableAccounts)}</dd></div>
                  <div><dt>Cooling Down</dt><dd>{formatCompactNumber(status.cooldownAccounts)}</dd></div>
                  <div><dt>Ready In</dt><dd>{status.nextReadyInMs > 0 ? `${Math.ceil(status.nextReadyInMs / 1000)}s` : "now"}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </article>

        <article className="dashboard-panel panel-sheen">
          <header className="dashboard-panel-header">
            <div>
              <h3>Recent Request Log</h3>
              <p>The last few upstream attempts, useful for spotting fallback churn and model failures.</p>
            </div>
          </header>
          <div className="dashboard-log-table">
            <div className="dashboard-log-header">
              <span>When</span>
              <span>Provider</span>
              <span>Model</span>
              <span>Tier</span>
              <span>Status</span>
              <span>Latency</span>
            </div>
            {requestLogs.length === 0 ? (
              <div className="dashboard-account-empty">No request log entries yet.</div>
            ) : requestLogs.map((entry) => (
              <div key={entry.id} className="dashboard-log-row">
                <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                <span>{entry.providerId}/{entry.accountId}</span>
                <span>{entry.model}</span>
                <span className={`dashboard-status-pill dashboard-tier-pill dashboard-tier-${entry.serviceTierSource}`}>
                  {formatServiceTier(entry)}
                </span>
                <span className={`dashboard-status-pill dashboard-status-${entry.status >= 400 ? "cooldown" : "healthy"}`}>{entry.status}</span>
                <span>{Math.round(entry.latencyMs)} ms</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-panel panel-sheen">
        <header className="dashboard-panel-header">
          <div>
            <h3>Account Health</h3>
            <p>Recent load, token totals, and cooldown state across connected accounts.</p>
          </div>
        </header>
        <div className="dashboard-account-table">
          <div className="dashboard-account-table-header">
            <span>Account</span>
            <span>Status</span>
            <span>Requests</span>
            <span>Tokens</span>
            <span>Last Seen</span>
          </div>
          {recentAccounts.length === 0 ? (
            <div className="dashboard-account-empty">No request log activity yet.</div>
          ) : (
            recentAccounts.map((account) => (
              <div key={`${account.providerId}-${account.accountId}`} className="dashboard-account-row">
                <div>
                  <strong>{account.displayName}</strong>
                  <small>{account.authType}</small>
                </div>
                <span className={`dashboard-status-pill dashboard-status-${account.status}`}>{account.status}</span>
                <span>{formatCompactNumber(account.requestCount)}</span>
                <span>{formatCompactNumber(account.totalTokens)}</span>
                <span>{formatDate(account.lastUsedAt)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
