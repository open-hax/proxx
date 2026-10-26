import { kernels } from "../cljs-kernels.js";

/** Join a base URL and a path (`proxx.http.url`), normalising slashes and a doubled /v1. */
export const joinUrl = (baseUrl: string, path: string): string => kernels.joinUrl(baseUrl, path);
