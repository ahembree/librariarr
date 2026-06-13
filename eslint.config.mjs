import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: {
      react: {
        // Explicit version avoids eslint-plugin-react calling the removed
        // context.getFilename() API when set to "detect" (ESLint 10 compat).
        version: "19",
      },
    },
    rules: {
      // TanStack Virtual's useVirtualizer returns unstable function refs.
      // The React Compiler already skips these components automatically.
      "react-hooks/incompatible-library": "off",
    },
  },
  {
    // The recovery script is plain CommonJS (no TypeScript runner in prod),
    // so `require()` is expected here. Linting the rest of the codebase
    // with the TS ruleset is still desired.
    files: ["scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Documentation site has its own toolchain
    "docs/**",
    // Browser E2E suite has its own (Playwright) toolchain
    "e2e/**",
    "playwright.config.ts",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
