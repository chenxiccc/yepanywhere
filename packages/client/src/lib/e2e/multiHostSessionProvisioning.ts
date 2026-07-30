import {
  SecureConnection,
  type StoredSession,
} from "../connection/SecureConnection";
import { openRelayClientSocket } from "../connection/RelayClientSocket";
import { createRelayHost, saveHost, type SavedHost } from "../hostStorage";

export interface ProvisionRelayHostInput {
  displayName: string;
  password: string;
  relayUrl: string;
  username: string;
}

/**
 * Playwright support loaded directly through the E2E Vite server.
 *
 * This negotiates a genuine SRP session through the production relay and
 * secure-connection implementations. It is not imported by either production
 * entry bundle.
 */
export async function provisionRelayHostSession(
  input: ProvisionRelayHostInput,
): Promise<SavedHost> {
  const ws = await openRelayClientSocket({
    relayUrl: input.relayUrl,
    relayUsername: input.username,
  });
  let storedSession: StoredSession | undefined;
  let connection: SecureConnection | null = null;

  try {
    connection = await SecureConnection.connectWithExistingSocket(
      ws,
      input.username,
      input.password,
      {
        onSessionEstablished: (session) => {
          storedSession = session;
        },
      },
      {
        relayUrl: input.relayUrl,
        relayUsername: input.username,
      },
    );
    await connection.fetch("/auth/status");
    if (!storedSession) {
      throw new Error("SRP authentication did not produce a stored session");
    }

    const host = createRelayHost({
      displayName: input.displayName,
      relayUrl: input.relayUrl,
      relayUsername: input.username,
      srpUsername: input.username,
    });
    host.session = storedSession;
    host.lastConnected = new Date().toISOString();
    saveHost(host);
    return host;
  } finally {
    connection?.close();
    if (!connection) {
      ws.close();
    }
  }
}
