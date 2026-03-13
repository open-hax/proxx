/**
 * Shared formatting utilities used across Dashboard and Credentials pages.
 */

const AUTH_TYPE_LABELS: Record<string, string> = {
  api_key: "API Key",
  oauth_bearer: "OAuth",
  local: "Local",
  none: "None",
  unknown: "Unknown",
};

/**
 * Returns a human-friendly label for an auth type string.
 *
 * Known values are mapped explicitly; anything else gets its first letter
 * capitalised so the UI never shows raw snake_case identifiers.
 */
export function formatAuthType(authType: string): string {
  const mapped = AUTH_TYPE_LABELS[authType];
  if (mapped) {
    return mapped;
  }

  return authType.charAt(0).toUpperCase() + authType.slice(1);
}
