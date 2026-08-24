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
 * - project-inactive: Project has no remaining active/background work
 * - ya-inactive: All YA-managed work is inactive
 * - dismiss: Close notification on other devices
 * - test: Test notification
 */

// Version constant for controlled updates
// Increment this when making intentional SW changes
// Browsers reinstall SW only when file content changes
const SW_VERSION = "1.0.10";
void SW_VERSION;
const FRONTEND_RELOAD_QUERY_PARAM = "__ya_reload";
const INCOMING_SHARE_QUERY_PARAM = "__ya_share";
const INCOMING_SHARE_DB_NAME = "ya-incoming-shares";
const INCOMING_SHARE_STORE_NAME = "shares";
const INCOMING_SHARE_DB_VERSION = 1;
const INCOMING_SHARE_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_INCOMING_SHARES = 4;
const MAX_INCOMING_SHARE_FILES = 8;
const MAX_INCOMING_SHARE_TOTAL_BYTES = 64 * 1024 * 1024;

// Resolve asset URLs relative to SW scope (handles /remote/ deployment)
function assetUrl(path) {
  return new URL(path, self.registration.scope).href;
}

// Settings synced from main thread
const settings = {
  notifyInApp: false, // When true, notify even when app is focused (if session not viewed)
};

/**
 * Browser connection presence is not a presentation signal. Only a focused
 * YA window can suppress an intent, and the local opt-in may still display it
 * when that focused window is not showing the affected session.
 */
function shouldPresentNotification({
  hasFocusedClient,
  notifyInApp,
  isSessionOpen,
}) {
  if (!hasFocusedClient) return true;
  if (!notifyInApp) return false;
  return !isSessionOpen;
}

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
  } catch {
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

function openIncomingShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      INCOMING_SHARE_DB_NAME,
      INCOMING_SHARE_DB_VERSION,
    );
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INCOMING_SHARE_STORE_NAME)) {
        db.createObjectStore(INCOMING_SHARE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function generateIncomingShareId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function storeIncomingShare(files) {
  const db = await openIncomingShareDb();
  const id = generateIncomingShareId();
  const now = Date.now();
  const record = {
    id,
    createdAt: now,
    files: files.map((file, index) => ({
      blob: file,
      name: file.name || `shared-image-${index + 1}.png`,
      type: file.type,
      lastModified: file.lastModified || now,
    })),
  };

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(INCOMING_SHARE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(INCOMING_SHARE_STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const retained = request.result
        .filter((candidate) => {
          const fresh =
            typeof candidate?.createdAt === "number" &&
            now - candidate.createdAt <= INCOMING_SHARE_TTL_MS;
          if (!fresh && typeof candidate?.id === "string") {
            store.delete(candidate.id);
          }
          return fresh;
        })
        .sort((left, right) => left.createdAt - right.createdAt);
      while (retained.length >= MAX_PENDING_INCOMING_SHARES) {
        const oldest = retained.shift();
        if (oldest?.id) store.delete(oldest.id);
      }
      store.put(record);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = resolve;
  }).finally(() => db.close());

  return id;
}

function isImageShare(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    value.type.startsWith("image/") &&
    typeof value.arrayBuffer === "function"
  );
}

function clientPriority(client) {
  if (client.focused) return 2;
  if (client.visibilityState === "visible") return 1;
  return 0;
}

function clientUrlWithinScope(client, scopeUrl) {
  try {
    const url = new URL(client.url);
    return (
      url.origin === scopeUrl.origin &&
      url.pathname.startsWith(scopeUrl.pathname)
    );
  } catch {
    return false;
  }
}

function isSessionClient(client, scopeUrl) {
  if (!clientUrlWithinScope(client, scopeUrl)) return false;
  const url = new URL(client.url);
  return /\/projects\/[^/]+\/sessions\/[^/]+\/?$/.test(url.pathname);
}

function appBasePathForClient(client, scopeUrl) {
  if (!client || !clientUrlWithinScope(client, scopeUrl)) {
    return scopeUrl.pathname.replace(/\/$/, "");
  }

  const pathname = new URL(client.url).pathname;
  const relayMarker = "/-/relay/";
  const relayStart = pathname.indexOf(relayMarker);
  if (relayStart < 0) return scopeUrl.pathname.replace(/\/$/, "");
  const usernameStart = relayStart + relayMarker.length;
  const usernameEnd = pathname.indexOf("/", usernameStart);
  return usernameEnd < 0 ? pathname : pathname.slice(0, usernameEnd);
}

function chooseIncomingShareTarget(clients, scopeUrl) {
  const ordered = [...clients].sort(
    (left, right) => clientPriority(right) - clientPriority(left),
  );
  // Android hides the source PWA while its system share sheet is open. Keep
  // matchAll()'s recency order as the tiebreaker so that hidden-but-open
  // session still receives the screenshot.
  const activeSession = ordered.find((client) =>
    isSessionClient(client, scopeUrl),
  );
  if (activeSession) return new URL(activeSession.url);

  const contextClient = ordered.find((client) =>
    clientUrlWithinScope(client, scopeUrl),
  );
  const basePath = appBasePathForClient(contextClient, scopeUrl);
  return new URL(`${basePath}/new-session`, scopeUrl.origin);
}

async function handleShareTargetRequest(request) {
  const formData = await request.formData();
  const files = formData.getAll("images").filter(isImageShare);
  if (files.length === 0) {
    return new Response("No shared image was received.", { status: 415 });
  }
  if (files.length > MAX_INCOMING_SHARE_FILES) {
    return new Response("Too many shared images were received.", {
      status: 413,
    });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_INCOMING_SHARE_TOTAL_BYTES) {
    return new Response("Shared images exceed the storage limit.", {
      status: 413,
    });
  }

  const shareId = await storeIncomingShare(files);
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const target = chooseIncomingShareTarget(
    clients,
    new URL(self.registration.scope),
  );
  target.searchParams.set(INCOMING_SHARE_QUERY_PARAM, shareId);
  return Response.redirect(target.href, 303);
}

/**
 * Network-first fetch for navigation requests (HTML pages).
 *
 * Prevents stale HTML from being served on mobile browsers / GitHub Pages
 * where aggressive caching can prevent new releases from being picked up.
 * Since HTML contains Vite's content-hashed asset URLs, fresh HTML = fresh everything.
 *
 * - cache: "no-cache" forces revalidation (sends If-None-Match for ETag-based 304s)
 * - Host picker loads use "reload" so an older Switch Host action that lacks
 *   YA's cache-busting query still crosses the client-version boundary.
 * - Fallback: if network is down, allows the browser's HTTP cache to serve what it has
 * - Only intercepts navigation (HTML) — hashed assets are immutable and don't need this
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const scopeUrl = new URL(self.registration.scope);
  const scopePath = scopeUrl.pathname.replace(/\/$/, "");
  const shareTargetPath = `${scopePath}/share-target`;
  if (
    event.request.method === "POST" &&
    url.origin === scopeUrl.origin &&
    (url.pathname === shareTargetPath || url.pathname === `${shareTargetPath}/`)
  ) {
    event.respondWith(handleShareTargetRequest(event.request));
    return;
  }

  if (event.request.mode === "navigate") {
    const hostPickerPath = `${scopePath}/login`;
    const isHostPicker =
      url.origin === scopeUrl.origin &&
      (url.pathname === hostPickerPath ||
        url.pathname === `${hostPickerPath}/`);
    const cacheMode =
      isHostPicker || url.searchParams.has(FRONTEND_RELOAD_QUERY_PARAM)
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
 * Activate immediately and claim open windows without navigating them. Claiming
 * changes which worker owns the next navigation; it does not reload the current
 * document. This is the upgrade bridge for older clients whose Switch Host action
 * predates YA's cache-busting reload URL.
 */
self.addEventListener("install", (_event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

  event.waitUntil(
    swLog("info", "Push received", {
      type: data.type,
      sessionId: data.sessionId,
      projectId: data.projectId,
    }).then(() => handlePush(data)),
  );
});

async function handlePush(data) {
  // Check app window state for notification suppression
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const focusedClients = clients.filter((client) => client.focused);
  const hasFocusedClient = focusedClients.length > 0;

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

  const sessionId = data.sessionId;
  const isSessionOpen = Boolean(
    sessionId &&
      focusedClients.some((client) =>
        client.url?.includes(`/sessions/${sessionId}`),
      ),
  );
  if (
    !shouldPresentNotification({
      hasFocusedClient,
      notifyInApp: settings.notifyInApp,
      isSessionOpen,
    })
  ) {
    console.log(
      isSessionOpen
        ? "[SW] Session is open in focused window, skipping notification"
        : "[SW] App is focused, skipping notification",
    );
    return;
  }

  // Handle different notification types
  if (data.type === "pending-input") {
    return showPendingInputNotification(data);
  }

  if (data.type === "session-halted") {
    return showSessionHaltedNotification(data);
  }

  if (data.type === "project-inactive") {
    return showProjectInactiveNotification(data);
  }

  if (data.type === "ya-inactive") {
    return showYaInactiveNotification(data);
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

function showProjectInactiveNotification(data) {
  const title = data.projectName || "Yep Anywhere";
  const options = {
    body: "Project is inactive",
    tag: `project-inactive-${data.projectId}`,
    icon: assetUrl("icon-192.png"),
    badge: assetUrl("badge-96.png"),
    data: {
      target: "project",
      projectId: data.projectId,
    },
  };

  return self.registration.showNotification(title, options);
}

function showYaInactiveNotification() {
  const options = {
    body: "All projects are inactive",
    tag: "ya-inactive",
    icon: assetUrl("icon-192.png"),
    badge: assetUrl("badge-96.png"),
    data: {
      target: "projects",
    },
  };

  return self.registration.showNotification("Yep Anywhere", options);
}

/**
 * Handle notification clicks.
 */
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};

  notification.close();

  event.waitUntil(handleNotificationClick(data));
});

async function handleNotificationClick(data) {
  const { sessionId, projectId, target } = data;

  await swLog("info", "Notification clicked", {
    sessionId,
    projectId,
    target,
  });

  if (target === "project") {
    return openProject(projectId);
  }

  if (target === "projects") {
    return openProjects();
  }

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
  return openAppPath(path, {
    sessionId,
    projectId,
    matchClient: (client) => sessionId && client.url.includes(sessionId),
  });
}

async function openProject(projectId) {
  const path = projectId
    ? `./projects?project=${encodeURIComponent(projectId)}`
    : "./projects";
  return openAppPath(path, {
    projectId,
    matchClient: (client) =>
      isProjectsPageUrl(client.url) ||
      (projectId &&
        client.url.includes(`project=${encodeURIComponent(projectId)}`)),
  });
}

async function openProjects() {
  return openAppPath("./projects", {
    matchClient: (client) => isProjectsPageUrl(client.url),
  });
}

function isProjectsPageUrl(url) {
  try {
    return new URL(url).pathname.endsWith("/projects");
  } catch {
    return false;
  }
}

async function openAppPath(path, context) {
  const url = new URL(path, self.registration.scope).href;
  const { matchClient, ...logContext } = context;

  await swLog("info", "Opening app URL", { url, ...logContext });

  // Try to focus an existing matching window, or open a new one.
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
    if (matchClient?.(client)) {
      await swLog("info", "Focusing existing matching window");
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
