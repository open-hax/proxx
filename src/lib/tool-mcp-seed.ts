import { kernels } from "./cljs-kernels.js";

export interface ToolSeed {
  readonly id: string;
  readonly description: string;
  readonly enabled: boolean;
}

export interface McpServerSeed {
  readonly id: string;
  readonly script: string;
  readonly cwd?: string;
  readonly args: readonly string[];
  readonly port?: number;
  readonly sourceFile: string;
  readonly running: false;
}

/** Coding tools a model gets (`proxx.mcp.seed`). */
export const getToolSeedForModel = (modelId: string): ToolSeed[] => kernels.getToolSeedForModel(modelId);

/** MCP servers declared in an ecosystems directory (`proxx.mcp.seed`, `proxx.runtime.mcp-seed`). */
export const loadMcpSeeds = (ecosystemsDir: string): Promise<McpServerSeed[]> =>
  kernels.loadMcpSeeds(ecosystemsDir) as Promise<McpServerSeed[]>;
