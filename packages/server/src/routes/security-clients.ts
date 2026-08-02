import {
  CheckInSecurityClientRequestSchema,
  PatchSecurityClientRequestSchema,
  RegisterSecurityClientRequestSchema,
  SECURITY_CLIENT_MAX_BODY_BYTES,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { getAuthenticatedSrpTransport } from "../middleware/authenticated-transport.js";
import {
  type SecurityClientService,
  SecurityClientServiceError,
} from "../services/SecurityClientService.js";

async function readBoundedJson(c: {
  req: { text(): Promise<string> };
}): Promise<unknown> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf-8") > SECURITY_CLIENT_MAX_BODY_BYTES) {
    throw new SecurityClientServiceError(
      "security_client_proof_invalid",
      400,
      "Security-client request body exceeds 8 KiB",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SecurityClientServiceError(
      "security_client_proof_invalid",
      400,
      "Invalid JSON request body",
    );
  }
}

function transportRequired(): SecurityClientServiceError {
  return new SecurityClientServiceError(
    "security_client_transport_required",
    400,
    "An established SRP transport is required",
  );
}

export function createSecurityClientRoutes(
  service: SecurityClientService,
): Hono {
  const routes = new Hono();

  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  routes.post("/api/security/clients/register", async (c) => {
    try {
      const transport = getAuthenticatedSrpTransport(c.env);
      if (!transport) throw transportRequired();
      const parsed = RegisterSecurityClientRequestSchema.safeParse(
        await readBoundedJson(c),
      );
      if (!parsed.success) {
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Invalid security-client registration",
        );
      }
      const result = await service.register(parsed.data, transport);
      return c.json({ client: result.client }, result.created ? 201 : 200);
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  routes.post("/api/security/clients/:clientId/check-in", async (c) => {
    try {
      const transport = getAuthenticatedSrpTransport(c.env);
      if (!transport) throw transportRequired();
      const parsed = CheckInSecurityClientRequestSchema.safeParse(
        await readBoundedJson(c),
      );
      if (!parsed.success) {
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Invalid security-client check-in",
        );
      }
      return c.json(
        await service.checkIn(c.req.param("clientId"), parsed.data, transport),
      );
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  routes.get("/api/security/clients", (c) =>
    c.json({ clients: service.list() }),
  );

  routes.get("/api/security/events", (c) =>
    c.json({ events: service.securityEvents() }),
  );

  routes.get("/api/security/clients/:clientId", (c) => {
    try {
      return c.json({ client: service.get(c.req.param("clientId")) });
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  routes.get("/api/security/clients/:clientId/events", (c) => {
    try {
      const clientId = c.req.param("clientId");
      return c.json({ clientId, events: service.events(clientId) });
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  routes.patch("/api/security/clients/:clientId", async (c) => {
    try {
      const parsed = PatchSecurityClientRequestSchema.safeParse(
        await readBoundedJson(c),
      );
      if (!parsed.success) {
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Invalid security-client update",
        );
      }
      return c.json(await service.patch(c.req.param("clientId"), parsed.data));
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  routes.delete("/api/security/clients/:clientId", async (c) => {
    try {
      const revocation = await service.prepareRevocation(
        c.req.param("clientId"),
      );
      const transport = getAuthenticatedSrpTransport(c.env);
      if (transport) {
        transport.deferAfterResponse(revocation.cascade);
      } else {
        const timeout = setTimeout(() => {
          void revocation.cascade().catch((error) => {
            console.error(
              "[SecurityClientService] Revocation cascade failed:",
              error,
            );
          });
        }, 0);
        timeout.unref?.();
      }
      return c.json({ client: revocation.client });
    } catch (error) {
      return securityClientError(c, error);
    }
  });

  return routes;
}

function securityClientError(
  c: { json: (body: unknown, status?: never) => Response },
  error: unknown,
): Response {
  if (error instanceof SecurityClientServiceError) {
    return c.json(
      { error: error.message, code: error.code },
      error.status as never,
    );
  }
  console.error("[SecurityClientService] Request failed:", error);
  return c.json({ error: "Internal server error" }, 500 as never);
}
