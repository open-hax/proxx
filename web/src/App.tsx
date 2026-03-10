import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import { getSavedAuthToken, saveAuthToken } from "./lib/api";
import { ChatPage } from "./pages/ChatPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ToolsPage } from "./pages/ToolsPage";

function navClass(isActive: boolean): string {
  return isActive ? "nav-link nav-link-active" : "nav-link";
}

export function App(): JSX.Element {
  const [tokenInput, setTokenInput] = useState(() => getSavedAuthToken());
  const [savedToken, setSavedToken] = useState(() => getSavedAuthToken());
  const [showSaved, setShowSaved] = useState(false);

  const handleSaveToken = () => {
    const trimmed = tokenInput.trim();
    saveAuthToken(trimmed);
    setSavedToken(trimmed);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
  };

  const hasUnsavedChanges = tokenInput.trim() !== savedToken.trim();
  const hasStoredToken = savedToken.trim().length > 0;

  return (
    <div className="shell-root">
      <header className="shell-header">
        <div className="shell-brand">
          <h1>Open Hax Proxy Console</h1>
          <p>Usage, chat, credentials, and tools in one control surface.</p>
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
        </div>
      </header>

      <nav className="shell-nav">
        <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
          Dashboard
        </NavLink>
        <NavLink to="/chat" className={({ isActive }) => navClass(isActive)}>
          Chat
        </NavLink>
        <NavLink to="/credentials" className={({ isActive }) => navClass(isActive)}>
          Credentials
        </NavLink>
        <NavLink to="/tools" className={({ isActive }) => navClass(isActive)}>
          Tools + MCP
        </NavLink>
      </nav>

      <main className="shell-main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/credentials" element={<CredentialsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </main>
    </div>
  );
}
