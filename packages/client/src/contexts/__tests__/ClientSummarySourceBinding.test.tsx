import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  ClientSummarySourceBinding,
  resolveClientSummarySourceKey,
  type ClientSummarySourceRemoteState,
} from "../ClientSummarySourceBinding";
import { saveHost, type SavedHost } from "../../lib/hostStorage";
import {
  createClientSummaryHostSourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../../lib/clientSummaryStore";

let remoteState: ClientSummarySourceRemoteState | null = null;

vi.mock("../RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState,
}));

const CREATED_AT = "2026-06-28T00:00:00.000Z";

function relayHost(id: string, relayUsername = id): SavedHost {
  return {
    id,
    displayName: relayUsername,
    mode: "relay",
    relayUrl: "wss://relay.example/ws",
    relayUsername,
    srpUsername: relayUsername,
    createdAt: CREATED_AT,
  };
}

function directHost(id: string, wsUrl: string): SavedHost {
  return {
    id,
    displayName: id,
    mode: "direct",
    wsUrl,
    srpUsername: "user",
    createdAt: CREATED_AT,
  };
}

function remote(
  overrides: Partial<ClientSummarySourceRemoteState> = {},
): ClientSummarySourceRemoteState {
  return {
    currentDirectUrl: null,
    currentHostId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  remoteState = null;
  resetClientSummaryStoreForTests();
});

describe("resolveClientSummarySourceKey", () => {
  it("uses local outside the remote connection provider", () => {
    expect(
      resolveClientSummarySourceKey({
        pathname: "/sessions",
        remote: null,
      }),
    ).toBe("local");
  });

  it("uses the requested relay host from the URL immediately", () => {
    saveHost(relayHost("host-macbook", "macbook"));
    saveHost(relayHost("host-winnative", "winnative"));

    expect(
      resolveClientSummarySourceKey({
        pathname: "/winnative/sessions",
        remote: remote({ currentHostId: "host-macbook" }),
      }),
    ).toBe("host:host-winnative");
  });

  it("uses remote:none for login and unknown relay routes", () => {
    expect(
      resolveClientSummarySourceKey({
        pathname: "/login/relay",
        remote: remote({ currentHostId: "host-macbook" }),
      }),
    ).toBe("remote:none");

    expect(
      resolveClientSummarySourceKey({
        pathname: "/unknown-host/sessions",
        remote: remote({ currentHostId: "host-macbook" }),
      }),
    ).toBe("remote:none");
  });

  it("uses saved direct host ids on direct app routes", () => {
    saveHost(directHost("direct-host", "ws://127.0.0.1:3400/api/ws"));

    expect(
      resolveClientSummarySourceKey({
        pathname: "/sessions",
        remote: remote({ currentHostId: "direct-host" }),
      }),
    ).toBe("host:direct-host");
  });

  it("keeps bang-command history bound to the direct host", () => {
    saveHost(directHost("direct-host", "ws://127.0.0.1:3400/api/ws"));

    expect(
      resolveClientSummarySourceKey({
        pathname: "/bang-commands",
        remote: remote({ currentHostId: "direct-host" }),
      }),
    ).toBe("host:direct-host");
  });

  it("uses a normalized direct source key without a saved direct host", () => {
    expect(
      resolveClientSummarySourceKey({
        pathname: "/sessions",
        remote: remote({
          currentDirectUrl: "ws://127.0.0.1:3400/api/ws#ignored",
        }),
      }),
    ).toBe("direct:ws://127.0.0.1:3400/api/ws");
  });

  it("prefers a server instance id when the saved host carries one", () => {
    saveHost({
      ...directHost("direct-host", "ws://127.0.0.1:3400/api/ws"),
      serverInstanceId: "srv-1",
    });

    expect(
      resolveClientSummarySourceKey({
        pathname: "/sessions",
        remote: remote({ currentHostId: "direct-host" }),
      }),
    ).toBe("server:srv-1");
  });

  it("does not reuse a relay host id on direct app routes", () => {
    saveHost(relayHost("host-macbook", "macbook"));

    expect(
      resolveClientSummarySourceKey({
        pathname: "/sessions",
        remote: remote({ currentHostId: "host-macbook" }),
      }),
    ).toBe("remote:none");
  });
});

describe("ClientSummarySourceBinding", () => {
  function SourceProbe() {
    return <div data-testid="source">{useClientSummarySourceKey()}</div>;
  }

  it("publishes URL-derived relay sources before children render", () => {
    saveHost(relayHost("host-macbook", "macbook"));
    saveHost(relayHost("host-winnative", "winnative"));
    setCurrentClientSummarySourceKey(
      createClientSummaryHostSourceKey("host-macbook"),
    );
    remoteState = remote({ currentHostId: "host-macbook" });

    render(
      <MemoryRouter initialEntries={["/winnative/sessions"]}>
        <ClientSummarySourceBinding />
        <SourceProbe />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("source").textContent).toBe(
      "host:host-winnative",
    );
  });
});
