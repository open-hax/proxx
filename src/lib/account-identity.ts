interface JwtClaims {
  readonly sub?: string;
  readonly email?: string;
  readonly chatgpt_account_id?: string;
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_plan_type?: string;
  };
  readonly "https://api.openai.com/profile"?: {
    readonly email?: string;
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed as JwtClaims : undefined;
  } catch {
    return undefined;
  }
}

export function deriveOAuthMetadataFromToken(token: string): DerivedOAuthMetadata {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return {};
  }

  const profile = isRecord(claims["https://api.openai.com/profile"])
    ? claims["https://api.openai.com/profile"]
    : undefined;
  const auth = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : undefined;

  const email = (asString(claims.email) ?? asString(profile?.email))?.trim().toLowerCase();
  const subject = asString(claims.sub)?.trim();
  const chatgptAccountId = (asString(claims.chatgpt_account_id)
    ?? asString(auth?.chatgpt_account_id))?.trim();
  const planType = asString(auth?.chatgpt_plan_type)?.trim().toLowerCase();

  return {
    email: email && email.length > 0 ? email : undefined,
    subject: subject && subject.length > 0 ? subject : undefined,
    chatgptAccountId: chatgptAccountId && chatgptAccountId.length > 0 ? chatgptAccountId : undefined,
    planType: planType && planType.length > 0 ? planType : undefined,
  };
}

export function accountDisplayName(account: Pick<OAuthAccountIdentity, "email" | "chatgptAccountId"> & { readonly id: string }): string {
  return account.email ?? account.chatgptAccountId ?? account.id;
}

function normalizeEmail(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeSubject(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspace(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function openAiReauthIdentityMatches(target: OAuthAccountIdentity, resolved: OAuthAccountIdentity): boolean {
  const targetSubject = normalizeSubject(target.subject);
  const resolvedSubject = normalizeSubject(resolved.subject);
  if (targetSubject && resolvedSubject && targetSubject === resolvedSubject) {
    return true;
  }

  const targetEmail = normalizeEmail(target.email);
  const resolvedEmail = normalizeEmail(resolved.email);
  if (targetEmail && resolvedEmail && targetEmail === resolvedEmail) {
    return true;
  }

  const targetWorkspace = normalizeWorkspace(target.chatgptAccountId);
  const resolvedWorkspace = normalizeWorkspace(resolved.chatgptAccountId);
  return Boolean(targetWorkspace && resolvedWorkspace && targetWorkspace === resolvedWorkspace && !targetSubject && !targetEmail);
}
