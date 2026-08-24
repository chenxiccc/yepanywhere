// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLocation, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncomingShareFiles } from "../useIncomingShareFiles";

const { acknowledgeIncomingShare, readIncomingShare } = vi.hoisted(() => ({
  acknowledgeIncomingShare: vi.fn(),
  readIncomingShare: vi.fn(),
}));

vi.mock("../../lib/incomingShare", () => ({
  INCOMING_SHARE_QUERY_PARAM: "__ya_share",
  acknowledgeIncomingShare,
  readIncomingShare,
}));

function Harness({
  onFiles,
  onError,
}: {
  onFiles: (files: File[]) => void | Promise<void>;
  onError?: (error: Error) => void;
}) {
  const location = useLocation();
  useIncomingShareFiles(onFiles, { onError });
  return <div data-testid="location-search">{location.search}</div>;
}

describe("useIncomingShareFiles", () => {
  beforeEach(() => {
    acknowledgeIncomingShare.mockReset();
    acknowledgeIncomingShare.mockResolvedValue(undefined);
    readIncomingShare.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("claims the shared file and removes only its one-shot URL parameter", async () => {
    const shareId = "0123456789abcdef0123456789abcdef";
    readIncomingShare.mockResolvedValue([
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
    expect(readIncomingShare).toHaveBeenCalledWith(shareId);
    expect(acknowledgeIncomingShare).toHaveBeenCalledWith(shareId);
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

  it("retains the share until the composer accepts its files", async () => {
    const shareId = "fedcba9876543210fedcba9876543210";
    readIncomingShare.mockResolvedValue([
      new File(["pixels"], "screen.png", { type: "image/png" }),
    ]);
    let acceptFiles: () => void = () => undefined;
    const acceptance = new Promise<void>((resolve) => {
      acceptFiles = () => resolve();
    });
    const onFiles = vi.fn(() => acceptance);

    render(
      <MemoryRouter initialEntries={[`/new-session?__ya_share=${shareId}`]}>
        <Harness onFiles={onFiles} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(onFiles).toHaveBeenCalledOnce());
    expect(acknowledgeIncomingShare).not.toHaveBeenCalled();

    acceptFiles();
    await waitFor(() =>
      expect(acknowledgeIncomingShare).toHaveBeenCalledWith(shareId),
    );
  });

  it("retains and redelivers the share after an uncertain unmount", async () => {
    const shareId = "abcdef0123456789abcdef0123456789";
    readIncomingShare.mockResolvedValue([
      new File(["pixels"], "screen.png", { type: "image/png" }),
    ]);
    let acceptFiles: () => void = () => undefined;
    const acceptance = new Promise<void>((resolve) => {
      acceptFiles = resolve;
    });
    const firstConsumer = vi.fn(() => acceptance);
    const firstRender = render(
      <MemoryRouter initialEntries={[`/new-session?__ya_share=${shareId}`]}>
        <Harness onFiles={firstConsumer} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(firstConsumer).toHaveBeenCalledOnce());
    firstRender.unmount();
    acceptFiles();
    await Promise.resolve();
    expect(acknowledgeIncomingShare).not.toHaveBeenCalled();

    const secondConsumer = vi.fn();
    render(
      <MemoryRouter initialEntries={[`/new-session?__ya_share=${shareId}`]}>
        <Harness onFiles={secondConsumer} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(secondConsumer).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(acknowledgeIncomingShare).toHaveBeenCalledWith(shareId),
    );
    expect(readIncomingShare).toHaveBeenCalledTimes(2);
  });

  it("retains the share when its consumer rejects the files", async () => {
    const shareId = "00112233445566778899aabbccddeeff";
    readIncomingShare.mockResolvedValue([
      new File(["pixels"], "screen.png", { type: "image/png" }),
    ]);
    const consumerError = new Error("composer rejected the files");
    const onFiles = vi.fn().mockRejectedValue(consumerError);
    const onError = vi.fn();

    render(
      <MemoryRouter initialEntries={[`/new-session?__ya_share=${shareId}`]}>
        <Harness onFiles={onFiles} onError={onError} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(consumerError));
    expect(acknowledgeIncomingShare).not.toHaveBeenCalled();
  });
});
