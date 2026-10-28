import type { CredentialProviderView, CredentialStoreLike } from "./credential-store.js";

/**
 * The credential store the host runs on (the SQL store when there is one, else
 * the file-backed one). Implemented in CLJS: `proxx.runtime.runtime-credential-store`,
 * constructed by `proxx.app.main`. This module only carries the type.
 */
export interface RuntimeCredentialStore extends CredentialStoreLike {
  listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]>;
  flush(): Promise<void>;
}
