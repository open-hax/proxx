import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../../types.js";
import { loadMcpSeeds } from "../../../../lib/tool-mcp-seed.js";
import { resolve } from "node:path";
import { access } from "node:fs/promises";

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate.
    }
  }

  return undefined;
}

export async function registerMcpSeedRoutes(
  app: FastifyInstance,
  _deps: UiRouteDependencies,
): Promise<void> {
  let mcpSeedCache: { readonly loadedAt: number; readonly seeds: Awaited<ReturnType<typeof loadMcpSeeds>> } | undefined;

  const loadCachedMcpSeeds = async () => {
    const now = Date.now();
    if (mcpSeedCache && now - mcpSeedCache.loadedAt < 30_000) {
      return mcpSeedCache.seeds;
    }

    const ecosystemsDir = await firstExistingPath([
      resolve(process.cwd(), "../../../ecosystems"),
      resolve(process.cwd(), "../../ecosystems"),
      resolve(process.cwd(), "ecosystems"),
    ]);

    if (!ecosystemsDir) {
      return [];
    }

    const seeds = await loadMcpSeeds(ecosystemsDir).catch(() => []);
    mcpSeedCache = {
      loadedAt: now,
      seeds,
    };
    return seeds;
  };

  app.get("/api/ui/mcp-servers", async (_request, reply) => {
    const seeds = await loadCachedMcpSeeds();
    reply.send({
      count: seeds.length,
      servers: seeds,
    });
  });
}
