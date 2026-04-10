/**
 * URL manipulation utilities.
 */

/**
 * Join a base URL with a path, handling edge cases like double slashes
 * and /v1 prefix normalization.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const baseLower = normalizedBase.toLowerCase();
  const pathLower = normalizedPath.toLowerCase();
  if (pathLower.startsWith("/v1/") && baseLower.endsWith("/v1")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}
