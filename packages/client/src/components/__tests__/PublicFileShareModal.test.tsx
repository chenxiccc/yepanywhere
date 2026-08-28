// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { PublicFileShareModal } from "../PublicFileShareModal";

const publicUrl =
  "https://ya.example/share/file-secret/file?h=relay&path=docs%2Fguide.md";

describe("PublicFileShareModal", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.spyOn(api, "getPublicFileShares").mockResolvedValue({ items: [] });
    vi.spyOn(api, "createPublicFileShare").mockResolvedValue({
      url: publicUrl,
      shareId: "share-one",
      createdAt: "2026-08-28T00:00:00.000Z",
      secretBits: 128,
    });
    vi.spyOn(api, "revokePublicFileShare").mockResolvedValue({
      revoked: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates and copies a live link for the exact file", async () => {
    render(
      <I18nProvider>
        <PublicFileShareModal
          projectId="cHJvamVjdA"
          filePath="docs/guide.md"
          title="guide.md"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create and copy live link" }),
    );

    await waitFor(() => {
      expect(api.createPublicFileShare).toHaveBeenCalledWith({
        projectId: "cHJvamVjdA",
        path: "docs/guide.md",
        title: "guide.md",
      });
      expect(writeText).toHaveBeenCalledWith(publicUrl);
    });
  });

  it("requires a second click before revoking a link", async () => {
    vi.mocked(api.getPublicFileShares).mockResolvedValue({
      items: [
        {
          shareId: "share-one",
          url: publicUrl,
          title: "guide.md",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      ],
    });
    render(
      <I18nProvider>
        <PublicFileShareModal
          projectId="cHJvamVjdA"
          filePath="docs/guide.md"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const revoke = await screen.findByRole("button", {
      name: "Revoke public file link",
    });
    fireEvent.click(revoke);
    expect(api.revokePublicFileShare).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Click revoke again to invalidate this link immediately.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => {
      expect(api.revokePublicFileShare).toHaveBeenCalledWith("share-one");
    });
  });
});
