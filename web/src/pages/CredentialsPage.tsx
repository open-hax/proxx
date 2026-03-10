import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addApiKeyCredential,
  listCredentials,
  listRequestLogs,
  pollOpenAiDeviceOAuth,
  type KeyPoolStatus,
  type ProviderRequestLogSummary,
  startOpenAiBrowserOAuth,
  startOpenAiDeviceOAuth,
  type CredentialProvider,
  type RequestLogEntry,
} from "../lib/api";

interface DeviceAuthState {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}

export function CredentialsPage(): JSX.Element {
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [providers, setProviders] = useState<CredentialProvider[]>([]);
  const [keyPoolStatuses, setKeyPoolStatuses] = useState<Record<string, KeyPoolStatus>>({});
  const [requestLogSummary, setRequestLogSummary] = useState<Record<string, ProviderRequestLogSummary>>({});
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [apiKeyProvider, setApiKeyProvider] = useState("vivgrid");
  const [apiKeyAccount, setApiKeyAccount] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthState | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserOAuthWatchRef = useRef<number | null>(null);
  const devicePollingRef = useRef(false);

  const refreshCredentials = useCallback(async () => {
    const payload = await listCredentials(revealSecrets);
    setProviders(payload.providers);
    setKeyPoolStatuses(payload.keyPoolStatuses);
    setRequestLogSummary(payload.requestLogSummary);
  }, [revealSecrets]);

  const refreshLogs = useCallback(async () => {
    const entries = await listRequestLogs({
      providerId: selectedProvider || undefined,
      accountId: selectedAccount || undefined,
      limit: 250,
    });
    setLogs(entries);
  }, [selectedAccount, selectedProvider]);

  useEffect(() => {
    void refreshCredentials().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }, [refreshCredentials]);

  useEffect(() => {
    void refreshLogs().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }, [refreshLogs]);

  useEffect(() => {
    return () => {
      if (browserOAuthWatchRef.current !== null) {
        window.clearInterval(browserOAuthWatchRef.current);
        browserOAuthWatchRef.current = null;
      }
    };
  }, []);

  const allAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      for (const account of provider.accounts) {
        ids.add(account.id);
      }
    }
    return [...ids].sort();
  }, [providers]);

  const providerHealth = useMemo(() => {
    const providerIds = new Set<string>([
      ...providers.map((provider) => provider.id),
      ...Object.keys(keyPoolStatuses),
      ...Object.keys(requestLogSummary),
    ]);

    return [...providerIds].sort().map((providerId) => ({
      providerId,
      keyPool: keyPoolStatuses[providerId],
      logs: requestLogSummary[providerId],
    }));
  }, [keyPoolStatuses, providers, requestLogSummary]);

  const handleApiKeySubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      if (apiKeyValue.trim().length === 0) {
        throw new Error("API key value is required");
      }

      const accountId = apiKeyAccount.trim().length > 0 ? apiKeyAccount.trim() : `${apiKeyProvider}-manual`;
      await addApiKeyCredential(apiKeyProvider.trim(), accountId, apiKeyValue.trim());
      setApiKeyValue("");
      setStatus("API key saved.");
      await refreshCredentials();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  const startBrowserOAuth = async () => {
    setError(null);

    try {
      const payload = await startOpenAiBrowserOAuth(window.location.origin);
      const popup = window.open(payload.authorizeUrl, "openai-oauth", "popup=yes,width=560,height=720");

      if (!popup) {
        throw new Error("Browser blocked popup. Allow popups and try again.");
      }

      if (browserOAuthWatchRef.current !== null) {
        window.clearInterval(browserOAuthWatchRef.current);
        browserOAuthWatchRef.current = null;
      }

      browserOAuthWatchRef.current = window.setInterval(() => {
        if (!popup.closed) {
          return;
        }

        if (browserOAuthWatchRef.current !== null) {
          window.clearInterval(browserOAuthWatchRef.current);
          browserOAuthWatchRef.current = null;
        }

        void refreshCredentials();
        setStatus("Browser OAuth flow finished. Credentials refreshed.");
      }, 750);

      setStatus("Browser OAuth window opened. Finish sign-in to save credentials.");
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const startDeviceOAuth = async () => {
    setError(null);

    try {
      const payload = await startOpenAiDeviceOAuth();
      setDeviceAuth(payload);
      setStatus(`Device auth started. Enter code ${payload.userCode}; polling continues automatically.`);
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const pollDeviceOAuth = useCallback(async () => {
    if (!deviceAuth || devicePollingRef.current) {
      return;
    }

    devicePollingRef.current = true;
    setDevicePolling(true);
    setError(null);

    try {
      const result = await pollOpenAiDeviceOAuth(deviceAuth.deviceAuthId, deviceAuth.userCode);
      if (result.state === "pending") {
        setStatus("Authorization is still pending.");
        return;
      }

      if (result.state === "failed") {
        setError(result.reason ?? "OAuth device poll failed");
        return;
      }

      setStatus("OpenAI OAuth account saved from device flow.");
      setDeviceAuth(null);
      await refreshCredentials();
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : String(pollError));
    } finally {
      devicePollingRef.current = false;
      setDevicePolling(false);
    }
  }, [deviceAuth, refreshCredentials]);

  useEffect(() => {
    if (!deviceAuth) {
      return;
    }

    const intervalMs = Math.max(deviceAuth.intervalMs + 3000, 3000);
    const timer = window.setInterval(() => {
      void pollDeviceOAuth();
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [deviceAuth, pollDeviceOAuth]);

  return (
    <div className="credentials-layout">
      <section className="credentials-panel">
        <header>
          <h2>Credentials Manager</h2>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={revealSecrets}
              onChange={(event) => setRevealSecrets(event.currentTarget.checked)}
            />
            Reveal secrets
          </label>
        </header>

        <div className="credentials-provider-grid">
          {providers.map((provider) => (
            <article key={provider.id} className="credentials-card">
              <h3>{provider.id}</h3>
              <p>{provider.authType} · {provider.accountCount} account(s)</p>
              <ul>
                {provider.accounts.map((account) => (
                  <li key={account.id}>
                    <strong>{account.id}</strong>
                    <span>{account.secret ?? account.secretPreview}</span>
                    {account.refreshTokenPreview && (
                      <span>
                        refresh: {account.refreshToken ?? account.refreshTokenPreview}
                      </span>
                    )}
                    {typeof account.expiresAt === "number" && (
                      <span>expires: {new Date(account.expiresAt).toLocaleString()}</span>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="credentials-provider-grid">
          {providerHealth.map((provider) => (
            <article key={`health-${provider.providerId}`} className="credentials-card">
              <h3>{provider.providerId}</h3>
              <p>Recent logs: {provider.logs?.count ?? 0}</p>
              {provider.logs && <p>Last request: {new Date(provider.logs.lastTimestamp).toLocaleString()}</p>}
              {provider.keyPool ? (
                <>
                  <p>Accounts ready: {provider.keyPool.availableAccounts}/{provider.keyPool.totalAccounts}</p>
                  <p>Cooldown accounts: {provider.keyPool.cooldownAccounts}</p>
                </>
              ) : (
                <p>No key pool status yet.</p>
              )}
            </article>
          ))}
        </div>

        <form className="credentials-form" onSubmit={(event) => void handleApiKeySubmit(event)}>
          <h3>Add API key account</h3>
          <input
            value={apiKeyProvider}
            onChange={(event) => setApiKeyProvider(event.currentTarget.value)}
            placeholder="provider id"
          />
          <input
            value={apiKeyAccount}
            onChange={(event) => setApiKeyAccount(event.currentTarget.value)}
            placeholder="account id"
          />
          <input
            type="password"
            value={apiKeyValue}
            onChange={(event) => setApiKeyValue(event.currentTarget.value)}
            placeholder="api key"
          />
          <button type="submit">Save API key</button>
        </form>

        <div className="credentials-oauth">
          <h3>OpenAI OAuth</h3>
          <div className="credentials-oauth-row">
            <button type="button" onClick={() => void startBrowserOAuth()}>
              Start browser flow
            </button>
            <button type="button" onClick={() => void startDeviceOAuth()}>
              Start device flow
            </button>
            <button type="button" onClick={() => void pollDeviceOAuth()} disabled={!deviceAuth}>
              {devicePolling ? "Polling..." : "Poll device flow"}
            </button>
          </div>

          {deviceAuth && (
            <p>
              Visit <a href={deviceAuth.verificationUrl} target="_blank" rel="noreferrer">{deviceAuth.verificationUrl}</a> and enter code <strong>{deviceAuth.userCode}</strong>.
            </p>
          )}
        </div>

        {status && <p className="status-text">{status}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="credentials-panel">
        <header>
          <h2>Request Logs</h2>
        </header>

        <div className="credentials-log-filters">
          <input
            value={selectedProvider}
            onChange={(event) => setSelectedProvider(event.currentTarget.value)}
            placeholder="filter provider"
          />
          <input
            list="account-ids"
            value={selectedAccount}
            onChange={(event) => setSelectedAccount(event.currentTarget.value)}
            placeholder="filter account"
          />
          <datalist id="account-ids">
            {allAccountIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <button type="button" onClick={() => void refreshLogs()}>
            Refresh logs
          </button>
        </div>

        <div className="credentials-log-table">
          {logs.map((entry) => (
            <article key={entry.id}>
              <header>
                <strong>{entry.providerId}/{entry.accountId}</strong>
                <span>{entry.status} · {entry.latencyMs}ms</span>
              </header>
              <p>
                {entry.model} · {entry.upstreamMode} · {new Date(entry.timestamp).toLocaleString()}
                {typeof entry.totalTokens === "number" ? ` · ${entry.totalTokens} tok` : ""}
              </p>
              {entry.error && <small>{entry.error}</small>}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
