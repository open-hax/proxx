import React from "react";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";

import { Button, Input, Modal, ThemeProvider, ToastProvider } from "@open-hax/uxx";
import type { ThemeName } from "@open-hax/uxx/tokens";
import { getProxyUiSettings, getSavedAuthToken, saveAuthToken, saveProxyUiSettings } from "./lib/api";
import { useStoredState } from "./lib/use-stored-state";
import { ChatPage } from "./pages/ChatPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HostsPage } from "./pages/HostsPage";
import { ToolsPage } from "./pages/ToolsPage";
import { ImagesPage } from "./pages/ImagesPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { FederationPage } from "./pages/FederationPage";

const LS_ONBOARDED = "open-hax-proxy.ui.onboarded";
const LS_THEME = "open-hax-proxy.ui.theme";

function parseThemeName(value: unknown): ThemeName | undefined {
  return value === "monokai" || value === "night-owl" ? value : undefined;
}

function navClass(isActive: boolean): string {
  return isActive ? "nav-link nav-link-active" : "nav-link";
}

export function App(): JSX.Element {
  const [themeName, setThemeName] = useStoredState<ThemeName>(LS_THEME, "monokai", parseThemeName);
  const [tokenInput, setTokenInput] = useState(() => getSavedAuthToken());
  const [savedToken, setSavedToken] = useState(() => getSavedAuthToken());
  const [showSaved, setShowSaved] = useState(false);
  const [fastMode, setFastMode] = useState(false);
  const [fastModeSaving, setFastModeSaving] = useState(false);
  const [fastModeMessage, setFastModeMessage] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    const stored = localStorage.getItem(LS_ONBOARDED);
    return stored !== "true" && getSavedAuthToken().trim().length === 0;
  });

  useEffect(() => {
    void getProxyUiSettings()
      .then((settings) => {
        setFastMode(settings.fastMode);
      })
      .catch((error) => {
        setFastModeMessage(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const handleSaveToken = () => {
    const trimmed = tokenInput.trim();
    saveAuthToken(trimmed);
    setSavedToken(trimmed);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
  };

  const handleDismissOnboarding = () => {
    const trimmed = tokenInput.trim();
    if (trimmed.length > 0) {
      saveAuthToken(trimmed);
      setSavedToken(trimmed);
    }
    localStorage.setItem(LS_ONBOARDED, "true");
    setShowOnboarding(false);
  };

  const handleFastModeToggle = async (nextValue: boolean) => {
    setFastMode(nextValue);
    setFastModeSaving(true);
    setFastModeMessage(null);

    try {
      const saved = await saveProxyUiSettings({ fastMode: nextValue });
      setFastMode(saved.fastMode);
      setFastModeMessage(saved.fastMode ? "Fast mode enabled for the current tenant." : "Fast mode disabled for the current tenant.");
    } catch (error) {
      setFastMode(!nextValue);
      setFastModeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setFastModeSaving(false);
    }
  };

  const location = useLocation();
  const isDashboard = location.pathname === "/" || location.pathname === "";

  const hasUnsavedChanges = tokenInput.trim() !== savedToken.trim();
  const hasStoredToken = savedToken.trim().length > 0;

  return (
    <ToastProvider position="top-right">
    <ThemeProvider theme={themeName} as="div" className="app-theme-root" style={{ minHeight: "100vh" }}>
    <div className={`shell-root${isDashboard ? " shell-root-dashboard" : ""}`}>
      <header className="shell-header">
        <div className="shell-brand">
          <h1>Proxx</h1>
        </div>

        <div className="shell-auth">
          <label htmlFor="proxy-token">Proxy Token</label>
          <div className="shell-auth-row">
            <input
              id="proxy-token"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.currentTarget.value)}
              placeholder="Bearer token for /api and /v1"
            />
            <button type="button" onClick={handleSaveToken} disabled={!hasUnsavedChanges}>
              Save
            </button>
          </div>
          <small>
              {showSaved
                ? "Token saved in browser storage."
                : hasStoredToken
                  ? hasUnsavedChanges
                    ? "Unsaved changes."
                    : "Token is stored for this browser."
                  : "No token set (works only if proxy allows unauthenticated access)."}
          </small>

          <div className="shell-settings-card">
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={fastMode}
                disabled={fastModeSaving}
                onChange={(event) => {
                  void handleFastModeToggle(event.currentTarget.checked);
                }}
              />
              Fast mode (priority tier)
            </label>
            <label className="toggle-row shell-theme-row">
              <span>Theme</span>
              <select
                value={themeName}
                onChange={(event) => setThemeName(parseThemeName(event.currentTarget.value) ?? "monokai")}
              >
                <option value="monokai">Monokai</option>
                <option value="night-owl">Night Owl</option>
              </select>
            </label>
            {fastModeMessage && <small>{fastModeMessage}</small>}
          </div>
        </div>
      </header>

      <nav className="shell-nav">
        <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
          Dashboard
        </NavLink>
        <NavLink to="/chat" className={({ isActive }) => navClass(isActive)}>
          Chat
        </NavLink>
        <NavLink to="/analytics" className={({ isActive }) => navClass(isActive)}>
          Analytics
        </NavLink>
        <NavLink to="/hosts" className={({ isActive }) => navClass(isActive)}>
          Hosts
        </NavLink>
        <NavLink to="/images" className={({ isActive }) => navClass(isActive)}>
          Images
        </NavLink>
        <NavLink to="/credentials" className={({ isActive }) => navClass(isActive)}>
          Credentials
        </NavLink>
        <NavLink to="/federation" className={({ isActive }) => navClass(isActive)}>
          Federation
        </NavLink>
        <NavLink to="/tools" className={({ isActive }) => navClass(isActive)}>
          Tools + MCP
        </NavLink>
      </nav>

      <main className="shell-main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/hosts" element={<HostsPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/credentials" element={<CredentialsPage />} />
          <Route path="/federation" element={<FederationPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </main>

      <Modal open={showOnboarding} onClose={() => setShowOnboarding(false)} size="sm">
        <h3 style={{ margin: "0 0 8px" }}>Welcome to Proxx</h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)" }}>
          Set your proxy token to get started. You can change this later from the header.
        </p>
        <Input
          type="password"
          value={tokenInput}
          onChange={(event) => setTokenInput(event.currentTarget.value)}
          placeholder="Bearer token for /api and /v1"
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
          <Button type="button" variant="primary" onClick={handleDismissOnboarding}>
            {tokenInput.trim().length > 0 ? "Save & Continue" : "Skip for now"}
          </Button>
        </div>
      </Modal>
    </div>
    </ThemeProvider>
    </ToastProvider>
  );
}
