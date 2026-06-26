import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";

/**
 * Read the notifyInApp setting from localStorage
 */
function getNotifyInAppSetting(): boolean {
  return getServerScoped("notifyInApp", LEGACY_KEYS.notifyInApp) === "true";
}

/**
 * Sync a boolean setting to the service worker via postMessage.
 * 向 Service Worker 同步布尔设置（通过 postMessage）。
 */
function syncSettingToServiceWorker(value: boolean) {
  syncSettingToSW("notifyInApp", value);
}

/**
 * Sync the active session id to the service worker.
 * null means "not viewing any session" → do not suppress.
 * 向 SW 同步当前正在查看的会话 id；null 表示不在看任何会话（不抑制）。
 */
function syncActiveSessionIdToSW(value: string | null) {
  syncSettingToSW("activeSessionId", value);
}

/**
 * Low-level: post a setting-update message to the SW controller and the
 * registration's active worker (covers the case where the controller isn't
 * set yet, or the SW was just restarted).
 * 底层：向 SW controller 和 registration.active 发 setting-update 消息，
 * 覆盖 controller 尚未就绪或 SW 刚重启的场景。
 */
function syncSettingToSW(key: string, value: unknown) {
  if (!("serviceWorker" in navigator)) return;

  const msg = { type: "setting-update", key, value };

  // Sync to current controller if available
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  }

  // Also sync when SW becomes ready (handles SW restarts)
  navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage(msg);
    })
    .catch(() => {
      // SW registration may be unavailable; ignore — next lifecycle event re-syncs.
      // SW 注册可能不可用，忽略；下次生命周期事件会重新同步。
    });
}

/**
 * Extract the trailing session id from a router pathname.
 * Matches `/sessions/<id>` at the end of the path. Returns null when not on a
 * session detail route (list, projects, new-session, etc.).
 *
 * 从路由 pathname 末段提取 session id。匹配路径末尾的 `/sessions/<id>`。
 * 不在 session 详情路由（列表/项目/新建等）时返回 null。
 *
 * projectId is base64url ([A-Za-z0-9_-], no slashes) and sessionId is hex,
 * so the trailing segment is reliably the session id regardless of prefix
 * (direct mode `/projects/.../sessions/<id>` or relay mode `/<user>/.../sessions/<id>`).
 * projectId 是 base64url（不含 /）、sessionId 是 hex，故末段必为 session id，
 * 不受 direct 模式 `/projects/.../sessions/<id>` 或 relay 模式 `/<user>/.../sessions/<id>` 前缀影响。
 */
export function extractSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/sessions\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}

/**
 * Hook to sync notifyInApp setting to service worker on app startup.
 * Call this at the app level to ensure the setting persists across SW restarts.
 */
export function useSyncNotifyInAppSetting() {
  useEffect(() => {
    const value = getNotifyInAppSetting();
    syncSettingToServiceWorker(value);

    // Also handle when a new service worker takes over
    if ("serviceWorker" in navigator) {
      const handleControllerChange = () => {
        syncSettingToServiceWorker(getNotifyInAppSetting());
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        handleControllerChange,
      );
      return () => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          handleControllerChange,
        );
      };
    }
  }, []);
}

/**
 * Sync the currently-viewed session id to the service worker so push
 * notifications can suppress the session the user is already looking at.
 *
 * - On a session detail route: sync that session id.
 * - Off any session route: sync null (do not suppress).
 * - On SW controllerchange (new SW took over) and when the page becomes
 *   visible again (visibilitychange / pageshow, incl. bfcache restore):
 *   re-sync to cover the window where the SW was restarted and its in-memory
 *   settings reverted to defaults (activeSessionId = null).
 *
 * 把当前正在查看的 session id 同步给 SW，使推送能抑制用户正在看的会话。
 * - session 详情路由：同步该 session id
 * - 非 session 路由：同步 null（不抑制）
 * - SW controllerchange（新 SW 接管）及页面重新可见（visibilitychange / pageshow，
 *   含 bfcache 恢复）时重同步，覆盖 SW 被重启、内存 settings 回默认值（activeSessionId=null）的空窗。
 *
 * Must be called from inside a Router context (uses useLocation). Mounted in
 * both App.tsx (AppContent) and RemoteApp.tsx (RemoteAppInner) so direct and
 * relay entries are covered.
 * 必须在 Router 上下文内调用。同时挂载在 App.tsx (AppContent) 和
 * RemoteApp.tsx (RemoteAppInner)，覆盖 direct 与 relay 两套入口。
 */
export function useSyncActiveSessionId() {
  const location = useLocation();
  const activeSessionId = extractSessionIdFromPath(location.pathname);

  // ref so the visibility/pageshow listeners always read the latest id without
  // rebuilding themselves on every navigation.
  // 用 ref 让 visibility/pageshow 监听总能读到最新 id，而不必随导航重建监听。
  const ref = useRef(activeSessionId);
  ref.current = activeSessionId;

  // Re-sync whenever the active session changes (entering/leaving a session route)
  // 活跃 session 变化（进入/离开 session 路由）时重新同步
  useEffect(() => {
    syncActiveSessionIdToSW(activeSessionId);
  }, [activeSessionId]);

  // Re-sync on SW takeover and when the page regains visibility (the SW may
  // have been terminated + restarted while hidden, losing the synced id).
  // SW 接管及页面恢复可见时重新同步（隐藏期间 SW 可能被终止并重启，丢失已同步的 id）
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const resync = () => syncActiveSessionIdToSW(ref.current);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        resync();
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", resync);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", resync);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, []);
}

/**
 * Hook to manage the "notify when in app" setting.
 * When enabled, notifications will show even when the app is focused,
 * as long as the specific session isn't being viewed.
 */
export function useNotifyInApp() {
  const [notifyInApp, setNotifyInAppState] = useState(getNotifyInAppSetting);

  // Sync setting to service worker whenever it changes
  useEffect(() => {
    syncSettingToServiceWorker(notifyInApp);
  }, [notifyInApp]);

  const setNotifyInApp = useCallback((value: boolean) => {
    setServerScoped("notifyInApp", String(value), LEGACY_KEYS.notifyInApp);
    setNotifyInAppState(value);
  }, []);

  return { notifyInApp, setNotifyInApp };
}
