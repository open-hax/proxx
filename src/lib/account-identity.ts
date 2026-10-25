import { kernels } from "./cljs-kernels.js";

export interface DerivedOAuthMetadata {
  readonly email?: string;
  readonly subject?: string;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
}

export interface OAuthAccountIdentity {
  readonly email?: string;
  readonly subject?: string;
  readonly chatgptAccountId?: string;
}

export const deriveOAuthMetadataFromToken = (token: string): DerivedOAuthMetadata =>
  kernels.deriveOAuthMetadataFromToken(token) as DerivedOAuthMetadata;

export const accountDisplayName = (
  account: Pick<OAuthAccountIdentity, "email" | "chatgptAccountId"> & { readonly id: string },
): string => kernels.accountDisplayName(account);

export const openAiReauthIdentityMatches = (target: OAuthAccountIdentity, resolved: OAuthAccountIdentity): boolean =>
  kernels.openAiReauthIdentityMatches(target, resolved);
