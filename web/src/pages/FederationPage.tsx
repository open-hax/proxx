import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addFederationPeer,
  getFederationAccounts,
  getFederationSelf,
  listFederationBridges,
  listFederationPeers,
  type FederationAccountsOverview,
  type FederationBridgeSessionSummary,
  type FederationPeer,
  type FederationSelf,
  type FederationSyncResult,
  syncFederationPeer,
} from "../lib/api";

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

export function FederationPage(): JSX.Element {
  const [ownerSubject, setOwnerSubject] = useState(DEFAULT_OWNER_SUBJECT);
  const [selfState, setSelfState] = useState<FederationSelf | null>(null);
  const [accounts, setAccounts] = useState<FederationAccountsOverview | null>(null);
  const [peers, setPeers] = useState<readonly FederationPeer[]>([]);
  const [bridges, setBridges] = useState<readonly FederationBridgeSessionSummary[]>([]);
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
      const [nextSelf, nextPeers, nextAccounts, nextBridges] = await Promise.all([
        getFederationSelf(),
        listFederationPeers(ownerSubject),
        getFederationAccounts(ownerSubject),
        listFederationBridges(),
      ]);
      setSelfState(nextSelf);
      setPeers(nextPeers);
      setAccounts(nextAccounts);
      setBridges(nextBridges);
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

  const localProviders = useMemo(() => summarizeProviders(accounts?.localAccounts ?? []), [accounts]);
  const projectedProviders = useMemo(() => summarizeProviders(accounts?.projectedAccounts ?? []), [accounts]);
  const knownProviders = useMemo(() => summarizeProviders(accounts?.knownAccounts ?? []), [accounts]);

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

  return (
    <section className="federation-page">
      <header className="federation-hero panel-sheen">
        <div>
          <p className="dashboard-kicker">Federation</p>
          <h2>Brethren control surface</h2>
          <p>
            Inspect self-state, peers, projected accounts, bridge sessions, and pull syncs without spelunking through curl,
            psql, and host tunnels.
          </p>
        </div>
        <div className="federation-hero-meta">
          <strong>{selfState?.nodeId ?? "—"}</strong>
          <span>this node</span>
          <strong>{selfState?.peerCount ?? 0}</strong>
          <span>known peers</span>
          <strong>{accounts?.projectedAccounts.length ?? 0}</strong>
          <span>projected accounts</span>
        </div>
      </header>

      <section className="federation-toolbar panel-sheen">
        <label>
          Owner subject
          <input
            type="text"
            value={ownerSubject}
            onChange={(event) => setOwnerSubject(event.currentTarget.value)}
            placeholder="did:web:proxx.promethean.rest:brethren"
          />
        </label>
        <div className="federation-toolbar-actions">
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => setOwnerSubject(DEFAULT_OWNER_SUBJECT)}
          >
            Default brethren subject
          </button>
        </div>
      </section>

      {error ? <div className="federation-error panel-sheen">{error}</div> : null}

      <div className="federation-grid">
        <article className="federation-card panel-sheen">
          <h3>Self</h3>
          <dl className="federation-kv">
            <dt>Node</dt><dd>{selfState?.nodeId ?? "—"}</dd>
            <dt>Group</dt><dd>{selfState?.groupId ?? "—"}</dd>
            <dt>Cluster</dt><dd>{selfState?.clusterId ?? "—"}</dd>
            <dt>Peer DID</dt><dd>{selfState?.peerDid ?? "—"}</dd>
            <dt>Public URL</dt><dd>{selfState?.publicBaseUrl ?? "—"}</dd>
          </dl>
        </article>

        <article className="federation-card panel-sheen">
          <h3>Bridge sessions</h3>
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
        </article>

        <article className="federation-card panel-sheen federation-card-wide">
          <h3>Account knowledge</h3>
          <div className="federation-account-columns">
            <div>
              <h4>Local</h4>
              <p>{accounts?.localAccounts.length ?? 0} accounts</p>
              <ul className="federation-pills">
                {localProviders.map((entry) => <li key={`local-${entry.providerId}`}>{entry.providerId} · {entry.count}</li>)}
              </ul>
            </div>
            <div>
              <h4>Projected</h4>
              <p>{accounts?.projectedAccounts.length ?? 0} accounts</p>
              <ul className="federation-pills">
                {projectedProviders.map((entry) => <li key={`projected-${entry.providerId}`}>{entry.providerId} · {entry.count}</li>)}
              </ul>
            </div>
            <div>
              <h4>Known</h4>
              <p>{accounts?.knownAccounts.length ?? 0} accounts</p>
              <ul className="federation-pills">
                {knownProviders.map((entry) => <li key={`known-${entry.providerId}`}>{entry.providerId} · {entry.count}</li>)}
              </ul>
            </div>
          </div>
          {lastSyncResult ? (
            <div className="federation-sync-result">
              Last sync: {lastSyncResult.peer.label} · projected {lastSyncResult.importedProjectedAccountsCount} · diff {lastSyncResult.remoteDiffCount}
            </div>
          ) : null}
        </article>
      </div>

      <article className="federation-card panel-sheen federation-card-wide">
        <header className="federation-card-header">
          <div>
            <h3>Peers</h3>
            <p>Register and sync peers without shell gymnastics.</p>
          </div>
        </header>

        {peers.length === 0 ? <p className="federation-empty">No peers registered for this owner subject.</p> : null}
        {peers.length > 0 ? (
          <div className="federation-peer-grid">
            {peers.map((peer) => (
              <article key={peer.id} className="federation-peer-card">
                <div className="federation-peer-title-row">
                  <h4>{peer.label}</h4>
                  <span className={`federation-peer-status federation-peer-status-${peer.status.toLowerCase()}`}>{peer.status}</span>
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
                  <button type="button" onClick={() => void handleSyncPeer(peer)}>
                    Sync pull
                  </button>
                  <small>{syncStatus[peer.id] ?? "Idle"}</small>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </article>

      <article className="federation-card panel-sheen federation-card-wide">
        <h3>Add peer</h3>
        <form className="federation-form" onSubmit={(event) => void handleSubmitPeer(event)}>
          <label>
            Owner credential
            <input
              type="password"
              value={peerForm.ownerCredential}
              onChange={(event) => setPeerForm((current) => ({ ...current, ownerCredential: event.currentTarget.value }))}
              placeholder="admin key or DID used to derive owner subject"
              required
            />
          </label>
          <label>
            Label
            <input
              type="text"
              value={peerForm.label}
              onChange={(event) => setPeerForm((current) => ({ ...current, label: event.currentTarget.value }))}
              placeholder="Big Ussy Cephalon Proxx"
              required
            />
          </label>
          <label>
            Base URL
            <input
              type="url"
              value={peerForm.baseUrl}
              onChange={(event) => setPeerForm((current) => ({ ...current, baseUrl: event.currentTarget.value }))}
              placeholder="http://big.ussy.promethean.rest:8789"
              required
            />
          </label>
          <label>
            Control base URL
            <input
              type="url"
              value={peerForm.controlBaseUrl}
              onChange={(event) => setPeerForm((current) => ({ ...current, controlBaseUrl: event.currentTarget.value }))}
              placeholder="optional separate control plane URL"
            />
          </label>
          <label>
            Peer DID
            <input
              type="text"
              value={peerForm.peerDid}
              onChange={(event) => setPeerForm((current) => ({ ...current, peerDid: event.currentTarget.value }))}
              placeholder="did:web:big.ussy.promethean.rest"
            />
          </label>
          <label>
            Auth credential
            <input
              type="password"
              value={peerForm.authCredential}
              onChange={(event) => setPeerForm((current) => ({ ...current, authCredential: event.currentTarget.value }))}
              placeholder="peer admin token / bearer credential"
            />
          </label>
          <div className="federation-form-actions">
            <button type="submit" disabled={submittingPeer}>
              {submittingPeer ? "Adding…" : "Add peer"}
            </button>
          </div>
        </form>
      </article>
    </section>
  );
}
