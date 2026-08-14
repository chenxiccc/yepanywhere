// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { HOST_IDENTITY_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostIdentityProvider } from "../../contexts/HostIdentityContext";
import { PageHeader } from "../PageHeader";

const { settingsState, versionState } = vi.hoisted(() => ({
  settingsState: {
    hostIdentity: { icon: "💻" } as { icon: string } | undefined,
  },
  versionState: {
    capabilities: ["host-identity"] as string[],
  },
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({ settings: settingsState }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: { icon?: string }) =>
      values?.icon ? `${key}:${values.icon}` : key,
  }),
}));

describe("PageHeader host identity", () => {
  afterEach(() => {
    cleanup();
    settingsState.hostIdentity = { icon: "💻" };
    versionState.capabilities = [HOST_IDENTITY_CAPABILITY];
  });

  it("places a supported host marker between the sidebar control and title", () => {
    const view = render(
      <HostIdentityProvider>
        <PageHeader title="Sessions" onOpenSidebar={vi.fn()} />
      </HostIdentityProvider>,
    );

    const left = view.container.querySelector(".session-header-left");
    expect(left?.children[0]?.classList.contains("sidebar-toggle")).toBe(true);
    expect(left?.children[1]?.classList.contains("host-identity-marker")).toBe(
      true,
    );
    expect(left?.children[2]?.textContent).toBe("Sessions");
    expect(view.getByLabelText("hostIdentityMarkerAria:💻")).toBeTruthy();
  });

  it("renders no marker when the server capability is absent", () => {
    versionState.capabilities = [];

    const view = render(
      <HostIdentityProvider>
        <PageHeader title="Sessions" onOpenSidebar={vi.fn()} />
      </HostIdentityProvider>,
    );

    expect(view.container.querySelector(".host-identity-marker")).toBeNull();
  });

  it("exposes the expanded new-session target on the sidebar opener", () => {
    const openSidebar = vi.fn();
    const view = render(
      <HostIdentityProvider>
        <PageHeader title="Sessions" onOpenSidebar={openSidebar} />
      </HostIdentityProvider>,
    );

    const opener = view.getByRole("button", { name: "actionOpenSidebar" });
    expect(opener.getAttribute("href")).toBe(
      "/remote/test/new-session?sidebar=expanded",
    );
    expect(opener.getAttribute("target")).toBe("_blank");
    expect(opener.getAttribute("title")).toBe(
      "actionOpenSidebar / [Shift] sidebarNewSession",
    );
  });
});
