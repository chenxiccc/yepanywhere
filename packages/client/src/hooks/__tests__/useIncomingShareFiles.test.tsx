// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLocation, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncomingShareFiles } from "../useIncomingShareFiles";

const { claimIncomingShare } = vi.hoisted(() => ({
  claimIncomingShare: vi.fn(),
}));

vi.mock("../../lib/incomingShare", () => ({
  INCOMING_SHARE_QUERY_PARAM: "__ya_share",
  claimIncomingShare,
}));

function Harness({ onFiles }: { onFiles: (files: File[]) => void }) {
  const location = useLocation();
  useIncomingShareFiles(onFiles);
  return <div data-testid="location-search">{location.search}</div>;
}

describe("useIncomingShareFiles", () => {
  beforeEach(() => {
    claimIncomingShare.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("claims the shared file and removes only its one-shot URL parameter", async () => {
    const shareId = "0123456789abcdef0123456789abcdef";
    claimIncomingShare.mockResolvedValue([
      new File(["pixels"], "screen.png", { type: "image/png" }),
    ]);
    const onFiles = vi.fn();

    render(
      <MemoryRouter
        initialEntries={[`/new-session?projectId=p1&__ya_share=${shareId}`]}
      >
        <Harness onFiles={onFiles} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(onFiles).toHaveBeenCalledOnce());
    expect(claimIncomingShare).toHaveBeenCalledWith(shareId);
    const files = onFiles.mock.calls[0]?.[0] as File[];
    expect(files[0]).toMatchObject({
      name: "screen.png",
      type: "image/png",
      size: 6,
    });
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe(
        "?projectId=p1",
      ),
    );
  });
});
