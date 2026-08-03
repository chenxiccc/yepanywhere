/**
 * ConnectionBar - A thin warning bar at the top of the screen when the
 * transport needs attention.
 *
 * Uses the current source transport as the single source of truth:
 * - Orange (pulsing): reconnecting
 * - Red: disconnected
 */

import { useLocation } from "react-router-dom";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import styles from "./ConnectionBar.module.css";

/** Routes where we don't show the connection bar */
const LOGIN_ROUTES = ["/login", "/login/direct", "/login/relay"];

export function ConnectionBar() {
  const location = useLocation();
  const { connectionState } = useActivityBusState();
  const { showConnectionBars } = useDeveloperMode();

  // Don't show on login routes or if disabled in settings
  const isLoginRoute = LOGIN_ROUTES.some(
    (route) =>
      location.pathname === route || location.pathname.startsWith(`${route}/`),
  );
  if (isLoginRoute || !showConnectionBars) {
    return null;
  }

  // Map transport state to CSS class
  const status =
    connectionState === "reconnecting" ? "connecting" : connectionState;
  if (status === "connected") {
    return null;
  }

  const statusClass =
    status === "connecting" ? styles.connecting : styles.disconnected;
  return (
    <div
      className={`${styles.root} ${statusClass}`}
      data-connection-status={status}
    />
  );
}
