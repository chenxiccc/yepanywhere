import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/AuthService.js";
import { attachUnifiedUpgradeHandler } from "../src/frontend/index.js";
import { RemoteSessionService } from "../src/remote-access/RemoteSessionService.js";
import { RemoteAccessService } from "../src/remote-access/index.js";
import { createWsRelayRoutes } from "../src/routes/ws-relay.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { UploadManager } from "../src/uploads/manager.js";
import { EventBus } from "../src/watcher/index.js";

const username = process.env.YA_NATIVE_PROBE_USERNAME;
const password = process.env.YA_NATIVE_PROBE_PASSWORD;
const requestedPort = Number.parseInt(process.env.YA_NATIVE_PROBE_PORT ?? "38901", 10);

if (!username || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(username)) {
  throw new Error("YA_NATIVE_PROBE_USERNAME must be a valid 3-32 character SRP identity");
}
if (!password || password.length < 8) {
  throw new Error("YA_NATIVE_PROBE_PASSWORD must contain at least 8 characters");
}
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
  throw new Error("YA_NATIVE_PROBE_PORT must be an unprivileged TCP port");
}

const root = await mkdtemp(join(tmpdir(), "ya-android-native-probe-"));
const projectsDir = join(root, "projects");
const dataDir = join(root, "data");
await mkdir(projectsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const eventBus = new EventBus();
const authService = new AuthService({
  dataDir,
  cookieSecret: "android-native-probe-cookie-secret",
});
await authService.initialize();

const remoteAccessService = new RemoteAccessService({ dataDir });
await remoteAccessService.initialize();
// The production state model currently stores SRP identity with relay config.
// This harness supplies the value without starting RelayClientService, so no
// registration, DNS lookup, or relay retry occurs.
await remoteAccessService.setRelayConfig({
  url: "wss://unused.invalid/ws",
  username,
});
await remoteAccessService.configure(password);

const remoteSessionService = new RemoteSessionService({ dataDir });
await remoteSessionService.initialize();

const { app, supervisor } = createApp({
  sdk: new MockClaudeSDK(),
  projectsDir,
  eventBus,
  authService,
  authDisabled: true,
});
const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
const uploadManager = new UploadManager({ uploadsDir: join(root, "uploads") });
const wsHandler = createWsRelayRoutes({
  upgradeWebSocket,
  app,
  baseUrl: `http://127.0.0.1:${requestedPort}`,
  supervisor,
  eventBus,
  uploadManager,
  remoteAccessService,
  remoteSessionService,
});
app.get("/api/ws", wsHandler);

let server: ReturnType<typeof serve>;
await new Promise<void>((resolveReady) => {
  server = serve(
    {
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: requestedPort,
    },
    ({ port }) => {
      console.log(
        `YA_NATIVE_PROBE_READY ${JSON.stringify({ port, username, data: "temporary" })}`,
      );
      resolveReady();
    },
  );
});
attachUnifiedUpgradeHandler(server!, {
  frontendProxy: undefined,
  isApiPath: (path) => path.startsWith("/api"),
  app,
  wss,
});

await new Promise<void>((resolveStop) => {
  process.once("SIGINT", resolveStop);
  process.once("SIGTERM", resolveStop);
});

remoteSessionService.shutdown();
await new Promise<void>((resolveClosed) => server!.close(() => resolveClosed()));
wss.close();
await rm(root, { recursive: true, force: true });
