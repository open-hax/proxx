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

const DID_PLC_PATTERN = /^did:plc:[a-z2-7]{24}$/iu;
const DID_WEB_PATTERN = /^did:web:[a-z0-9.-]+(?:[:/][A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/iu;

export function isAtDid(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }

  return DID_PLC_PATTERN.test(normalized) || DID_WEB_PATTERN.test(normalized);
}

export function normalizeAtDid(value: string): string {
  const normalized = value.trim();
  if (!isAtDid(normalized)) {
    throw new Error(`invalid at did: ${value}`);
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("did:web:")) {
    const identifier = normalized.slice("did:web:".length);
    const slashIndex = identifier.indexOf("/");
    const colonIndex = identifier.indexOf(":");
    const separatorIndex = [slashIndex, colonIndex]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const host = (separatorIndex >= 0 ? identifier.slice(0, separatorIndex) : identifier).toLowerCase();
    const path = separatorIndex >= 0 ? identifier.slice(separatorIndex) : "";
    return `did:web:${host}${path}`;
  }

  return lower;
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
