// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionFileCommentDrafts } from "../../lib/sessionFileComments";
import { useSessionFileComments } from "../useSessionFileComments";

const storageKey = "session-file-comment-test";

function deferredSend() {
  let resolve: (sent: boolean) => void = () => undefined;
  const sendComment = vi.fn(
    () =>
      new Promise<boolean>((settle) => {
        resolve = settle;
      }),
  );
  return { resolve: (sent: boolean) => resolve(sent), sendComment };
}

describe("useSessionFileComments", () => {
  beforeEach(() => localStorage.clear());

  it("retains edits made while one comment is sending", async () => {
    const send = deferredSend();
    const hook = renderHook(() =>
      useSessionFileComments({
        active: true,
        storageKey,
        sendComment: send.sendComment,
      }),
    );

    act(() =>
      hook.result.current.open({ location: "file.ts:1", quote: "one" }),
    );
    const id = hook.result.current.activeDraft?.id;
    expect(id).toBeTruthy();
    act(() => hook.result.current.update(id!, "first"));
    let sendResult!: Promise<boolean>;
    act(() => {
      sendResult = hook.result.current.sendOne(id!);
    });
    await waitFor(() => expect(send.sendComment).toHaveBeenCalledTimes(1));

    act(() => hook.result.current.update(id!, "first second"));
    send.resolve(true);
    await act(async () => expect(await sendResult).toBe(true));

    expect(send.sendComment).toHaveBeenCalledWith(
      "file.ts:1\n\n> one\n\nfirst",
    );
    expect(hook.result.current.activeDraft).toMatchObject({
      id,
      text: "first second",
    });
    expect(loadSessionFileCommentDrafts(storageKey)).toMatchObject([
      { id, text: "first second" },
    ]);
  });

  it("retains a batch draft edited while blur-flush is sending", async () => {
    const send = deferredSend();
    const hook = renderHook(() =>
      useSessionFileComments({
        active: true,
        storageKey,
        sendComment: send.sendComment,
      }),
    );

    act(() =>
      hook.result.current.open({ location: "file.ts:1", quote: "one" }),
    );
    const firstId = hook.result.current.activeDraft?.id;
    act(() => hook.result.current.update(firstId!, "first"));
    act(() =>
      hook.result.current.open({ location: "file.ts:2", quote: "two" }),
    );
    const secondId = hook.result.current.activeDraft?.id;
    act(() => hook.result.current.update(secondId!, "second"));

    let flushResult!: Promise<boolean>;
    act(() => {
      flushResult = hook.result.current.flush();
    });
    await waitFor(() => expect(send.sendComment).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.update(secondId!, "second revised"));
    send.resolve(true);
    await act(async () => expect(await flushResult).toBe(true));

    expect(send.sendComment).toHaveBeenCalledWith(
      "file.ts:1\n\n> one\n\nfirst\n\n---\n\nfile.ts:2\n\n> two\n\nsecond",
    );
    expect(hook.result.current.activeDraft).toMatchObject({
      id: secondId,
      text: "second revised",
    });
    expect(loadSessionFileCommentDrafts(storageKey)).toMatchObject([
      { id: secondId, text: "second revised" },
    ]);
  });
});
