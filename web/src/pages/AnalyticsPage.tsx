import { useEffect, useMemo, useState } from "react";

import { DataTableShell, FilterToolbar, Input, MetricTile, MetricTileGrid, PanelHeader, SurfaceHero, Tabs, type DataTableColumn, type TabItem } from "@open-hax/uxx";
import { getProviderModelAnalytics, type AnalyticsRow, type ProviderModelAnalytics } from "../lib/api";
import { useStoredState } from "../lib/use-stored-state";

const LS_ANALYTICS_WINDOW = "open-hax-proxy.ui.analytics.window";
const LS_ANALYTICS_SORT = "open-hax-proxy.ui.analytics.sort";
const LS_ANALYTICS_PROVIDER = "open-hax-proxy.ui.analytics.provider";
const LS_ANALYTICS_MODEL = "open-hax-proxy.ui.analytics.model";

function validateWindow(value: unknown): "daily" | "weekly" | "monthly" | undefined {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : undefined;
}

function validateSort(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return ["suitability", "tokens", "requests", "ttft", "tps", "decode-tps", "e2e-tps", "errors", "cost"].includes(normalized)
    ? normalized
    : undefined;
}

function validateString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatWater(ml: number): string {
  if (ml >= 1000) return `${(ml / 1000).toFixed(2)} L`;
  if (ml >= 1) return `${ml.toFixed(1)} mL`;
  if (ml >= 0.001) return `${(ml * 1000).toFixed(1)} uL`;
  return `${ml.toFixed(4)} mL`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatMaybeMs(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "-";
}

function formatMaybeTps(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} t/s` : "-";
}

function formatMaybeSuitability(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "-";
}

function rowLabel(row: AnalyticsRow): string {
  return row.model ?? row.providerId ?? "-";
}

const modelColumns: DataTableColumn<AnalyticsRow>[] = [
  { key: 'model', header: 'Model' },
  { key: 'providers', header: 'Providers', render: (row) => formatCompactNumber(row.providerCoverageCount ?? 0) },
  { key: 'suitability', header: 'Suitability', render: (row) => formatMaybeSuitability(row.suitabilityScore) },
  { key: 'confidence', header: 'Confidence', render: (row) => formatMaybeSuitability(row.confidenceScore) },
  { key: 'ttft', header: 'Avg TTFT', render: (row) => formatMaybeMs(row.avgTtftMs) },
  { key: 'decodeTps', header: 'Decode TPS', render: (row) => formatMaybeTps(row.avgDecodeTps) },
  { key: 'e2eTps', header: 'End-to-End TPS', render: (row) => formatMaybeTps(row.avgEndToEndTps) },
  { key: 'errorRate', header: 'Error Rate', render: (row) => formatPercent(row.errorRate) },
  { key: 'cacheHit', header: 'Cache Hit', render: (row) => formatPercent(row.cacheHitRate) },
  { key: 'cachedTokens', header: 'Cached Tokens', render: (row) => formatCompactNumber(row.cachedPromptTokens) },
  { key: 'requests', header: 'Requests', render: (row) => formatCompactNumber(row.requestCount) },
  { key: 'tokens', header: 'Tokens', render: (row) => formatCompactNumber(row.totalTokens) },
  { key: 'cost', header: 'Est. Cost', render: (row) => formatUsd(row.costUsd) },
];

const providerColumns: DataTableColumn<AnalyticsRow>[] = [
  { key: 'providerId', header: 'Provider' },
  { key: 'models', header: 'Models', render: (row) => formatCompactNumber(row.modelCoverageCount ?? 0) },
  { key: 'suitability', header: 'Suitability', render: (row) => formatMaybeSuitability(row.suitabilityScore) },
  { key: 'confidence', header: 'Confidence', render: (row) => formatMaybeSuitability(row.confidenceScore) },
  { key: 'ttft', header: 'Avg TTFT', render: (row) => formatMaybeMs(row.avgTtftMs) },
  { key: 'decodeTps', header: 'Decode TPS', render: (row) => formatMaybeTps(row.avgDecodeTps) },
  { key: 'e2eTps', header: 'End-to-End TPS', render: (row) => formatMaybeTps(row.avgEndToEndTps) },
  { key: 'errorRate', header: 'Error Rate', render: (row) => formatPercent(row.errorRate) },
  { key: 'cacheHit', header: 'Cache Hit', render: (row) => formatPercent(row.cacheHitRate) },
  { key: 'cachedTokens', header: 'Cached Tokens', render: (row) => formatCompactNumber(row.cachedPromptTokens) },
  { key: 'requests', header: 'Requests', render: (row) => formatCompactNumber(row.requestCount) },
  { key: 'tokens', header: 'Tokens', render: (row) => formatCompactNumber(row.totalTokens) },
  { key: 'cost', header: 'Est. Cost', render: (row) => formatUsd(row.costUsd) },
];

const pairColumns: DataTableColumn<AnalyticsRow>[] = [
  { key: 'providerId', header: 'Provider' },
  { key: 'model', header: 'Model' },
  { key: 'suitability', header: 'Suitability', render: (row) => formatMaybeSuitability(row.suitabilityScore) },
  { key: 'confidence', header: 'Confidence', render: (row) => formatMaybeSuitability(row.confidenceScore) },
  { key: 'ttft', header: 'Avg TTFT', render: (row) => formatMaybeMs(row.avgTtftMs) },
  { key: 'decodeTps', header: 'Decode TPS', render: (row) => formatMaybeTps(row.avgDecodeTps) },
  { key: 'e2eTps', header: 'End-to-End TPS', render: (row) => formatMaybeTps(row.avgEndToEndTps) },
  { key: 'errorRate', header: 'Error Rate', render: (row) => formatPercent(row.errorRate) },
  { key: 'cacheHit', header: 'Cache Hit', render: (row) => formatPercent(row.cacheHitRate) },
  { key: 'cachedTokens', header: 'Cached Tokens', render: (row) => formatCompactNumber(row.cachedPromptTokens) },
  { key: 'requests', header: 'Requests', render: (row) => formatCompactNumber(row.requestCount) },
  { key: 'tokens', header: 'Tokens', render: (row) => formatCompactNumber(row.totalTokens) },
  { key: 'cost', header: 'Est. Cost', render: (row) => formatUsd(row.costUsd) },
  { key: 'water', header: 'Water', render: (row) => formatWater(row.waterEvaporatedMl) },
  { key: 'lastSeen', header: 'Last Seen', render: (row) => formatDate(row.lastSeenAt) },
];

export function AnalyticsPage(): JSX.Element {
  const [windowValue, setWindowValue] = useStoredState<"daily" | "weekly" | "monthly">(
    LS_ANALYTICS_WINDOW,
    "weekly",
    validateWindow,
  );
  const [sort, setSort] = useStoredState(LS_ANALYTICS_SORT, "suitability", validateSort);
  const [providerFocus, setProviderFocus] = useStoredState(LS_ANALYTICS_PROVIDER, "", validateString);
  const [modelFocus, setModelFocus] = useStoredState(LS_ANALYTICS_MODEL, "", validateString);
  const [modelSearch, setModelSearch] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [analytics, setAnalytics] = useState<ProviderModelAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = await getProviderModelAnalytics(sort, windowValue);
        if (!cancelled) {
          setAnalytics(payload);
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
  }, [sort, windowValue]);

  const providerOptions = useMemo(() =>
    (analytics?.providers ?? [])
      .map((row) => row.providerId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
    [analytics],
  );

  const modelOptions = useMemo(() =>
    (analytics?.models ?? [])
      .map((row) => row.model)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
    [analytics],
  );

  useEffect(() => {
    if (providerFocus && !providerOptions.includes(providerFocus)) {
      setProviderFocus("");
    }
  }, [providerFocus, providerOptions, setProviderFocus]);

  useEffect(() => {
    if (modelFocus && !modelOptions.includes(modelFocus)) {
      setModelFocus("");
    }
  }, [modelFocus, modelOptions, setModelFocus]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return analytics?.models ?? [];
    }

    return (analytics?.models ?? []).filter((row) => rowLabel(row).toLowerCase().includes(query));
  }, [analytics, modelSearch]);

  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) {
      return analytics?.providers ?? [];
    }

    return (analytics?.providers ?? []).filter((row) => rowLabel(row).toLowerCase().includes(query));
  }, [analytics, providerSearch]);

  const filteredPairs = useMemo(() => {
    return (analytics?.providerModels ?? []).filter((row) => {
      if (providerFocus && row.providerId !== providerFocus) {
        return false;
      }
      if (modelFocus && row.model !== modelFocus) {
        return false;
      }
      return true;
    });
  }, [analytics, providerFocus, modelFocus]);

  const topModel = analytics?.models[0] ?? null;
  const topProvider = analytics?.providers[0] ?? null;

  const analyticsTabs = useMemo<readonly TabItem[]>(() => [
    {
      id: "models",
      label: "Models",
      badge: String(filteredModels.length),
      content: (
        <DataTableShell
          columns={modelColumns}
          rows={filteredModels}
          rowKey={(row) => `model-${row.model}`}
          emptyState="No models match the current filters."
        />
      ),
    },
    {
      id: "providers",
      label: "Providers",
      badge: String(filteredProviders.length),
      content: (
        <DataTableShell
          columns={providerColumns}
          rows={filteredProviders}
          rowKey={(row) => `provider-${row.providerId}`}
          emptyState="No providers match the current filters."
        />
      ),
    },
    {
      id: "pairs",
      label: "Pairs",
      badge: String(filteredPairs.length),
      content: (
        <DataTableShell
          columns={pairColumns}
          rows={filteredPairs}
          rowKey={(row) => `pair-${row.providerId}-${row.model}`}
          wide
          emptyState="No provider-model pairs match the current filters."
        />
      ),
    },
    {
      id: "providers",
      label: "Providers",
      badge: String(filteredProviders.length),
      content: (
        <DataTableShell
          columns={providerColumns}
          rows={filteredProviders}
          rowKey={(row) => `provider-${row.providerId}`}
          emptyState="No providers match the current filters."
        />
      ),
    },
    {
      id: "pairs",
      label: "Pairs",
      badge: String(filteredPairs.length),
      content: (
        <DataTableShell
          columns={pairColumns}
          rows={filteredPairs}
          rowKey={(row) => `pair-${row.providerId}-${row.model}`}
          wide
          emptyState="No provider-model pairs match the current filters."
        />
      ),
    },
  ], [filteredModels, filteredPairs, filteredProviders]);

  return (
    <div className="analytics-layout">
      <SurfaceHero
        kicker="Routing Intelligence"
        title="Provider + model analytics"
        description="Explore observed performance by model, by provider, and by provider × model pair. Suitability is a heuristic derived from TTFT, decode TPS, error rate, cache behavior, and confidence."
        stats={[
          { label: '', value: `Updated ${formatDate(analytics?.generatedAt ?? null)}` },
          { label: '', value: 'Auto-refresh every 30s' },
        ]}
      />

      {error && <p className="error-text">{error}</p>}

      {analytics?.coverage && !analytics.coverage.hasFullWindowCoverage ? (
        <p className="error-text">
          Selected window is not fully covered yet. Coverage starts {formatDate(analytics.coverage.coverageStart)};
          requested window starts {formatDate(analytics.coverage.requestedWindowStart)}.
          Ranking and suitability are still useful, but historical totals may be partial.
        </p>
      ) : null}

      <MetricTileGrid>
        <MetricTile
          label="Observed Models"
          value={formatCompactNumber(analytics?.models.length ?? 0)}
          detail={`Top model: ${topModel?.model ?? '-'}`}
          loading={loading}
        />
        <MetricTile
          label="Observed Providers"
          value={formatCompactNumber(analytics?.providers.length ?? 0)}
          detail={`Top provider: ${topProvider?.providerId ?? '-'}`}
          loading={loading}
          variant="info"
        />
        <MetricTile
          label="Provider × Model Pairs"
          value={formatCompactNumber(analytics?.providerModels.length ?? 0)}
          detail={`Window: ${windowValue}`}
          loading={loading}
        />
        <MetricTile
          label="Top Model Suitability"
          value={formatMaybeSuitability(topModel?.suitabilityScore ?? null)}
          detail={topModel?.model ?? '-'}
          loading={loading}
          variant="success"
        />
        <MetricTile
          label="Top Provider Suitability"
          value={formatMaybeSuitability(topProvider?.suitabilityScore ?? null)}
          detail={topProvider?.providerId ?? '-'}
          loading={loading}
          variant="success"
        />
      </MetricTileGrid>

      <section className="analytics-panel panel-sheen">
        <PanelHeader
          title="Controls"
          description="Change the observed window, sort order, and pair-level focus."
          actions={<FilterToolbar>
            <label>
              Window&nbsp;
              <select value={windowValue} onChange={(event) => setWindowValue(event.currentTarget.value as typeof windowValue)}>
                <option value="daily">Daily (24h)</option>
                <option value="weekly">Weekly (7d)</option>
                <option value="monthly">Monthly (30d)</option>
              </select>
            </label>
            <label>
              Sort&nbsp;
              <select value={sort} onChange={(event) => setSort(event.currentTarget.value)}>
                <option value="suitability">Suitability</option>
                <option value="tokens">Tokens</option>
                <option value="requests">Requests</option>
                <option value="ttft">TTFT</option>
                <option value="tps">Decode TPS</option>
                <option value="e2e-tps">End-to-end TPS</option>
                <option value="errors">Error rate</option>
                <option value="cost">Cost</option>
              </select>
            </label>
            <label>
              Provider focus&nbsp;
              <select value={providerFocus} onChange={(event) => setProviderFocus(event.currentTarget.value)}>
                <option value="">All providers</option>
                {providerOptions.map((providerId) => <option key={providerId} value={providerId}>{providerId}</option>)}
              </select>
            </label>
            <label>
              Model focus&nbsp;
              <select value={modelFocus} onChange={(event) => setModelFocus(event.currentTarget.value)}>
                <option value="">All models</option>
                {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </label>
          </FilterToolbar>}
        />
      </section>

      <section className="analytics-panel panel-sheen">
        <PanelHeader
          title="Analytics Views"
          description="Switch between model, provider, and pair-level views without losing context."
          actions={<FilterToolbar>
            <Input
              aria-label="Search models"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.currentTarget.value)}
              placeholder="Search models…"
            />
            <Input
              aria-label="Search providers"
              value={providerSearch}
              onChange={(event) => setProviderSearch(event.currentTarget.value)}
              placeholder="Search providers…"
            />
          </FilterToolbar>}
        />
        <Tabs
          defaultValue="models"
          variant="enclosed"
          items={analyticsTabs as TabItem[]}
        />
      </section>
    </div>
  );
}
