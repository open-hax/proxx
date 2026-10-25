import path from "node:path";

const DEFAULT_MANIFEST = "./resources/policies/runtime/00-manifest.edn";

/**
 * Absolute path of the runtime policy manifest the CLJS kernels read.
 * Honors the same environment aliases as `config.cljsPolicyManifestPath`.
 */
export function policyManifestPath(): string {
  const configured = [process.env["PROXX_CLJS_POLICY_MANIFEST"], process.env["PROXY_CLJS_POLICY_MANIFEST"]]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value.length > 0);
  return path.resolve(process.cwd(), configured ?? DEFAULT_MANIFEST);
}
