import type { FastifyInstance } from "fastify";
import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";

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

async function loadUiIndexHtml(): Promise<string | undefined> {
  const indexPath = await firstExistingPath([
    resolve(process.cwd(), "web/dist/index.html"),
    resolve(process.cwd(), "dist/web/index.html"),
    resolve(process.cwd(), "../web/dist/index.html"),
  ]);

  if (!indexPath) {
    return undefined;
  }

  return readFile(indexPath, "utf8");
}

async function resolveUiAssetPath(assetPath: string): Promise<string | undefined> {
  const normalized = assetPath.replace(/^\/+/, "");
  const candidates = [
    resolve(process.cwd(), "web/dist", normalized),
    resolve(process.cwd(), "dist/web", normalized),
    resolve(process.cwd(), "../web/dist", normalized),
  ];

  return firstExistingPath(candidates);
}

export async function registerStaticAssetRoutes(app: FastifyInstance): Promise<void> {
  // Static asset serving
  app.get<{ Params: { readonly assetPath: string } }>("/assets/:assetPath", async (request, reply) => {
    const filePath = await resolveUiAssetPath(`assets/${request.params.assetPath}`);
    if (!filePath) {
      reply.code(404).send({ error: "asset_not_found" });
      return;
    }

    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext === "js") {
      reply.type("application/javascript; charset=utf-8");
    } else if (ext === "css") {
      reply.type("text/css; charset=utf-8");
    }

    reply.send(await readFile(filePath));
  });

  const sendUiIndex = async (reply: { type: (value: string) => void; send: (value: unknown) => void }) => {
    const html = await loadUiIndexHtml();
    if (!html) {
      reply.send({ ok: true, name: "open-hax-openai-proxy", version: "0.1.0" });
      return;
    }

    reply.type("text/html; charset=utf-8");
    reply.send(html);
  };

  // SPA catch-all routes for UI pages
  for (const path of ["/chat", "/images", "/credentials", "/tools", "/hosts"] as const) {
    app.get(path, async (_request, reply) => {
      await sendUiIndex(reply);
    });
  }
}
