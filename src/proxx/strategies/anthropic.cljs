(ns proxx.strategies.anthropic
  (:require [clojure.string :as str]))

(defn oauth-token? [secret]
  (and secret (str/starts-with? secret "sk-ant-oat01-")))

(def messages-passthrough
  (js* "async function(ctx) {
    try {
      var fetchFn = (ctx.fetch || globalThis.fetch);
      var endpoint = ctx.endpoint;
      var body = ctx.body;
      var credential = ctx.it || (ctx.credentials && ctx.credentials[0]);
      if (!credential) return null;
      var secret = credential.secret || credential.token;
      if (!fetchFn || !endpoint || !secret) return null;
      var isOauth = secret.startsWith('sk-ant-oat01-');
      var bodyStr = JSON.stringify(body);
      var headers = {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      };
      if (isOauth) {
        headers['authorization'] = 'Bearer ' + secret;
        headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        headers['x-app'] = 'cli';
        headers['user-agent'] = 'claude-cli/2.1.80 (external, sdk-cli)';
      } else {
        headers['x-api-key'] = secret;
      }
      return await fetchFn(endpoint, {method: 'POST', headers: headers, body: bodyStr});
    } catch(e) {
      return null;
    }
  }"))
