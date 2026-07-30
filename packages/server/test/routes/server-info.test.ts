import { describe, expect, it } from "vitest";
import { createServerInfoRoutes } from "../../src/routes/server-info.js";

describe("server info routes", () => {
  it("reads a dynamically selected localhost port at request time", async () => {
    let port = 0;
    const routes = createServerInfoRoutes({
      host: "127.0.0.1",
      port: () => port,
    });

    port = 43127;
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 43127,
        localhostOnly: true,
      }),
    );
  });
});
