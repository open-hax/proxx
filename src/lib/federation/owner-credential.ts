import { createHash } from "node:crypto";

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

const DID_PLC_PATTERN = /^did:plc:[a-z2-7]{24}$/u;
const DID_WEB_PATTERN = /^did:web:[a-z0-9.-]+(?::[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/u;

export function isAtDid(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return DID_PLC_PATTERN.test(normalized) || DID_WEB_PATTERN.test(normalized);
}

export function normalizeAtDid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isAtDid(normalized)) {
    throw new Error(`invalid at did: ${value}`);
  }
  return normalized;
}

export function fingerprintAdminKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function parseFederationOwnerCredential(raw: string | undefined): FederationOwnerCredential | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }

  if (isAtDid(value)) {
    const did = normalizeAtDid(value);
    return {
      kind: "at_did",
      value: did,
      ownerSubject: did,
    };
  }

  return {
    kind: "admin_key",
    value,
    ownerSubject: `legacy_admin_key:${fingerprintAdminKey(value)}`,
  };
}
