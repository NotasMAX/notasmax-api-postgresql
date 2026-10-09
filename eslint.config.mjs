import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  Headers: "readonly",
  ReadableStream: "readonly",
  TextEncoder: "readonly",
  URLSearchParams: "readonly",
  __dirname: "readonly",
  exports: "writable",
  module: "writable",
  process: "readonly",
  require: "readonly",
  setImmediate: "readonly",
};

export default defineConfig([
  globalIgnores(["node_modules/**", "dist/**", "coverage/**"]),
  {
    files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
    extends: [js.configs.recommended],
  },
  {
    files: ["**/*.{ts,cts,mts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
]);
