// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  assistantToolUseMessage,
  systemMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

afterEach(() => {
  vi.unstubAllGlobals();
});

function rect({
  top,
  height,
  right = 500,
  width = 400,
}: {
  top: number;
  height: number;
  right?: number;
  width?: number;
}): DOMRect {
  return {
    x: right - width,
    y: top,
    top,
    right,
    bottom: top + height,
    left: right - width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setReadonlyNumber(
  element: HTMLElement,
  key: "clientHeight" | "clientWidth" | "offsetWidth" | "scrollHeight",
  value: number,
) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function installSearchGeometry(rowOffsets: Record<string, number>) {
  const messageList = document.querySelector<HTMLElement>(".message-list");
  if (!messageList?.parentElement) {
    throw new Error("MessageList did not render a scroll container");
  }
  const scrollContainer = messageList.parentElement;
  let scrollTop = 0;
  const scrollTo = vi.fn(
    (optionsOrX?: ScrollToOptions | number, y?: number) => {
      scrollTop =
        typeof optionsOrX === "number"
          ? optionsOrX
          : Number(optionsOrX?.top ?? y ?? 0);
      scrollContainer.dispatchEvent(new Event("scroll"));
    },
  );

  Object.defineProperty(scrollContainer, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = Number(value);
    },
  });
  setReadonlyNumber(scrollContainer, "scrollHeight", 1800);
  setReadonlyNumber(scrollContainer, "clientHeight", 200);
  setReadonlyNumber(scrollContainer, "clientWidth", 360);
  setReadonlyNumber(scrollContainer, "offsetWidth", 380);
  scrollContainer.getBoundingClientRect = () => rect({ top: 100, height: 200 });
  Object.defineProperty(scrollContainer, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });

  const installRowGeometry = () => {
    for (const row of messageList.querySelectorAll<HTMLElement>(
      "[data-render-id]",
    )) {
      const renderId = row.dataset.renderId;
      const topOffset = renderId ? rowOffsets[renderId] : undefined;
      if (topOffset === undefined) {
        continue;
      }
      row.getBoundingClientRect = () =>
        rect({ top: 100 + topOffset - scrollTop, height: 24 });
    }
  };
  installRowGeometry();
  const observer = new MutationObserver(installRowGeometry);
  observer.observe(messageList, { childList: true, subtree: true });

  return { scrollTo, stop: () => observer.disconnect() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function historyPage(
  messages: ReturnType<typeof userMessage>[],
  nextCursor: string | null,
) {
  return {
    session: {},
    messages,
    ownership: "unowned",
    pagination: {
      hasOlderMessages: nextCursor !== null,
      totalMessageCount: messages.length,
      returnedMessageCount: messages.length,
      ...(nextCursor ? { truncatedBeforeMessageId: nextCursor } : {}),
      totalCompactions: 0,
    },
  } as never;
}

describe("MessageList reverse search", () => {
  it.each([
    {
      shortcut: "r",
      inputName: "Reverse search user turns",
      targetId: "user-0",
      needle: "oldest user needle",
    },
    {
      shortcut: "s",
      inputName: "Reverse search all turns",
      targetId: "assistant-0",
      needle: "oldest assistant needle",
    },
  ])(
    "wakes and keeps an off-window $shortcut match aligned after commit",
    async ({ shortcut, inputName, targetId, needle }) => {
      const messages = Array.from({ length: 130 }, (_, index) => [
        userMessage(
          `user-${index}`,
          index === 0 ? "oldest user needle" : `Request ${index}`,
        ),
        assistantMessage(
          `assistant-${index}`,
          index === 0 ? "oldest assistant needle" : `Answer ${index}`,
        ),
      ]).flat();
      const { container } = render(<MessageList messages={messages} />);

      expect(
        container.querySelector(`[data-render-id="${targetId}"]`),
      ).toBeNull();
      expect(
        container.querySelectorAll("[data-render-id]").length,
      ).toBeLessThanOrEqual(48);

      fireEvent.keyDown(window, { key: shortcut, ctrlKey: true });
      const input = await screen.findByRole("textbox", { name: inputName });
      fireEvent.change(input, { target: { value: needle } });
      await waitFor(() => {
        expect(
          container.querySelector(`[data-render-id="${targetId}"]`),
        ).not.toBeNull();
      });
      const { scrollTo } = installSearchGeometry({ [targetId]: 900 });

      fireEvent.keyDown(window, { key: "Enter" });

      await waitFor(() => {
        expect(screen.queryByRole("textbox", { name: inputName })).toBeNull();
        expect(
          container.querySelector(`[data-render-id="${targetId}"]`),
        ).not.toBeNull();
      });
      expect(scrollTo).toHaveBeenCalledWith({ top: 812, behavior: "auto" });
      expect(
        container.querySelectorAll("[data-render-id]").length,
      ).toBeLessThanOrEqual(48);
    },
  );

  it("opens reverse user-turn search with Ctrl+R and hides nonmatches", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "alpha setup request"),
          assistantMessage("assistant-1", "first response"),
          userMessage(
            "user-2",
            "please inspect the render latency regression in the client",
          ),
          assistantMessage("assistant-2", "second response"),
        ]}
      />,
    );

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, { key: "r", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    expect(composerTarget.contains(input)).toBe(true);
    expect(screen.getByText("2+ chars")).toBeTruthy();

    fireEvent.change(input, { target: { value: "latency" } });

    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.queryByText("alpha setup request")).toBeNull();
    expect(screen.getByText(/render latency regression/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editableTarget);
    });
    editableTarget.remove();
    composerTarget.remove();
  });

  it("clears a selected search id when its trimmed turn disappears", async () => {
    const retained = userMessage("user-2", "retained searchable request");
    const rendered = render(
      <MessageList
        messages={[userMessage("user-1", "unique removed needle"), retained]}
        activeWindowTrimRevision={0}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    rendered.rerender(
      <MessageList messages={[retained]} activeWindowTrimRevision={1} />,
    );

    expect(await screen.findByText("0/0")).toBeTruthy();
    expect(screen.queryByText("unique removed needle")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);
  });

  it("opens user-turn search with Ctrl+Alt+R fallback for one turn", async () => {
    render(
      <MessageList
        messages={[userMessage("user-1", "inspect Chrome shortcut handling")]}
      />,
    );

    fireEvent.keyDown(window, {
      key: "R",
      code: "KeyR",
      ctrlKey: true,
      altKey: true,
    });

    expect(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
    ).toBeTruthy();
  });

  it("keeps reverse search active when focus moves outside its panel", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first searchable request"),
          userMessage("user-2", "second searchable request"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);

    fireEvent.blur(input, { relatedTarget: composer });

    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composer.remove();
  });

  it("scans older pages as excerpts and hydrates only the chosen page", async () => {
    const firstOlderPage = {
      session: {},
      messages: [
        userMessage("user-middle", "an intermediate page without the term"),
      ],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: true,
        totalMessageCount: 6,
        returnedMessageCount: 1,
        truncatedBeforeMessageId: "older-boundary",
        totalCompactions: 3,
      },
    } as never;
    const matchingOlderPage = {
      session: {},
      messages: [
        userMessage("user-old", "the buried history needle lives here"),
        assistantMessage("assistant-old", "old answer"),
      ],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 6,
        returnedMessageCount: 2,
        totalCompactions: 3,
      },
    } as never;
    const readOlderPage = vi.fn(async (cursor: string) =>
      cursor === "loaded-boundary" ? firstOlderPage : matchingOlderPage,
    );
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-recent", "recent request"),
          assistantMessage("assistant-recent", "recent answer"),
        ]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "history needle" } });

    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    expect(await screen.findByRole("button", { name: "More" })).toBeTruthy();
    expect(readOlderPage).toHaveBeenLastCalledWith("loaded-boundary");
    expect(
      container.querySelector('[data-render-id="user-middle"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByText("Older result")).toBeTruthy();
    expect(screen.getByText(/buried history needle lives here/)).toBeTruthy();
    expect(readOlderPage).toHaveBeenLastCalledWith("older-boundary");
    expect(container.querySelector('[data-render-id="user-old"]')).toBeNull();

    const { scrollTo, stop } = installSearchGeometry({ "user-old": 900 });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-old"]'),
      ).not.toBeNull();
    });
    expect(readOlderPage).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 812, behavior: "auto" });
    });
    expect(screen.queryByText("Older result")).toBeNull();
    expect(
      screen.getByText(
        "Unloaded history omitted · recent transcript continues below",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-recent"]'),
      ).not.toBeNull();
    });

    fireEvent.keyDown(window, { key: "End", ctrlKey: true });
    await waitFor(() => {
      expect(container.querySelector('[data-render-id="user-old"]')).toBeNull();
    });
    stop();
  });

  it("keeps the latest historical selection when hydrations settle out of order", async () => {
    const pageA = historyPage(
      [userMessage("user-history-a", "history A needle")],
      "history-b-boundary",
    );
    const pageB = historyPage(
      [userMessage("user-history-b", "history B needle")],
      null,
    );
    const hydrationA = deferred<typeof pageA>();
    const hydrationB = deferred<typeof pageB>();
    let pageAReads = 0;
    let pageBReads = 0;
    const readOlderPage = vi.fn((cursor: string) => {
      if (cursor === "loaded-boundary") {
        pageAReads += 1;
        return pageAReads === 1 ? Promise.resolve(pageA) : hydrationA.promise;
      }
      pageBReads += 1;
      return pageBReads === 1 ? Promise.resolve(pageB) : hydrationB.promise;
    });
    const { container } = render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const searchInput = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(searchInput, { target: { value: "needle" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "More" }));

    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(pageAReads).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(window, { key: "r", code: "KeyR", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(pageBReads).toBe(2));

    act(() => hydrationB.resolve(pageB));
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-history-b"]'),
      ).not.toBeNull();
    });
    act(() => hydrationA.resolve(pageA));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-render-id="user-history-a"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-render-id="user-history-b"]'),
    ).not.toBeNull();
  });

  it("does not remount historical hydration after following current output", async () => {
    const page = historyPage(
      [userMessage("user-history", "historical follow needle")],
      null,
    );
    const hydration = deferred<typeof page>();
    let reads = 0;
    const readOlderPage = vi.fn(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve(page) : hydration.promise;
    });
    const { container } = render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const searchInput = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(searchInput, { target: { value: "follow needle" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await screen.findByText("Older result");
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.keyDown(window, { key: "End", ctrlKey: true });
    act(() => hydration.resolve(page));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();
  });

  it("does not resurrect a hydrated page after park or view changes", async () => {
    const page = historyPage(
      [userMessage("user-history", "historical lifetime needle")],
      null,
    );
    const readOlderPage = vi.fn(async () => page);
    const renderList = (
      inert = false,
      conversationViewEnabledOverride = false,
    ) => (
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
        inert={inert}
        conversationViewEnabledOverride={conversationViewEnabledOverride}
      />
    );
    const rendered = render(renderList());
    const hydrateSelectedPage = async () => {
      fireEvent.keyDown(window, { key: "r", ctrlKey: true });
      fireEvent.change(
        await screen.findByRole("textbox", {
          name: "Reverse search user turns",
        }),
        { target: { value: "lifetime needle" } },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Search older" }),
      );
      await screen.findByText("Older result");
      fireEvent.keyDown(window, { key: "Enter" });
      await waitFor(() => {
        expect(
          rendered.container.querySelector('[data-render-id="user-history"]'),
        ).not.toBeNull();
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("textbox", {
            name: "Reverse search user turns",
          }),
        ).toBeNull();
      });
    };

    await hydrateSelectedPage();
    rendered.rerender(renderList(true));
    rendered.rerender(renderList(false));
    expect(
      rendered.container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();

    await hydrateSelectedPage();
    rendered.rerender(renderList(false, true));
    rendered.rerender(renderList(false, false));
    expect(
      rendered.container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();
  });

  it("restores prompt actions when pagination canonically loads a historical row", async () => {
    const historicalMessage = userMessage(
      "user-history",
      "historical canonical needle",
    );
    const page = historyPage([historicalMessage], null);
    const readOlderPage = vi.fn(async () => page);
    const onTrimBeforeUserMessage = vi.fn();
    const recentMessage = userMessage("user-recent", "recent request");
    const renderList = (messages: ReturnType<typeof userMessage>[]) => (
      <MessageList
        messages={messages}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
        onTrimBeforeUserMessage={onTrimBeforeUserMessage}
      />
    );
    const rendered = render(renderList([recentMessage]));

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "canonical needle" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await screen.findByText("Older result");
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => {
      expect(
        rendered.container.querySelector('[data-render-id="user-history"]'),
      ).not.toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: "userPromptShowStartingHere" }),
    ).toBeNull();

    rendered.rerender(renderList([historicalMessage, recentMessage]));

    const historicalRow = rendered.container.querySelector<HTMLElement>(
      '[data-render-id="user-history"]',
    );
    expect(historicalRow).not.toBeNull();
    const trim = within(historicalRow!).getByRole("button", {
      name: "userPromptShowStartingHere",
    });
    fireEvent.click(trim);
    expect(onTrimBeforeUserMessage).toHaveBeenCalledWith("user-history");
  });

  it("keeps the closest 512 matches across three older pages", async () => {
    const pages = new Map([
      [
        "closest-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`closest-${index}`, `closest ${index} needle`),
          ),
          "middle-boundary",
        ),
      ],
      [
        "middle-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`middle-${index}`, `middle ${index} needle`),
          ),
          "oldest-boundary",
        ),
      ],
      [
        "oldest-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`oldest-${index}`, `oldest ${index} needle`),
          ),
          null,
        ),
      ],
    ]);
    const readOlderPage = vi.fn(async (cursor: string) => pages.get(cursor)!);

    render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="closest-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "needle" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));

    expect(await screen.findByText("512/512")).toBeTruthy();
    expect(screen.getByText("closest 199 needle")).toBeTruthy();
    expect(screen.queryByText("oldest 0 needle")).toBeNull();
  });

  it("does not create the history worker before an explicit older search", async () => {
    let workerConstructions = 0;
    class TestWorker {
      private messageListeners: Array<
        (event: MessageEvent<Record<string, unknown>>) => void
      > = [];

      constructor() {
        workerConstructions += 1;
      }

      addEventListener(
        type: string,
        listener: (event: MessageEvent<Record<string, unknown>>) => void,
      ) {
        if (type === "message") this.messageListeners.push(listener);
      }

      postMessage(request: Record<string, unknown>) {
        const { requestId } = request;
        queueMicrotask(() => {
          for (const listener of this.messageListeners) {
            listener(
              new MessageEvent("message", {
                data: { requestId, matches: [], matchesTruncated: false },
              }),
            );
          }
        });
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", TestWorker);
    const readOlderPage = vi.fn(async () => ({
      session: {},
      messages: [],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    })) as never;

    render(
      <MessageList
        messages={[assistantMessage("assistant-recent", "recent answer")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });

    expect(workerConstructions).toBe(0);
    expect(readOlderPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search older" }));
    await waitFor(() => expect(workerConstructions).toBe(1));
    expect(readOlderPage).toHaveBeenCalledOnce();
  });

  it("opens all-turn reverse search with Ctrl+S", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "look at the first thing"),
          assistantMessage("assistant-1", "the assistant found needle text"),
          systemMessage("system-1", "system compacted needle context"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    expect(screen.getByText("All turns")).toBeTruthy();

    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("2/2")).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByText("look at the first thing")).toBeNull();
    expect(screen.getByText("the assistant found needle text")).toBeTruthy();
    expect(screen.getByText("system compacted needle context")).toBeTruthy();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("centers a clicked all-turn preview without a blur-time re-jump", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantMessage("assistant-1", "assistant needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantMessage("assistant-2", "later unmatched answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });

    const preview = await screen.findByRole("button", {
      name: "assistant needle answer",
    });
    fireEvent.click(preview);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    });
    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    const scrollCallCount = scrollTo.mock.calls.length;
    const transcriptControl = document.createElement("button");
    document.body.append(transcriptControl);

    fireEvent.blur(input, { relatedTarget: transcriptControl });

    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);
    expect(screen.getByText("unmatched setup request")).toBeTruthy();
    transcriptControl.remove();
  });

  it("Enter after arrowing to a match jumps like clicking that match", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    const flushAnimationFrames = () => {
      act(() => {
        const pending = rafQueue.splice(0);
        for (const callback of pending) {
          callback(0);
        }
      });
    };

    render(
      <MessageList
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantMessage("assistant-1", "first needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantMessage("assistant-2", "second needle answer"),
        ]}
      />,
    );
    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search all turns" }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    flushAnimationFrames();
    const preview = await screen.findByRole("button", {
      name: "first needle answer",
    });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    // Same destination as clicking `preview` (offset 420, centered in 200px).
    expect(preview).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });
    flushAnimationFrames();
    flushAnimationFrames();
    expect(screen.getByText("unmatched setup request")).toBeTruthy();
    expect(screen.getByText("first needle answer")).toBeTruthy();
    composerTarget.remove();
  });

  it("Ctrl+R Enter after arrowing jumps to the highlighted user turn", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first needle request"),
          assistantMessage("assistant-1", "first answer"),
          userMessage("user-2", "second needle request"),
          assistantMessage("assistant-2", "second answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 420,
      "assistant-1": 700,
      "user-2": 1100,
      "assistant-2": 1400,
    });

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composerTarget.remove();
  });

  it("Enter after arrowing in conversation view pins the same match", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.className = "session-input-inner";
    document.body.append(composerTarget);

    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    const flushAnimationFrames = () => {
      act(() => {
        const pending = rafQueue.splice(0);
        for (const callback of pending) {
          callback(0);
        }
      });
    };

    render(
      <MessageList
        conversationViewEnabledOverride
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantToolUseMessage("assistant-tools-1", [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "packages/client/src/recap.ts" },
            },
          ]),
          assistantMessage("assistant-1", "first needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantToolUseMessage("assistant-tools-2", [
            {
              type: "tool_use",
              id: "read-2",
              name: "Read",
              input: { file_path: "packages/client/src/notice.ts" },
            },
          ]),
          assistantMessage("assistant-2", "second needle answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search all turns" }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });
    flushAnimationFrames();
    flushAnimationFrames();
    expect(screen.getByText("first needle answer")).toBeTruthy();
    composerTarget.remove();
  });

  it("repeats all-turn search arrow movement at a fast cadence", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "needle in the first request"),
          assistantMessage("assistant-1", "needle in the first answer"),
          systemMessage("system-1", "needle in the compacted context"),
          assistantMessage("assistant-2", "needle in the final answer"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("4/4")).toBeTruthy();

    vi.useFakeTimers();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByText("3/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("2/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(42);
    });
    expect(screen.getByText("1/4")).toBeTruthy();

    fireEvent.keyUp(window, { key: "ArrowUp" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("opens full-session reverse search with Ctrl+Alt+S for tool groups", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect recent changes"),
          assistantToolUseMessage("assistant-tools", [
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: {
                pattern: "SearchNeedle",
                path: "packages/client/src/components/MessageList.tsx",
              },
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: {
                file_path:
                  "packages/client/src/components/UserTurnNavigator.tsx",
              },
            },
          ]),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    const allInput = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(allInput, { target: { value: "Explored" } });

    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });

    fireEvent.keyDown(window, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
    });

    const fullInput = await screen.findByRole("textbox", {
      name: "Reverse search full session",
    });
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+S prev/)).toBeTruthy();
    expect(screen.getByText(/click jumps/)).toBeTruthy();
    expect(screen.getByText(/Enter jump\+close/)).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "Explored" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Exploring")).toBeTruthy();

    fireEvent.change(fullInput, {
      target: { value: "UserTurnNavigator.tsx" },
    });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "grep" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Grep")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "searchneedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Case-sensitive search" }),
    );
    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "SearchNeedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
  });
});
