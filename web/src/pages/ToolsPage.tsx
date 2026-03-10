import { FormEvent, useCallback, useEffect, useState } from "react";

import { listMcpSeeds, listToolSeeds, type McpServerSeed, type ToolSeed } from "../lib/api";

export function ToolsPage(): JSX.Element {
  const [model, setModel] = useState("gpt-5.3-codex");
  const [tools, setTools] = useState<ToolSeed[]>([]);
  const [servers, setServers] = useState<McpServerSeed[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async (nextModel: string) => {
    const [toolData, mcpData] = await Promise.all([
      listToolSeeds(nextModel),
      listMcpSeeds(),
    ]);
    setTools(toolData);
    setServers(mcpData);
  }, []);

  useEffect(() => {
    void refreshData("gpt-5.3-codex").catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [refreshData]);

  const handleModelSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await refreshData(model.trim().length > 0 ? model.trim() : "gpt-5.3-codex");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  return (
    <div className="tools-layout">
      <section className="tools-panel">
        <header>
          <h2>Tool Manager</h2>
          <p>Seeded from OpenCode defaults. GPT-family models use `apply_patch` policy.</p>
        </header>

        <form className="tools-model-form" onSubmit={(event) => void handleModelSubmit(event)}>
          <input
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
            placeholder="model id"
          />
          <button type="submit">Refresh</button>
        </form>

        <div className="tools-grid">
          {tools.map((tool) => (
            <article key={tool.id} className={tool.enabled ? "tool-card tool-card-enabled" : "tool-card tool-card-disabled"}>
              <header>
                <strong>{tool.id}</strong>
                <span>{tool.enabled ? "enabled" : "disabled"}</span>
              </header>
              <p>{tool.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tools-panel">
        <header>
          <h2>MCP Manager</h2>
          <p>Seeded from PM2 ecosystem definitions; servers start as disconnected by default.</p>
        </header>

        <div className="mcp-grid">
          {servers.map((server) => (
            <article key={server.id} className="mcp-card">
              <header>
                <strong>{server.id}</strong>
                <span>{server.running ? "running" : "seeded"}</span>
              </header>
              <p>cwd: {server.cwd ?? "(none)"}</p>
              <p>script: {server.script}</p>
              {typeof server.port === "number" && <p>port: {server.port}</p>}
              <small>{server.sourceFile}</small>
            </article>
          ))}
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
