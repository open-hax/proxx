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
    },
  },
  {
    ignores: [
      // Generated data files - they're meant to be large
      "src/lib/data/**/*.ts",
      // Build output
      "dist/**",
      "web/dist/**",
      // Dependencies
      "node_modules/**",
      // Config files using CommonJS
      "*.cjs",
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
        "max": 3000,
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
