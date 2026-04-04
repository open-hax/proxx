import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, DataTableShell, PanelHeader, Spinner, SurfaceHero, type DataTableColumn } from "@open-hax/uxx";
import { getHostsOverview, type HostDashboardContainerSummary, type HostDashboardRouteSummary, type HostDashboardSnapshot, type HostsOverview } from "../lib/api";

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function HostReachabilityPill({ host }: { readonly host: HostDashboardSnapshot }): JSX.Element {
  if (!host.reachable) {
    return <Badge variant="error">Unreachable</Badge>;
  }

  if (host.errors.length > 0) {
    return <Badge variant="warning">Partial</Badge>;
  }

  return <Badge variant="success">Live</Badge>;
}

function formatContainerPorts(ports: readonly string[]): string {
  if (ports.length === 0) {
    return "—";
  }

  return ports.join(", ");
}

function hostLastError(host: HostDashboardSnapshot): string | null {
  return host.errors.length > 0 ? host.errors[host.errors.length - 1] ?? null : null;
}

function routesColumns(): DataTableColumn<HostDashboardRouteSummary>[] {
  return [
    { key: 'host', header: 'Host' },
    { key: 'match', header: 'Match', render: (row) => row.matchPaths.length > 0 ? row.matchPaths.join(" ") : (row.matcher ?? "default") },
    { key: 'upstreams', header: 'Upstream', render: (row) => row.upstreams.join(", ") },
  ];
}

function containersColumns(): DataTableColumn<HostDashboardContainerSummary>[] {
  return [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'image', header: 'Image' },
    { key: 'status', header: 'Status' },
    { key: 'ports', header: 'Ports', render: (row) => formatContainerPorts(row.ports) },
  ];
}

export function HostsPage(): JSX.Element {
  const [overview, setOverview] = useState<HostsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (isFetchingRef.current) {
        return;
      }

      isFetchingRef.current = true;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setLoading(true);
      setError(null);
      try {
        const nextOverview = await getHostsOverview();
        if (!cancelled && requestId === requestIdRef.current) {
          setOverview(nextOverview);
        }
      } catch (loadError) {
        if (!cancelled && requestId === requestIdRef.current) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        isFetchingRef.current = false;
        if (!cancelled && requestId === requestIdRef.current) {
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

  const hosts = overview?.hosts ?? [];
  const totals = useMemo(() => ({
    hostCount: hosts.length,
    reachableCount: hosts.filter((host) => host.reachable).length,
    containerCount: hosts.reduce((sum, host) => sum + host.summary.containerCount, 0),
    routeCount: hosts.reduce((sum, host) => sum + host.summary.routeCount, 0),
  }), [hosts]);

  return (
    <section className="hosts-page">
      <SurfaceHero
        kicker="Host Fleet"
        title="Promethean ussy host dashboard"
        description="One view for container inventory and routed subdomains across the ussy hosts. Remote hosts stay visible even when access or auth is broken."
        stats={[
          { label: 'reachable hosts', value: `${totals.reachableCount}/${totals.hostCount}`, tone: 'success' },
          { label: 'containers tracked', value: totals.containerCount },
          { label: 'subdomain routes parsed', value: totals.routeCount },
          { label: '', value: overview ? `Updated ${formatDate(overview.generatedAt)}` : 'Waiting for first sample…' },
        ]}
      />

      {loading && !overview ? (
        <div className="hosts-empty"><Spinner size="md" label="Loading host inventory…" /></div>
      ) : null}
      {error ? <div className="hosts-empty hosts-empty-error">{error}</div> : null}

      <div className="hosts-grid">
        {hosts.map((host) => {
          const lastError = hostLastError(host);
          return (
            <article key={host.id} className="hosts-card panel-sheen">
              <header className="hosts-card-header">
                <div>
                  <div className="hosts-card-title-row">
                    <h3>{host.label}</h3>
                    {overview?.selfTargetId === host.id ? <Badge variant="info">This console</Badge> : null}
                    <HostReachabilityPill host={host} />
                  </div>
                  <p>
                    {host.baseUrl ?? host.publicHost ?? host.id}
                    {host.notes ? ` · ${host.notes}` : ""}
                  </p>
                </div>
                <div className="hosts-card-stats">
                  <div>
                    <strong>{host.summary.runningCount}/{host.summary.containerCount}</strong>
                    <span>running</span>
                  </div>
                  <div>
                    <strong>{host.summary.healthyCount}</strong>
                    <span>healthy</span>
                  </div>
                  <div>
                    <strong>{host.summary.routeCount}</strong>
                    <span>routes</span>
                  </div>
                </div>
              </header>

              {lastError ? <div className="hosts-card-error">{lastError}</div> : null}

              <div className="hosts-card-body">
                <section className="hosts-section">
                  <PanelHeader title="Subdomains" meta={<small>{host.routes.length} routes</small>} />
                  {host.routes.length === 0 ? (
                    <div className="hosts-section-empty">No routed subdomains detected.</div>
                  ) : (
                    <DataTableShell
                      columns={routesColumns()}
                      rows={host.routes}
                      rowKey={(row, index) => `${row.host}-${row.upstreams.join(",")}-${index}`}
                      dense
                      stickyHeader={false}
                    />
                  )}
                </section>

                <section className="hosts-section">
                  <PanelHeader title="Containers" meta={<small>{host.containers.length} containers</small>} />
                  {host.containers.length === 0 ? (
                    <div className="hosts-section-empty">No container data available.</div>
                  ) : (
                    <DataTableShell
                      columns={containersColumns()}
                      rows={host.containers}
                      rowKey={(row) => row.id}
                      dense
                      stickyHeader={false}
                    />
                  )}
                </section>

                <section className="hosts-section">
                  <PanelHeader title="Containers" meta={<small>{host.containers.length} containers</small>} />
                  {host.containers.length === 0 ? (
                    <div className="hosts-section-empty">No container data available.</div>
                  ) : (
                    <DataTableShell
                      columns={containersColumns()}
                      rows={host.containers}
                      rowKey={(row) => row.id}
                      dense
                      stickyHeader={false}
                    />
                  )}
                </section>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
