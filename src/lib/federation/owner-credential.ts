import { kernels } from "../cljs-kernels.js";

export type FederationOwnerCredential =
  | {
      readonly kind: "admin_key";
      readonly value: string;
      readonly ownerSubject: string;
    }
  | {
      readonly kind: "at_did";
      readonly value: string;
      readonly ownerSubject: string;
    };

// Implementation: proxx.federation.owner (pure; the hash is injected by the CLJS edge).
export const isAtDid = (value: string | undefined): boolean => kernels.isAtDid(value);

export const normalizeAtDid = (value: string): string => kernels.normalizeAtDid(value);

export const fingerprintAdminKey = (value: string): string => kernels.fingerprintAdminKey(value);

export const parseFederationOwnerCredential = (raw: string | undefined): FederationOwnerCredential | undefined =>
  kernels.parseFederationOwnerCredential(raw);
