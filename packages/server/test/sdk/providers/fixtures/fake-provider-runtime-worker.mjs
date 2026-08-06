import { rmSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.env.YEP_PROVIDER_WORKER_SOCKET;
if (!socketPath) throw new Error("missing worker socket");

let launchInput = "";
for await (const chunk of process.stdin) launchInput += chunk;
const launchRequest = JSON.parse(launchInput);

try {
  rmSync(socketPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const sockets = new Set();
let attachedCount = 0;
let acknowledgedSequence = 0;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const request = JSON.parse(rawLine);
      if (request.type === "attach") {
        attachedCount += 1;
        socket.write(
          `${JSON.stringify({
            type: "attached",
            protocolVersion: 1,
            acknowledgedSequence,
            queueDepth: 0,
            providerAlive: true,
          })}\n`,
        );
        const sequence = attachedCount;
        socket.write(
          `${JSON.stringify({
            type: "event",
            sequence,
            message: {
              type: "system",
              subtype: "init",
              session_id: `fake-session-${sequence}`,
            },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "approval",
            requestId: "fake-pending-approval",
            toolName: "FakeTool",
            input: { attachment: attachedCount },
          })}\n`,
        );
        if (launchRequest.providerName === "pi") {
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({
                type: "approvalCancelled",
                requestId: "fake-pending-approval",
              })}\n`,
            );
          }, 20);
        }
      } else if (request.type === "ack") {
        acknowledgedSequence = Math.max(acknowledgedSequence, request.sequence);
      } else if (request.type === "rpc") {
        socket.write(
          `${JSON.stringify({
            type: "rpcResult",
            id: request.id,
            ok: true,
          })}\n`,
        );
      } else if (request.type === "approvalResult") {
        // The integration test observes callback dispatch in the Hono proxy;
        // the fake worker only needs to accept its answer.
      }
    }
  });
  socket.on("close", () => sockets.delete(socket));
});

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}

process.on("message", (message) => {
  if (message?.type === "shutdown") shutdown();
});
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);

server.listen(socketPath, () => {
  process.send?.({
    type: "ready",
    metadata: {
      queueDepth: 0,
      capabilities: {},
    },
  });
});
