import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActionStrip, Badge, Button, Card, FilterToolbar, Input, PanelHeader, SurfaceHero, Tabs, type TabItem } from "@open-hax/uxx";
import {
  addFederationPeer,
  getFederationAccounts,
  getFederationSelf,
  getApiOrigin,
  listFederationBridges,
  listFederationPeers,
  listRequestLogs,
  type FederationAccountsOverview,
  type FederationBridgeSessionSummary,
  type FederationPeer,
  type FederationSelf,
  type FederationSyncResult,
  type RequestLogEntry,
  syncFederationPeer,
} from "../lib/api";
import { formatRequestOrigin } from "../lib/format";

const DEFAULT_OWNER_SUBJECT = "did:web:proxx.promethean.rest:brethren";

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function summarizeProviders(accounts: readonly { readonly providerId: string }[]): Array<{ providerId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    counts.set(account.providerId, (counts.get(account.providerId) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([providerId, count]) => ({ providerId, count }))
    .sort((left, right) => right.count - left.count || left.providerId.localeCompare(right.providerId));
}

function bridgeLabel(session: FederationBridgeSessionSummary, index: number): string {
  return session.sessionId || session.peerDid || session.agentId || `bridge-${index + 1}`;
}

function routedRequestLabel(entry: RequestLogEntry): string {
  const peer = entry.routedPeerLabel ?? entry.routedPeerId ?? "unknown-peer";
  return `${entry.routeKind} → ${peer}`;
}

export function FederationPage(): JSX.Element {
  const [ownerSubject, setOwnerSubject] = useState(DEFAULT_OWNER_SUBJECT);
  const [selfState, setSelfState] = useState<FederationSelf | null>(null);
  const [accounts, setAccounts] = useState<FederationAccountsOverview | null>(null);
  const [peers, setPeers] = useState<readonly FederationPeer[]>([]);
  const [bridges, setBridges] = useState<readonly FederationBridgeSessionSummary[]>([]);
  const [recentRequestLogs, setRecentRequestLogs] = useState<readonly RequestLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<Record<string, string>>({});
  const [lastSyncResult, setLastSyncResult] = useState<FederationSyncResult | null>(null);
  const [submittingPeer, setSubmittingPeer] = useState(false);
  const [peerForm, setPeerForm] = useState({
    ownerCredential: "",
    label: "",
    baseUrl: "",
    controlBaseUrl: "",
    peerDid: "",
    authCredential: "",
  });
  const intervalRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSelf, nextPeers, nextAccounts, nextBridges, nextRequestLogs] = await Promise.all([
        getFederationSelf(),
        listFederationPeers(ownerSubject),
        getFederationAccounts(ownerSubject),
        listFederationBridges(),
        listRequestLogs({ limit: 100 }),
      ]);
      setSelfState(nextSelf);
      setPeers(nextPeers);
      setAccounts(nextAccounts);
      setBridges(nextBridges);
      setRecentRequestLogs(nextRequestLogs);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [ownerSubject]);

  useEffect(() => {
    void load();
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
    }
    intervalRef.current = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
      }
    };
  }, [load]);

  useEffect(() => {
    const apiOrigin = getApiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
    const wsOrigin = apiOrigin.startsWith("https://")
      ? apiOrigin.replace(/^https:/u, "wss:")
      : apiOrigin.startsWith("http://")
        ? apiOrigin.replace(/^http:/u, "ws:")
        : apiOrigin;

    const params = new URLSearchParams({
      ownerSubject: ownerSubject.trim(),
      routeKind: "routed",
    });

    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(`${wsOrigin}/api/v1/federation/observability/ws?${params.toString()}`);
    } catch {
      socket = null;
    }

    if (!socket) {
      return;
    }

    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      const message = parsed as { readonly type?: unknown; readonly entry?: unknown };
      if (message.type !== "request_log_record" && message.type !== "request_log_update") {
        return;
      }

      const entry = message.entry as RequestLogEntry | undefined;
      if (!entry || typeof entry.id !== "string") {
        return;
      }

      setRecentRequestLogs((current) => {
        const existingIndex = current.findIndex((candidate) => candidate.id === entry.id);
        if (existingIndex >= 0) {
          const next = [...current];
          next.splice(existingIndex, 1, entry);
          return next;
        }

        return [entry, ...current].slice(0, 200);
      });
    };

    return () => {
      try {
        socket?.close();
      } catch {
        // ignore
      }
    };
  }, [ownerSubject]);

  const localProviders = useMemo(() => summarizeProviders(accounts?.localAccounts ?? []), [accounts]);
  const projectedProviders = useMemo(() => summarizeProviders(accounts?.projectedAccounts ?? []), [accounts]);
  const knownProviders = useMemo(() => summarizeProviders(accounts?.knownAccounts ?? []), [accounts]);
  const routedRequestLogs = useMemo(() =>
    recentRequestLogs
      .filter((entry) => entry.routeKind !== "local")
      .filter((entry) => !entry.federationOwnerSubject || entry.federationOwnerSubject === ownerSubject),
  [recentRequestLogs, ownerSubject]);
  const routedRequestSummary = useMemo(() => {
    const peerCounts = new Map<string, number>();
    let federated = 0;
    let bridge = 0;
    for (const entry of routedRequestLogs) {
      if (entry.routeKind === "federated") {
        federated += 1;
      } else if (entry.routeKind === "bridge") {
        bridge += 1;
      }
      const peer = entry.routedPeerLabel ?? entry.routedPeerId;
      if (peer) {
        peerCounts.set(peer, (peerCounts.get(peer) ?? 0) + 1);
      }
    }
    const topPeer = [...peerCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
    return { federated, bridge, topPeer };
  }, [routedRequestLogs]);

  const handleSyncPeer = async (peer: FederationPeer) => {
    setSyncStatus((current) => ({ ...current, [peer.id]: "Syncing…" }));
    try {
      const result = await syncFederationPeer({
        peerId: peer.id,
        ownerSubject,
        pullUsage: false,
      });
      setLastSyncResult(result);
      setSyncStatus((current) => ({
        ...current,
        [peer.id]: `Projected ${result.importedProjectedAccountsCount}, usage ${result.importedUsageCount}, diff ${result.remoteDiffCount}`,
      }));
      await load();
    } catch (syncError) {
      setSyncStatus((current) => ({
        ...current,
        [peer.id]: syncError instanceof Error ? syncError.message : String(syncError),
      }));
    }
  };

  const handleSubmitPeer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittingPeer(true);
    setError(null);
    try {
      await addFederationPeer({
        ownerCredential: peerForm.ownerCredential.trim(),
        label: peerForm.label.trim(),
        baseUrl: peerForm.baseUrl.trim(),
        controlBaseUrl: peerForm.controlBaseUrl.trim() || undefined,
        peerDid: peerForm.peerDid.trim() || undefined,
        auth: peerForm.authCredential.trim() ? { credential: peerForm.authCredential.trim() } : undefined,
      });
      setPeerForm({
        ownerCredential: peerForm.ownerCredential,
        label: "",
        baseUrl: "",
        controlBaseUrl: "",
        peerDid: "",
        authCredential: "",
      });
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmittingPeer(false);
    }
  };

  const accountKnowledgeTabs = useMemo<readonly TabItem[]>(() => [
    {
      id: "local",
      label: "Local",
      badge: String(accounts?.localAccounts.length ?? 0),
      content: (
        <div>
          <p>{accounts?.localAccounts.length ?? 0} accounts</p>
          <ul className="federation-pills">
            {localProviders.map((entry) => <li key={`local-${entry.providerId}`}><Badge variant="info">{entry.providerId}</Badge> · {entry.count}</li>)}
          </ul>
        </div>
      ),
    },
    {
      id: "projected",
      label: "Projected",
      badge: String(accounts?.projectedAccounts.length ?? 0),
      content: (
        <div>
          <p>{accounts?.projectedAccounts.length ?? 0} accounts</p>
          <ul className="federation-pills">
            {projectedProviders.map((entry) => <li key={`projected-${entry.providerId}`}><Badge variant="warning">{entry.providerId}</Badge> · {entry.count}</li>)}
          </ul>
        </div>
      ),
    },
    {
      id: "known",
      label: "Known",
      badge: String(accounts?.knownAccounts.length ?? 0),
      content: (
        <div>
          <p>{accounts?.knownAccounts.length ?? 0} accounts</p>
          <ul className="federation-pills">
            {knownProviders.map((entry) => <li key={`known-${entry.providerId}`}><Badge variant="success">{entry.providerId}</Badge> · {entry.count}</li>)}
          </ul>
        </div>
      ),
    },
  ], [accounts?.knownAccounts.length, accounts?.localAccounts.length, accounts?.projectedAccounts.length, knownProviders, localProviders, projectedProviders]);

  return (
    <section className="federation-page">
      <SurfaceHero
        kicker="Federation"
        title="Brethren control surface"
        description="Inspect self-state, peers, projected accounts, bridge sessions, and pull syncs without spelunking through curl, psql, and host tunnels."
        stats={[
          { label: 'this node', value: selfState?.nodeId ?? '—', tone: 'info' },
          { label: 'known peers', value: selfState?.peerCount ?? 0, tone: 'info' },
          { label: 'projected accounts', value: accounts?.projectedAccounts.length ?? 0, tone: 'warning' },
          { label: 'recent routed reqs', value: routedRequestLogs.length },
        ]}
      />

      <section className="federation-toolbar panel-sheen">
        <FilterToolbar>
          <label>
            Owner subject
            <Input
              type="text"
              value={ownerSubject}
              onChange={(event) => setOwnerSubject(event.currentTarget.value)}
              placeholder="did:web:proxx.promethean.rest:brethren"
            />
          </label>
          <ActionStrip>
            <Button type="button" variant="primary" loading={loading} onClick={() => void load()}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOwnerSubject(DEFAULT_OWNER_SUBJECT)}
            >
              Default brethren subject
            </Button>
          </ActionStrip>
        </FilterToolbar>
      </section>

      {error ? <div className="federation-error panel-sheen">{error}</div> : null}

      <div className="federation-grid">
        <Card variant="elevated" padding="md" style={{ minHeight: "100%" }}>
          <PanelHeader title="Self" />
          <dl className="federation-kv">
            <dt>Node</dt><dd>{selfState?.nodeId ?? "—"}</dd>
            <dt>Group</dt><dd>{selfState?.groupId ?? "—"}</dd>
            <dt>Cluster</dt><dd>{selfState?.clusterId ?? "—"}</dd>
            <dt>Peer DID</dt><dd>{selfState?.peerDid ?? "—"}</dd>
            <dt>Public URL</dt><dd>{selfState?.publicBaseUrl ?? "—"}</dd>
          </dl>
        </Card>

        <Card variant="elevated" padding="md" style={{ minHeight: "100%" }}>
          <PanelHeader title="Bridge sessions" />
          {bridges.length === 0 ? (
            <p className="federation-empty">No live bridge sessions reported.</p>
          ) : (
            <ul className="federation-list">
              {bridges.map((session, index) => (
                <li key={`${bridgeLabel(session, index)}-${index}`}>
                  <strong>{bridgeLabel(session, index)}</strong>
                  <span>{session.state ?? "unknown"}</span>
                  <small>{session.clusterId ?? session.groupId ?? session.peerDid ?? "—"}</small>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card variant="elevated" padding="md" style={{ minHeight: "100%" }}>
          <PanelHeader title="Routing" />
          <dl className="federation-kv">
            <dt>Recent federated</dt><dd>{routedRequestSummary.federated}</dd>
            <dt>Recent bridge</dt><dd>{routedRequestSummary.bridge}</dd>
            <dt>Top peer</dt><dd>{routedRequestSummary.topPeer ?? "—"}</dd>
            <dt>Tracked logs</dt><dd>{recentRequestLogs.length}</dd>
          </dl>
        </Card>

        <div className="federation-card federation-card-wide">
        <Card variant="elevated" padding="md">
          <PanelHeader title="Account knowledge" />
          <Tabs defaultValue="local" variant="enclosed" items={accountKnowledgeTabs as TabItem[]} />
          {lastSyncResult ? (
            <div className="federation-sync-result">
              Last sync: {lastSyncResult.peer.label} · projected {lastSyncResult.importedProjectedAccountsCount} · diff {lastSyncResult.remoteDiffCount}
            </div>
          ) : null}
        </Card>
        </div>
      </div>

      <article className="federation-card panel-sheen federation-card-wide">
        <PanelHeader title="Recent routed requests" />
        {routedRequestLogs.length === 0 ? (
          <p className="federation-empty">No routed federation or bridge requests captured in the recent request log sample.</p>
        ) : (
          <ul className="federation-list">
            {routedRequestLogs.slice(0, 12).map((entry) => {
              const origin = formatRequestOrigin(entry);
              const originPart = origin !== "unknown" && origin !== "local" ? ` · from ${origin}` : "";
              return (
                <li key={entry.id}>
                  <strong>{routedRequestLabel(entry)} · {entry.model}</strong>
                  <span>
                    {entry.providerId}/{entry.accountId} · {entry.status === 0 ? "ERR" : entry.status} · {Math.round(entry.latencyMs)} ms
                    {originPart}
                  </span>
                  <small>{new Date(entry.timestamp).toLocaleString()} · owner {entry.federationOwnerSubject ?? "—"}</small>
                </li>
              );
            })}
          </ul>
        )}
      </article>

      <article className="federation-card panel-sheen federation-card-wide">
        <PanelHeader title="Peers" description="Register and sync peers without shell gymnastics." />

        {peers.length === 0 ? <p className="federation-empty">No peers registered for this owner subject.</p> : null}
        {peers.length > 0 ? (
          <div className="federation-peer-grid">
            {peers.map((peer) => (
              <article key={peer.id} className="federation-peer-card">
                <div className="federation-peer-title-row">
                  <h4>{peer.label}</h4>
                  <Badge variant={peer.status.toLowerCase() === "healthy" ? "success" : peer.status.toLowerCase() === "warning" ? "warning" : "default"}>{peer.status}</Badge>
                </div>
                <dl className="federation-kv">
                  <dt>Owner</dt><dd>{peer.ownerSubject}</dd>
                  <dt>Base</dt><dd>{peer.baseUrl}</dd>
                  <dt>Control</dt><dd>{peer.controlBaseUrl ?? "—"}</dd>
                  <dt>Auth</dt><dd>{peer.authMode}</dd>
                  <dt>DID</dt><dd>{peer.peerDid ?? "—"}</dd>
                  <dt>Updated</dt><dd>{formatDate(peer.updatedAt)}</dd>
                </dl>
                <div className="federation-peer-actions">
                  <Button type="button" size="sm" onClick={() => void handleSyncPeer(peer)}>
                    Sync pull
                  </Button>
                  <small>{syncStatus[peer.id] ?? "Idle"}</small>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </article>

      <article className="federation-card panel-sheen federation-card-wide">
        <PanelHeader title="Add peer" />
        <form className="federation-form" onSubmit={(event) => void handleSubmitPeer(event)}>
          <label>
            Owner credential
            <Input
              type="password"
              value={peerForm.ownerCredential}
              onChange={(event) => setPeerForm((current) => ({ ...current, ownerCredential: event.currentTarget.value }))}
              placeholder="admin key or DID used to derive owner subject"
              required
            />
          </label>
          <label>
            Label
            <Input
              type="text"
              value={peerForm.label}
              onChange={(event) => setPeerForm((current) => ({ ...current, label: event.currentTarget.value }))}
              placeholder="Big Ussy Cephalon Proxx"
              required
            />
          </label>
          <label>
            Base URL
            <Input
              type="url"
              value={peerForm.baseUrl}
              onChange={(event) => setPeerForm((current) => ({ ...current, baseUrl: event.currentTarget.value }))}
              placeholder="http://big.ussy.promethean.rest:8789"
              required
            />
          </label>
          <label>
            Control base URL
            <Input
              type="url"
              value={peerForm.controlBaseUrl}
              onChange={(event) => setPeerForm((current) => ({ ...current, controlBaseUrl: event.currentTarget.value }))}
              placeholder="optional separate control plane URL"
            />
          </label>
          <label>
            Peer DID
            <Input
              type="text"
              value={peerForm.peerDid}
              onChange={(event) => setPeerForm((current) => ({ ...current, peerDid: event.currentTarget.value }))}
              placeholder="did:web:big.ussy.promethean.rest"
            />
          </label>
          <label>
            Auth credential
            <Input
              type="password"
              value={peerForm.authCredential}
              onChange={(event) => setPeerForm((current) => ({ ...current, authCredential: event.currentTarget.value }))}
              placeholder="peer admin token / bearer credential"
            />
          </label>
          <div className="federation-form-actions">
            <Button type="submit" variant="primary" loading={submittingPeer}>
              {submittingPeer ? "Adding…" : "Add peer"}
            </Button>
          </div>
        </form>
      </article>
    </section>
  );
}
