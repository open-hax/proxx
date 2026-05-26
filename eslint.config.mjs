// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow underscore-prefixed parameters/variables as intentionally unused
      "@typescript-eslint/no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
      }],

      // Functional-TypeScript baseline: keep new code closer to CLJS data assumptions.
      "prefer-const": "warn",
      "no-var": "error",
      "no-param-reassign": ["warn", { "props": true }],
      "eqeqeq": ["error", "smart"],
      "no-else-return": "warn",
      "object-shorthand": "warn",
      "max-params": ["warn", 4],
    },
  },
  {
    ignores: [
      // Generated data files - they're meant to be large
      "src/lib/data/**/*.ts",
      // Build/generated output
      "dist/**",
      "web/dist/**",
      ".shadow-cljs/**",
      "target/**",
      "reports/**",
      // Dependencies
      "node_modules/**",
      // Config files using CommonJS
      "**/*.cjs",
      // Git worktrees
      ".worktrees/**",
    ],
  },
  {
    plugins: {
      sonarjs,
    },
    rules: {
      // ============================================================
      // COMPLEXITY RULES - CALIBRATED FOR GRADUAL IMPROVEMENT
      // ============================================================
      //
      // Relaxed thresholds to allow migration to route structure
      // Will tighten as code is reorganized
      // ============================================================

      // Cyclomatic complexity
      "complexity": ["warn", 20],

      // Cognitive complexity (SonarJS)
      "sonarjs/cognitive-complexity": ["warn", 30],

      // ============================================================
      // LINE COUNT RULES - CALIBRATED FOR GRADUAL IMPROVEMENT
      // ============================================================
      //
      // Relaxed thresholds to allow migration to route structure
      // ============================================================

      // Function line count (ESLint core)
      "max-lines-per-function": ["warn", {
        "max": 100,
        "skipBlankLines": true,
        "skipComments": true
      }],

      // File line count (ESLint core)
      "max-lines": ["warn", {
        "max": 500,
        "skipBlankLines": true,
        "skipComments": true
      }],
    },
  },
// ============================================================
// WORST OFFENDERS - ERROR LEVEL THRESHOLDS
// ============================================================
// Relaxed thresholds significantly to allow migration to new route structure
// These files are on the refactoring hit list
// ============================================================
  {
    files: [
      "src/app.ts",
      "src/lib/provider-strategy/fallback.ts",
      "src/lib/provider-strategy/shared.ts",
      "src/lib/responses-compat.ts",
      "src/lib/request-log-store.ts",
      "src/lib/db/sql-credential-store.ts",
      "src/lib/ui-routes.ts",
    ],
    rules: {
      "complexity": ["error", 200],
      "sonarjs/cognitive-complexity": ["error", 500],
      "max-lines-per-function": ["error", {
        "max": 1000,
        "skipBlankLines": true,
        "skipComments": true
      }],
      "@typescript-eslint/no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
      }],
    },
  },
  // New route files - more relaxed during migration
  {
    files: ["src/routes/**/*.ts"],
    rules: {
      "complexity": ["warn", 18],
      "sonarjs/cognitive-complexity": ["warn", 28],
      "max-lines-per-function": ["warn", {
        "max": 90,
        "skipBlankLines": true,
        "skipComments": true
      }],
      "max-lines": ["warn", {
        "max": 450,
        "skipBlankLines": true,
        "skipComments": true
      }],
    },
  },
  // New architecture directories - stricter functional/data-oriented defaults.
  // Legacy src/lib/** remains looser while code is migrated behind domain facades.
  {
    files: [
      "src/app/**/*.ts",
      "src/edge/**/*.ts",
      "src/policy/**/*.ts",
      "src/providers/**/*.ts",
      "src/tenants/**/*.ts",
      "src/federation/**/*.ts",
      "src/observability/**/*.ts",
      "src/persistence/**/*.ts",
      "src/sessions/**/*.ts",
      "src/support/**/*.ts",
    ],
    rules: {
      "complexity": ["warn", 12],
      "sonarjs/cognitive-complexity": ["warn", 18],
      "max-lines-per-function": ["warn", {
        "max": 60,
        "skipBlankLines": true,
        "skipComments": true,
      }],
      "max-lines": ["warn", {
        "max": 300,
        "skipBlankLines": true,
        "skipComments": true,
      }],
      "max-params": ["warn", 4],
      "no-param-reassign": ["warn", { "props": true }],
    },
  },
  // ============================================================
  // SCRIPTS - Allow CommonJS/Node globals
  // ============================================================
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: {
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
      },
    },
    rules: {
      // Scripts often have different complexity tolerances
      "max-lines-per-function": ["warn", {
        "max": 80,
        "skipBlankLines": true,
        "skipComments": true
      }],
    },
  },
);
