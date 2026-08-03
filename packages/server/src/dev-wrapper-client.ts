import { createConnection } from "node:net";
import { getModuleEnv } from "./yaModuleEnv.js";

const REQUEST_TIMEOUT_MS = 2_000;

interface WrapperRequest {
  op: "reload" | "registerBackend";
  generation?: string;
  pid?: number;
}

function requestDevWrapper(
  request: WrapperRequest,
  unavailableValue: boolean,
): Promise<boolean> {
  const wrapperEnv = getModuleEnv("dev-wrapper");
  const rawPort = wrapperEnv.PORT?.trim();
  const token = wrapperEnv.TOKEN?.trim();
  if (!rawPort || !token) return Promise.resolve(unavailableValue);

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(
      new Error("Invalid development wrapper control port"),
    );
  }

  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(new Error(`Development wrapper ${request.op} timed out`)),
      );
    }, REQUEST_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          ok?: boolean;
          error?: string;
        };
        if (response.ok === true) {
          finish(() => resolve(true));
          return;
        }
        finish(() =>
          reject(
            new Error(
              response.error ??
                `Development wrapper rejected ${request.op} request`,
            ),
          ),
        );
      } catch {
        finish(() =>
          reject(
            new Error(`Invalid development wrapper ${request.op} response`),
          ),
        );
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `Development wrapper closed during ${request.op} request`,
            ),
          ),
        );
      }
    });
  });
}

/**
 * Ask the stable development wrapper to replace this server generation.
 * Returns false outside the wrapper so production supervisors keep their
 * established process-exit restart contract.
 */
export function requestDevWrapperReload(): Promise<boolean> {
  return requestDevWrapper({ op: "reload" }, false);
}

/** Register the actual Hono PID behind pnpm's launcher process. */
export function registerDevWrapperBackend(): Promise<boolean> {
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!generation) return Promise.resolve(false);
  return requestDevWrapper(
    { op: "registerBackend", generation, pid: process.pid },
    false,
  );
}
