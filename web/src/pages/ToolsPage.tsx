import React from "react";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, Input } from "@open-hax/uxx";
import { listMcpSeeds, listToolSeeds, type McpServerSeed, type ToolSeed } from "../lib/api";
import { useStoredState } from "../lib/use-stored-state";

const LS_TOOLS_MODEL = "open-hax-proxy.ui.tools.model";

function validateString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function ToolsPage(): JSX.Element {
  const [model, setModel] = useStoredState(LS_TOOLS_MODEL, "gpt-5.3-codex", validateString);
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
    void refreshData(model.trim().length > 0 ? model.trim() : "gpt-5.3-codex").catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [model, refreshData]);

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
          <Input
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
            placeholder="model id"
          />
          <Button type="submit">Refresh</Button>
        </form>

        <div className="tools-grid">
          {tools.map((tool) => (
            <Card key={tool.id} variant={tool.enabled ? "default" : "outlined"}>
              <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{tool.id}</strong>
                <Badge variant={tool.enabled ? "success" : "warning"}>{tool.enabled ? "enabled" : "disabled"}</Badge>
              </header>
              <p>{tool.description}</p>
            </Card>
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
            <Card key={server.id}>
              <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{server.id}</strong>
                <Badge variant={server.running ? "success" : "default"}>{server.running ? "running" : "seeded"}</Badge>
              </header>
              <p>cwd: {server.cwd ?? "(none)"}</p>
              <p>script: {server.script}</p>
              {typeof server.port === "number" && <p>port: {server.port}</p>}
              <small>{server.sourceFile}</small>
            </Card>
          ))}
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
