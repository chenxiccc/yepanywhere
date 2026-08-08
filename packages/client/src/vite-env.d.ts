/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Enable service worker in dev mode (default: false) */
  readonly VITE_ENABLE_SW?: string;
  /** Set to true in remote client build (requires SecureConnection for all API calls) */
  readonly VITE_IS_REMOTE_CLIENT?: boolean;
  /** Remote-client default relay URL override for static hosted deployments. */
  readonly VITE_DEFAULT_RELAY_URL?: string;
  /** Enables Playwright-only source transport smoke helpers. */
  readonly VITE_E2E_SOURCE_TRANSPORT_SMOKE?: string;
  /** Suppress the first-run onboarding dialog in test/dev builds. */
  readonly VITE_DISABLE_ONBOARDING?: string;
  /** Suppress CLI update dialogs in test/dev builds. */
  readonly VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build-time version from git describe (injected by Vite define) */
declare const __APP_VERSION__: string;

/** Vite dev-server port (injected by Vite define); used to detect direct access */
declare const __VITE_DEV_PORT__: number;

/** Main backend server port (injected by Vite define); link target for the wrong-port notice */
declare const __BACKEND_PORT__: number;
