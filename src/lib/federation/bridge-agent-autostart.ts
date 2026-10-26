import type { CredentialStoreLike } from "../credential-store.js";
import type { ProxyConfig } from "../config.js";
import type { KeyPool } from "../key-pool.js";
import { kernels } from "../cljs-kernels.js";
import {
  createFederationBridgeAgent,
  type BridgeRequestHandlerResult,
  type FederationBridgeAgent,
} from "./bridge-agent.js";

interface LoggerLike {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
}

interface FederationBridgeAutostartDeps {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly credentialStore: CredentialStoreLike;
  readonly logger: LoggerLike;
  readonly getResolvedModelCatalog?: () => Promise<{ readonly modelIds: readonly string[] }>;
  readonly handleBridgeRequest?: (input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
    readonly ownerSubject: string;
    readonly tenantId?: string;
  }) => Promise<BridgeRequestHandlerResult>;
}

/**
 * Build the bridge agent from FEDERATION_BRIDGE_* environment. Configuration, capabilities and
 * health are proxx.federation.autostart (pure) behind proxx.runtime.federation-autostart.
 */
export function createEnvFederationBridgeAgent(deps: FederationBridgeAutostartDeps): FederationBridgeAgent | undefined {
  const options = kernels.createEnvFederationBridgeAgentOptions(deps);
  return options ? createFederationBridgeAgent(options) : undefined;
}
