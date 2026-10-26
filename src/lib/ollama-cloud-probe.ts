import type { CredentialStoreLike } from "./credential-store.js";
import { kernels } from "./cljs-kernels.js";

export interface CredentialAccountProbeResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly testedAt: string;
  readonly model: string;
  readonly expectedText: string;
  readonly status: "ok" | "error";
  readonly ok: boolean;
  readonly matchesExpectedOutput: boolean;
  readonly outputText?: string;
  readonly upstreamStatus?: number;
  readonly errorCode?: string;
  readonly message: string;
}

/**
 * Live probe of an Ollama Cloud API-key account. The request, error reading and
 * result shape live in CLJS (proxx.ollama.cloud-probe); fetch and the timeout
 * are its edge.
 */
export async function probeOllamaCloudAccount(
  credentialStore: CredentialStoreLike,
  options: {
    readonly providerId: string;
    readonly accountId: string;
    readonly baseUrl: string;
    readonly model?: string;
    readonly fetchFn?: typeof fetch;
  },
): Promise<CredentialAccountProbeResult> {
  return await kernels.probeOllamaCloudAccount(credentialStore, options);
}
