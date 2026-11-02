// Loader for the CLJS proxy tests (proxx.proxy.harness-d).
//
// The host of the application (src/app.ts) is still TypeScript, and the CLJS
// node-test build runs inside a vm context that has no dynamic-import callback,
// so the import has to be issued from a real CommonJS module with the tsx
// loader registered.
const { register } = require("tsx/esm/api");

register();

exports.importModule = (specifier) => import(specifier);
