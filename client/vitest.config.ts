import { defineConfig } from "vitest/config";

// Client specs live under this directory; the Node relay's unit specs live in
// ../relay/node/src (the relay is a standalone service, but its tests run from
// here so one `npm test` covers the whole repo's JS/TS surface).
export default defineConfig({
  test: {
    include: ["**/*.spec.ts", "../relay/node/src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.next-tauri/**", "**/out/**"],
  },
});
