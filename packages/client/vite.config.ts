import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { warningFreeBuildLogger } from "./vite-build-policy";
import { cspPlugin, shouldInlineClientAsset } from "./vite-plugin-csp";
import { reloadNotify } from "./vite-plugin-reload-notify";

// NO_FRONTEND_RELOAD: Disable HMR and use manual reload notifications instead
const noFrontendReload = process.env.NO_FRONTEND_RELOAD === "true";

// Port defaults to 3402 (base port 3400 + 2), can be overridden via VITE_PORT
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : 3402;

// VITE_HOST: Set to "true" to bind to all interfaces (needed in Docker containers)
const viteHost = process.env.VITE_HOST === "true" ? true : undefined;

function getGitVersion(): string {
  try {
    return execSync(
      "git describe --tags --always --match 'v[0-9]*.[0-9]*.[0-9]*'",
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
      .trim()
      .replace(/^v(?=\d)/, "");
  } catch {
    return "dev";
  }
}

export default defineConfig(({ command }) => ({
  build: {
    assetsInlineLimit: shouldInlineClientAsset,
    rollupOptions: {
      output: {
        // Match the hosted build's stable framework boundary so application
        // growth does not rebuild one near-limit entry chunk.
        manualChunks: {
          "react-runtime": ["react", "react-dom/client"],
        },
      },
    },
  },
  clearScreen: false,
  customLogger:
    command === "build" ? warningFreeBuildLogger("Client") : undefined,
  define: {
    __APP_VERSION__: JSON.stringify(getGitVersion()),
    // Injected so the client can detect direct access to the Vite dev port
    // (e.g. localhost:3402) and point users at the real app on the main server.
    // See WrongPortNotice in main.tsx. __BACKEND_PORT__ mirrors the server's own
    // derivation (config.ts: PORT ?? 3400) so it stays correct for custom ports.
    __VITE_DEV_PORT__: JSON.stringify(vitePort),
    __BACKEND_PORT__: JSON.stringify(
      process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3400,
    ),
  },
  plugins: [
    react(),
    // When HMR is disabled, use reload-notify plugin to tell backend about changes
    reloadNotify({ enabled: noFrontendReload }),
    // Content Security Policy (stricter in production, permissive in dev for HMR)
    cspPlugin({ isRemote: false }),
  ],
  resolve: {
    alias: {
      crypto: resolve(__dirname, "src/lib/connection/browserCrypto.ts"),
    },
    conditions: ["source"],
  },
  server: {
    port: vitePort,
    host: viteHost,
    allowedHosts: ["localhost", ".yepanywhere.com"],
    // HMR configuration for reverse proxy setup
    // When accessed through backend proxy (port 3400) or Tailscale, HMR needs to
    // connect back through the same proxy path, not directly to Vite's port
    hmr: noFrontendReload
      ? false
      : {
          // Let the client determine host/port from its current location
          // This allows HMR to work through any proxy (backend, Tailscale, etc.)
          // The backend will proxy WebSocket connections to us
        },
    // No proxy needed - backend (port 3400) proxies to us, not the other way around
    // Users access http://localhost:3400 and backend forwards non-API requests here
  },
}));
