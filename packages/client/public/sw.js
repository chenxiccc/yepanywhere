/**
 * Service Worker for Push Notifications
 *
 * Handles:
 * - push: Receives push events and shows notifications
 * - notificationclick: Handles user clicking on notifications
 * - message: Receives settings updates from main thread
 *
 * Payload types (from server):
 * - pending-input: Session needs approval or user question
 * - session-halted: Session stopped working
 * - dismiss: Close notification on other devices
 * - test: Test notification
 */

// Version constant for controlled updates
// Increment this when making intentional SW changes
// Browsers reinstall SW only when file content changes
//
// 1.0.6: session suppression uses activeSessionId synced from the page (the
//        SPA's current route is not readable from client.url, which stays at
//        the navigation start URL). Visibility also falls back to
//        visibilityState since client.focused alone is unreliable on mobile.
// 1.0.6: 会话抑制改用页面同步的 activeSessionId（SPA 当前路由无法从
//        client.url 读取，它停留在导航起始 URL）。可见性判断增加
//        visibilityState 兜底，因 client.focused 在手机端单独不可靠。
// 1.0.7: notifyInApp default changed to true. A SW restarted by a push reverts
//        in-memory settings to defaults; defaulting to false silently dropped
//        foreground pushes after a restart. Defaulting true is restart-safe
//        (prefer to notify; activeSessionId still suppresses the viewed session).
// 1.0.7: notifyInApp 默认值改为 true。SW 被 push 重启后内存设置回默认值，
//        原 false 默认会导致重启后前台推送被静默丢弃。true 为重启安全默认
//        （宁可通知；activeSessionId 仍抑制正在看的会话）。
const SW_VERSION = "1.0.7";
void SW_VERSION;
const FRONTEND_RELOAD_QUERY_PARAM = "__ya_reload";

// Resolve asset URLs relative to SW scope (handles /remote/ deployment)
function assetUrl(path) {
  return new URL(path, self.registration.scope).href;
}

// Settings synced from main thread via postMessage({type:"setting-update",key,value}).
// The message handler whitelists keys with `key in settings`, so every key
// that the page may sync MUST be declared here or the update is silently dropped.
// 通过 postMessage 同步的设置。message handler 用 `key in settings` 做白名单，
// 故页面可能同步的每个 key 都必须在此声明，否则更新会被静默丢弃。
const settings = {
  // Default true: when the SW is restarted by a push, in-memory settings revert
  // to these defaults and the main thread won't re-sync until the next
  // lifecycle event. If this defaulted to false, a foreground push right after
  // a SW restart would be silently suppressed (notifyInApp=false → "app visible,
  // skip"). Defaulting to true makes restart-safe behavior "prefer to notify"
  // (the activeSessionId check still suppresses the session being viewed); the
  // main thread corrects this to the user's real setting shortly after.
  // 默认 true：SW 被 push 唤醒重启时内存 settings 回到此默认值，且主线程在下次
  // 生命周期事件前不会重新同步。若默认 false，SW 重启后前台推送会被静默抑制
  // （notifyInApp=false → "app 可见，跳过"）。默认 true 使重启后"宁可通知"，
  // activeSessionId 检查仍会抑制正在看的会话；主线程随后会修正为用户真实设置。
  notifyInApp: true,
  // Currently-viewed session id synced from the page (null when not on a
  // session route). The page tracks the SPA route because client.url does not
  // update with client-side navigation.
  // 页面同步的"当前正在查看的 session id"（不在 session 路由时为 null）。
  // 因 client.url 不随客户端导航更新，由页面追踪 SPA 路由。
  activeSessionId: null,
};

// ============ Debug Logging ============
// Logs are stored in IndexedDB for retrieval via main thread

const LOG_DB_NAME = "sw-logs";
const LOG_STORE_NAME = "logs";
const MAX_LOGS = 100;

async function openLogDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOG_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(LOG_STORE_NAME)) {
        db.createObjectStore(LOG_STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
      }
    };
  });
}

async function swLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, data };

  // Always log to console
  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  consoleMethod(`[SW ${level.toUpperCase()}]`, message, data);

  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readwrite");
    const store = tx.objectStore(LOG_STORE_NAME);

    // Add new log
    store.add(logEntry);

    // Prune old logs
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      if (countRequest.result > MAX_LOGS) {
        const cursor = store.openCursor();
        let deleted = 0;
        const toDelete = countRequest.result - MAX_LOGS;
        cursor.onsuccess = (e) => {
          const c = e.target.result;
          if (c && deleted < toDelete) {
            c.delete();
            deleted++;
            c.continue();
          }
        };
      }
    };

    await tx.complete;
    db.close();
  } catch (_e) {
    // Silently fail if IndexedDB not available
  }
}

// Expose logs retrieval via message
async function getSwLogs() {
  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readonly");
    const store = tx.objectStore(LOG_STORE_NAME);

    return new Promise((resolve) => {
      const request = store.getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result || []);
      };
      request.onerror = () => {
        db.close();
        resolve([]);
      };
    });
  } catch {
    return [];
  }
}

async function clearSwLogs() {
  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readwrite");
    tx.objectStore(LOG_STORE_NAME).clear();
    await tx.complete;
    db.close();
  } catch {
    // Ignore
  }
}

/**
 * Network-first fetch for navigation requests (HTML pages).
 *
 * Prevents stale HTML from being served on mobile browsers / GitHub Pages
 * where aggressive caching can prevent new releases from being picked up.
 * Since HTML contains Vite's content-hashed asset URLs, fresh HTML = fresh everything.
 *
 * - cache: "no-cache" forces revalidation (sends If-None-Match for ETag-based 304s)
 * - Fallback: if network is down, allows the browser's HTTP cache to serve what it has
 * - Only intercepts navigation (HTML) — hashed assets are immutable and don't need this
 */
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    const url = new URL(event.request.url);
    const cacheMode = url.searchParams.has(FRONTEND_RELOAD_QUERY_PARAM)
      ? "reload"
      : "no-cache";
    event.respondWith(
      fetch(event.request, { cache: cacheMode }).catch(() =>
        fetch(event.request),
      ),
    );
  }
});

/**
 * Service Worker Lifecycle: Install & Activate
 *
 * We use skipWaiting() to activate immediately, but are careful with clients.claim().
 *
 * Problem: Calling clients.claim() while pages are loading can disrupt in-flight
 * network requests (SSE connections, fetches), causing the page to appear to "reload".
 * This is especially noticeable in dev mode where the SW updates frequently, or on
 * mobile browsers with aggressive SW update checking.
 *
 * Solution: Only claim clients if there are no windows currently open. This means:
 * - First visit: SW installs but doesn't claim until next navigation
 * - SW update with tabs open: New SW waits, old SW continues serving
 * - SW update with no tabs: New SW claims immediately
 *
 * Potential drawbacks:
 * - Push notifications may be handled by old SW until user navigates/refreshes
 * - Settings synced via postMessage won't reach new SW until it claims
 * - In production this is rarely an issue; mainly affects dev mode with frequent updates
 *
 * Alternative: Remove skipWaiting() entirely for fully lazy updates, but this delays
 * all SW updates until all tabs close (could be days).
 */
self.addEventListener("install", (_event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windowClients) => {
      // Only claim if no windows are open - avoids disrupting active pages
      if (windowClients.length === 0) {
        return self.clients.claim();
      }
      // Otherwise, let pages naturally pick up new SW on next navigation
      console.log(
        `[SW] Skipping claim - ${windowClients.length} window(s) open`,
      );
    }),
  );
});

/**
 * Handle messages from main thread
 */
self.addEventListener("message", async (event) => {
  if (event.data?.type === "setting-update") {
    const { key, value } = event.data;
    if (key in settings) {
      settings[key] = value;
      await swLog("info", `Setting updated: ${key} = ${value}`);
    }
  }

  // Log retrieval for debugging
  if (event.data?.type === "get-sw-logs") {
    const logs = await getSwLogs();
    event.ports[0]?.postMessage({ logs });
  }

  // Clear logs
  if (event.data?.type === "clear-sw-logs") {
    await clearSwLogs();
    event.ports[0]?.postMessage({ cleared: true });
  }
});

/**
 * Handle incoming push notifications
 */
self.addEventListener("push", (event) => {
  if (!event.data) {
    event.waitUntil(swLog("warn", "Push event with no data"));
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    event.waitUntil(
      swLog("error", "Failed to parse push data", { error: e.message }),
    );
    return;
  }

  // Run handlePush and the log write in parallel so IndexedDB log writes do
  // not delay notification display. Both still resolve before the push event
  // settles (event.waitUntil keeps the SW alive for both).
  // 并行执行 handlePush 与日志写入，避免 IndexedDB 日志写入延迟通知显示。
  event.waitUntil(
    Promise.all([
      handlePush(data),
      swLog("info", "Push received", {
        type: data.type,
        sessionId: data.sessionId,
      }),
    ]),
  );
});

async function handlePush(data) {
  // Check app window state for notification suppression
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  // A client counts as "visible" if focused OR visibilityState === "visible".
  // client.focused alone is unreliable on mobile (can be false in foreground),
  // so visibilityState acts as a fallback. Either signal being visible means
  // the user can see the app — suppress per the rules below.
  // 当 focused 或 visibilityState==="visible" 即视为"可见"。client.focused 在
  // 手机端单独不可靠（前台也可能为 false），故用 visibilityState 兜底。
  const hasVisibleClient = clients.some(
    (client) => client.focused || client.visibilityState === "visible",
  );

  // Handle dismiss payload - close matching notification
  if (data.type === "dismiss") {
    const notifications = await self.registration.getNotifications({
      tag: `session-${data.sessionId}`,
    });
    for (const notification of notifications) {
      notification.close();
    }
    return;
  }

  // Test notifications always show (user explicitly requested them)
  if (data.type === "test") {
    // Urgency controls notification behavior:
    // - normal: auto-dismiss (requireInteraction: false)
    // - persistent: stays visible until dismissed (requireInteraction: true)
    // - silent: no sound (silent: true)
    const urgency = data.urgency || "normal";
    const options = {
      body: data.message || "Test notification",
      tag: "test",
      icon: assetUrl("icon-192.png"),
      badge: assetUrl("badge-96.png"),
      requireInteraction: urgency === "persistent",
      silent: urgency === "silent",
    };
    return self.registration.showNotification("Yep Anywhere", options);
  }

  // Determine if we should suppress notification.
  // Only suppress when the app is visible — backgrounded/locked devices always
  // show (the SW may have stale synced settings after being restarted, so rely
  // on the live client visibility here, not a synced boolean).
  // 仅在 app 可见时才考虑抑制；后台/锁屏一律显示（SW 重启后同步值可能过期，
  // 故此处用实时 client 可见性，而非同步布尔值）。
  if (hasVisibleClient) {
    if (settings.notifyInApp) {
      // Suppress only if the user is currently viewing THIS session.
      // activeSessionId is synced from the page (client.url does not track SPA
      // navigation). If it's null (SW just restarted, not synced yet) we treat
      // it as "not viewing" → show (prefer a spurious notify over a missed one).
      // 仅当用户正在看此会话时抑制。activeSessionId 由页面同步（client.url 不随
      // SPA 导航更新）。若为 null（SW 刚重启尚未同步）按"不在看"处理 → 显示
      //（宁可误推一条，不漏推）。
      const sessionId = data.sessionId;
      const isSessionOpen =
        sessionId && settings.activeSessionId === sessionId;

      if (isSessionOpen) {
        console.log(
          "[SW] Session is open in visible window, skipping notification",
        );
        return;
      }
      // Session not open - continue to show notification
    } else {
      // notifyInApp disabled - skip if app is visible
      console.log("[SW] App is visible, skipping notification");
      return;
    }
  }

  // Handle different notification types
  if (data.type === "pending-input") {
    return showPendingInputNotification(data);
  }

  if (data.type === "session-halted") {
    return showSessionHaltedNotification(data);
  }

  console.warn("[SW] Unknown push type:", data.type);
}

async function showPendingInputNotification(data) {
  const title = data.projectName || "Yep Anywhere";
  const options = {
    body: data.summary || "Waiting for input",
    tag: `session-${data.sessionId}`,
    icon: assetUrl("icon-192.png"),
    badge: assetUrl("badge-96.png"),
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
    },
    requireInteraction: true,
  };

  await swLog("info", "Showing pending-input notification", {
    sessionId: data.sessionId,
    inputType: data.inputType,
  });

  return self.registration.showNotification(title, options);
}

function showSessionHaltedNotification(data) {
  const title = data.projectName || "Yep Anywhere";
  const reasonText = {
    completed: "Task completed",
    error: "Task encountered an error",
    idle: "Task stopped",
  };
  const body = reasonText[data.reason] || "Session stopped";

  const options = {
    body,
    tag: `session-halted-${data.sessionId}`,
    icon: assetUrl("icon-192.png"),
    badge: assetUrl("badge-96.png"),
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
    },
  };

  return self.registration.showNotification(title, options);
}

/**
 * Handle notification clicks - always open the session
 */
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};

  notification.close();

  event.waitUntil(handleNotificationClick(data));
});

async function handleNotificationClick(data) {
  const { sessionId, projectId } = data;

  await swLog("info", "Notification clicked", { sessionId, projectId });

  return openSession(sessionId, projectId);
}

/**
 * Open the session in the app window
 */
async function openSession(sessionId, projectId) {
  // Build the URL to open - must be absolute for Android compatibility
  // Use relative paths (./) so URL API properly resolves against SW scope
  // (absolute paths like /foo would ignore the scope's path prefix like /remote/)
  let path = "./";
  if (sessionId && projectId) {
    path = `./projects/${encodeURIComponent(projectId)}/sessions/${sessionId}`;
  }
  const url = new URL(path, self.registration.scope).href;

  await swLog("info", "Opening session URL", { url, sessionId, projectId });

  // Try to focus an existing window with this session, or open a new one
  // includeUncontrolled: true ensures we find windows that haven't been claimed yet
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  await swLog("info", "Found clients", {
    count: clients.length,
    urls: clients.map((c) => c.url),
  });

  // Look for an existing window we can focus
  for (const client of clients) {
    // If already on this session, just focus
    if (sessionId && client.url.includes(sessionId)) {
      await swLog("info", "Focusing existing session window");
      return client.focus();
    }
  }

  // Try to navigate an existing window
  for (const client of clients) {
    if ("navigate" in client) {
      await swLog("info", "Navigating existing window", {
        clientUrl: client.url,
      });
      try {
        await client.navigate(url);
        return client.focus();
      } catch (e) {
        await swLog("error", "Failed to navigate window", { error: e.message });
      }
    }
  }

  // Open a new window as fallback
  if (self.clients.openWindow) {
    await swLog("info", "Opening new window");
    try {
      return await self.clients.openWindow(url);
    } catch (e) {
      await swLog("error", "Failed to open window", { error: e.message, url });
    }
  } else {
    await swLog("error", "openWindow not available");
  }
}
