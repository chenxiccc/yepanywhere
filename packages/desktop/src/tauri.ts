import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type StartupView = "dashboard" | "server_output" | "tray_only";
export type DashboardCloseBehavior =
  | "unload_after_delay"
  | "keep_loaded"
  | "quit";
export type ServerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface AppConfig {
  setup_complete: boolean;
  agents: string[];
  /** User-specified port override. Undefined/null = auto-pick a free port on each launch. */
  port?: number | null;
  /** Backwards-compatible field for configs saved before startup_view. */
  start_minimized: boolean;
  startup_view: StartupView;
  dashboard_close_behavior: DashboardCloseBehavior;
}

export interface ServerOutputChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  data: string;
}

export async function getConfig(): Promise<AppConfig> {
  return invoke("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_app_config", { cfg: config });
}

export async function getDataDir(): Promise<string> {
  return invoke("get_data_dir");
}

/** Returns the dev directory path if YEP_DEV_DIR is set, or null otherwise. */
export async function isDevMode(): Promise<string | null> {
  return invoke("is_dev_mode");
}

export async function startServer(): Promise<void> {
  return invoke("start_server");
}

export async function stopServer(): Promise<void> {
  return invoke("stop_server");
}

export async function getServerStatus(): Promise<ServerStatus> {
  return invoke("get_server_status");
}

export async function getServerError(): Promise<string | null> {
  return invoke("get_server_error");
}

export async function getServerOutputBuffer(): Promise<ServerOutputChunk[]> {
  return invoke("get_server_output_buffer");
}

export async function openDashboardWindow(): Promise<void> {
  return invoke("open_dashboard_window");
}

export async function openServerOutputWindow(): Promise<void> {
  return invoke("open_server_output_window");
}

export async function openDiagnosticsWindow(): Promise<void> {
  return invoke("open_diagnostics_window");
}

export async function openUpdaterWindow(): Promise<void> {
  return invoke("open_updater_window");
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

export function onServerOutput(callback: (chunk: ServerOutputChunk) => void) {
  return listen<ServerOutputChunk>("server-output", (event) =>
    callback(event.payload),
  );
}
