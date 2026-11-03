// The runtime is ClojureScript; ESLint only covers the JavaScript that remains
// (scripts, web tooling config, test setup).
import eslint from "@eslint/js";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  AbortController: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  performance: "readonly",
};

export default [
  eslint.configs.recommended,
  {
    ignores: [
      // Build output and compiler caches
      "dist/**",
      "target/**",
      ".shadow-cljs/**",
      "coverage/**",
      "web/dist/**",
      "web/public/js/**",
      // Dependencies
      "node_modules/**",
      // Config files using CommonJS
      "**/*.cjs",
      // Git worktrees
      ".worktrees/**",
    ],
  },
  {
    rules: {
      "complexity": ["warn", 20],
      "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "web/**/*.mjs"],
    languageOptions: { globals: nodeGlobals },
    rules: {
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Browser globals used inside page.evaluate callbacks
    files: ["web/test/e2e/**/*.mjs"],
    languageOptions: { globals: { window: "readonly", document: "readonly" } },
  },
];
