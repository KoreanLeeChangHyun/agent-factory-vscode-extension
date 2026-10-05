import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Rest siblings omit a property; a leading underscore marks a deliberately unused binding.
const unusedVars = ["error", { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "releases/**", "static/vendor/**", "out/**", ".vscode-test/**"]
  },
  {
    // The two existing no-control-regex directives stay valid while that rule is outside the baseline.
    linterOptions: { reportUnusedDisableDirectives: "off" }
  },
  js.configs.recommended,
  {
    rules: {
      "no-unused-vars": unusedVars,
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Outside the zero-violation baseline; counts measured on 2026-10-05.
      "no-useless-escape": "off", // 17: regex and string edits across src and static/js
      "no-case-declarations": "off", // 13: needs braces around large switch cases
      "no-control-regex": "off", // 12: intentional ANSI and control-character patterns
      "preserve-caught-error": "off" // 2: attaching a cause changes the thrown error
    }
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser, sourceType: "module", globals: globals.node },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // tsc resolves names and types in TypeScript sources.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": unusedVars
    }
  },
  {
    files: ["static/js/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, acquireVsCodeApi: "readonly" } }
  },
  {
    // Loaded from static/vendor before this script.
    files: ["static/js/contracts.js"],
    languageOptions: { globals: { mermaid: "readonly" } }
  },
  {
    // Also exported through module.exports for the Node unit tests.
    files: ["static/js/localization.js"],
    languageOptions: { globals: { module: "readonly" } }
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node }
  },
  {
    files: ["scripts/**/*.cjs", "tests/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node }
  },
  {
    // Playwright callbacks in these files run inside the webview page.
    files: ["tests/browser/**/*.cjs"],
    languageOptions: { globals: globals.browser }
  },
  {
    // The test installs globalThis.wslMock for its bundled vscode mock.
    files: ["tests/unit/wsl-workspace.test.mjs"],
    languageOptions: { globals: { wslMock: "writable" } }
  }
];
