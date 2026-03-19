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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Documentation site has its own toolchain
    "docs/**",
  ]),
]);

export default eslintConfig;
