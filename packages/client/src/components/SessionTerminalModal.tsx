import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { type TerminalTab, getDesktopTokenQuery } from "../api/terminal-api";
import { api } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useI18n } from "../i18n";
import "../styles/terminal.css";
import {
  clearSelectedTerminalTabId,
  getSelectedTerminalTabId,
  setSelectedTerminalTabId,
} from "../lib/projectTerminalStorage";
import { Modal } from "./ui/Modal";

interface SessionTerminalModalProps {
  projectId: string;
  projectPath: string;
  onClose: () => void;
}

type TerminalServerMessage =
  | { type: "snapshot"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string }
  | { type: "pong" };

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export function SessionTerminalModal({
  projectId,
  projectPath,
  onClose,
}: SessionTerminalModalProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loadingTabs, setLoadingTabs] = useState(true);
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [keyboardInset, setKeyboardInset] = useState(0);
  const tabLongPressTimerRef = useRef<number | null>(null);
  const tabLongPressTriggeredRef = useRef(false);
  // C3: 心跳定时器，收到 snapshot 后启动 / heartbeat timer, started after snapshot
  const pingIntervalRef = useRef<number | null>(null);
  // C5: resize 网络发送防抖 / resize network send debounce
  const resizeDebounceRef = useRef<number | null>(null);
  // C4: 主动关闭标记，避免 onclose 闪现"断开"overlay / intentional close flag
  const intentionalCloseRef = useRef(false);
  // C4: 断连期间暂停 tab 轮询，避免与重连按钮竞争 / pause tab polling during disconnect
  const pausePollingRef = useRef(false);
  // C4: tabs 的 ref 镜像，供 connectWebSocket 读最新值而不进依赖 / tabs ref mirror
  const tabsRef = useRef<TerminalTab[]>(tabs);
  tabsRef.current = tabs;
  // C4: 连接状态机 / connection status state machine
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("connecting");

  const persistSelectedTabId = useCallback(
    (tabId: string | null) => {
      if (tabId) {
        setSelectedTerminalTabId(projectId, tabId);
      } else {
        clearSelectedTerminalTabId(projectId);
      }
    },
    [projectId],
  );

  const applyTabMutationError = useCallback(
    (err: unknown) => {
      setError(
        err instanceof Error ? err.message : t("sessionTerminalOpenFailed"),
      );
    },
    [t],
  );

  const sendMessage = useCallback((message: TerminalClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const keepCursorVisible = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    containerRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, []);

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const focusMobileKeyboard = () => {
    mobileInputRef.current?.focus();
    requestAnimationFrame(() => {
      requestAnimationFrame(keepCursorVisible);
    });
  };

  const sendInput = (data: string, options?: { focusTerminal?: boolean }) => {
    sendMessage({ type: "input", data });
    if (options?.focusTerminal ?? true) {
      focusTerminal();
    }
  };

  const chooseActiveTab = useCallback(
    (availableTabs: TerminalTab[]): string | null => {
      const selected = getSelectedTerminalTabId(projectId);
      if (selected && availableTabs.some((tab) => tab.id === selected)) {
        return selected;
      }
      const sorted = [...availableTabs].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      return sorted[0]?.id ?? null;
    },
    [projectId],
  );

  const loadTabs = useCallback(async () => {
    const response = await api.getProjectTerminalTabs(projectId);
    let nextTabs = response.tabs;
    if (nextTabs.length === 0) {
      const created = await api.createProjectTerminalTab(projectId);
      nextTabs = [created.tab];
    }

    setTabs(nextTabs);
    setActiveTabId((current) => {
      const nextId =
        current && nextTabs.some((tab) => tab.id === current)
          ? current
          : chooseActiveTab(nextTabs);
      persistSelectedTabId(nextId);
      return nextId;
    });
    setLoadingTabs(false);
  }, [chooseActiveTab, persistSelectedTabId, projectId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
      },
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      cursorBlink: true,
      convertEol: true,
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.focus();

    const dataDisposable = terminal.onData((data: string) => {
      sendMessage({ type: "input", data });
    });

    const syncSize = () => {
      // fit 即时（本地视觉，无网络开销）/ fit immediately (local visual, no network cost)
      fitAddon.fit();
      // resize 网络发送防抖：键盘动画期间避免发几十帧 / debounce resize send during keyboard animation
      if (resizeDebounceRef.current) {
        window.clearTimeout(resizeDebounceRef.current);
      }
      resizeDebounceRef.current = window.setTimeout(() => {
        sendMessage({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        });
        resizeDebounceRef.current = null;
      }, 120);
    };

    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(containerRef.current);

    const updateKeyboardInset = () => {
      const viewport = window.visualViewport;
      const nextInset = Math.max(
        0,
        Math.round(
          window.innerHeight - (viewport?.height ?? window.innerHeight),
        ),
      );
      setKeyboardInset((currentInset) => {
        if (currentInset === nextInset) return currentInset;
        requestAnimationFrame(() => {
          requestAnimationFrame(keepCursorVisible);
        });
        return nextInset;
      });
    };

    updateKeyboardInset();
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      if (resizeDebounceRef.current) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      socketRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [keepCursorVisible, sendMessage]);

  useEffect(() => {
    void loadTabs().catch((err: unknown) => {
      applyTabMutationError(err);
      setLoadingTabs(false);
    });
  }, [applyTabMutationError, loadTabs]);

  // C4: 提取连接逻辑，供初始连接和重连复用 / extracted connect logic for initial + reconnect
  const connectWebSocket = useCallback(() => {
    if (!activeTabId || !terminalRef.current) {
      return;
    }
    // 校验 active tab 仍存在（用 ref 读，不进依赖，避免轮询更新 tabs 触发重连）
    // verify active tab still exists (read via ref, not in deps, to avoid reconnect on poll)
    if (!tabsRef.current.some((tab) => tab.id === activeTabId)) {
      setError(t("sessionTerminalTabNotFound"));
      pausePollingRef.current = false;
      return;
    }
    // 防快速多次重连堆积连接 / prevent stacking connections on rapid reconnect clicks
    if (socketRef.current) {
      intentionalCloseRef.current = true;
      socketRef.current.close();
      socketRef.current = null;
    }

    const terminal = terminalRef.current;
    setConnectionStatus("connecting");
    intentionalCloseRef.current = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = getDesktopTokenQuery();
    const wsUrl = `${protocol}//${window.location.host}/api/projects/${projectId}/terminal-tabs/${activeTabId}/ws${query ? `?${query}` : ""}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;
    // 兼容反向代理把文本帧转二进制 / compat: reverse proxy may convert text frames to arraybuffer
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      fitAddonRef.current?.fit();
      sendMessage({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    ws.onmessage = (event) => {
      // 1. 统一转 string（arraybuffer → TextDecoder 解码）/ normalize to string
      const raw = event.data;
      const text =
        typeof raw === "string"
          ? raw
          : raw instanceof ArrayBuffer
            ? new TextDecoder().decode(raw)
            : "";
      if (!text) return;

      // 2. 以 '{' 开头 → 尝试 JSON 控制消息 / leading '{' → try JSON control message
      if (text.charCodeAt(0) === 123) {
        try {
          const message = JSON.parse(text) as TerminalServerMessage;
          if (message.type === "snapshot") {
            // C4: BSU 同步更新，把 reset+write 合并为单帧，消除空白帧闪烁
            // C4: BSU merges reset+write into a single frame, eliminating blank-frame flicker
            terminal.write("\x1b[?2026h");
            terminal.reset();
            if (message.data) {
              terminal.write(message.data);
            }
            terminal.write("\x1b[?2026l");
            requestAnimationFrame(keepCursorVisible);
            // C4: 收到 snapshot = 服务端就绪，恢复连接态 + 恢复轮询
            // C4: snapshot = server ready, restore connected state + resume polling
            setConnectionStatus("connected");
            pausePollingRef.current = false;
            // C3: 收到 snapshot 后启动心跳，防止 NAT/路由器静默断连
            // C3: start heartbeat after snapshot to prevent NAT idle timeout
            if (pingIntervalRef.current) {
              window.clearInterval(pingIntervalRef.current);
            }
            pingIntervalRef.current = window.setInterval(() => {
              if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ type: "ping" }));
              }
            }, 25000);
          } else if (message.type === "error") {
            setError(message.message);
            // C4: 重连时 tab 已删等服务端 error → 标记 error 态 + 恢复轮询
            // C4: server error (e.g. tab deleted on reconnect) → error state + resume polling
            setConnectionStatus("error");
            pausePollingRef.current = false;
          } else if (message.type === "exit") {
            setTabs((current) =>
              current.map((tab) =>
                tab.id === activeTabId
                  ? {
                      ...tab,
                      status: "exited",
                      exitCode: message.exitCode ?? null,
                    }
                  : tab,
              ),
            );
            terminal.writeln(
              `\r\n[${t("sessionTerminalExited")}${message.exitCode == null ? "" : `: ${message.exitCode}`}]`,
            );
            requestAnimationFrame(keepCursorVisible);
          } else if (message.type === "pong") {
            // C3 心跳响应，忽略 / heartbeat response, ignore
          } else {
            // 合法 JSON 但 type 未知（如 shell 输出 {"name":"x"}）→ 当裸输出
            // valid JSON but unknown type (e.g. shell output {"name":"x"}) → treat as raw output
            terminal.write(text);
            requestAnimationFrame(keepCursorVisible);
          }
          return;
        } catch {
          // JSON.parse 失败（如 shell 输出 {foo} bar）→ 当裸输出
          // JSON.parse failed (e.g. shell output {foo} bar) → treat as raw output
          terminal.write(text);
          requestAnimationFrame(keepCursorVisible);
          return;
        }
      }

      // 3. 非 '{' 开头 → 原始 PTY 输出，直接 write / non-'{' → raw PTY output, write directly
      terminal.write(text);
      requestAnimationFrame(keepCursorVisible);
    };

    ws.onclose = () => {
      socketRef.current = null;
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      // C4: 非主动关闭 → 显示断开 overlay + 暂停轮询
      // C4: non-intentional close → show disconnected overlay + pause polling
      if (!intentionalCloseRef.current) {
        setConnectionStatus("disconnected");
        pausePollingRef.current = true;
      }
    };

    ws.onerror = () => {
      if (!intentionalCloseRef.current) {
        setConnectionStatus("error");
        setError(t("sessionTerminalOpenFailed"));
      }
    };
  }, [activeTabId, projectId, keepCursorVisible, sendMessage, t]);

  useEffect(() => {
    if (!activeTabId || !terminalRef.current || loadingTabs) {
      return;
    }

    const terminal = terminalRef.current;
    terminal.reset();
    setError(null);
    connectWebSocket();

    return () => {
      // cleanup 用闭包内的 ws 引用 / cleanup uses the ws reference in scope
      intentionalCloseRef.current = true;
      const ws = socketRef.current;
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      socketRef.current = null;
      ws?.close();
    };
  }, [activeTabId, loadingTabs, connectWebSocket]);

  useEffect(() => {
    const interval = setInterval(() => {
      // C4: 断连期间暂停轮询，避免改 activeTabId 与重连按钮竞争
      // C4: pause polling during disconnect to avoid racing with reconnect
      if (pausePollingRef.current) {
        return;
      }
      void api
        .getProjectTerminalTabs(projectId)
        .then((response) => {
          setTabs(response.tabs);
          if (
            activeTabId &&
            !response.tabs.some((tab) => tab.id === activeTabId)
          ) {
            const nextId = chooseActiveTab(response.tabs);
            setActiveTabId(nextId);
            persistSelectedTabId(nextId);
          }
        })
        .catch(() => {});
    }, 2000);

    return () => clearInterval(interval);
  }, [activeTabId, chooseActiveTab, persistSelectedTabId, projectId]);

  // C4: 关闭弹窗前标记主动关闭，避免 onclose 闪现"断开"overlay
  // C4: mark intentional close before closing modal to avoid flashing disconnected overlay
  const handleClose = useCallback(() => {
    intentionalCloseRef.current = true;
    onClose();
  }, [onClose]);

  const handleSelectTab = (tabId: string) => {
    setActiveTabId(tabId);
    persistSelectedTabId(tabId);
  };

  const handleCreateTab = async () => {
    try {
      const response = await api.createProjectTerminalTab(projectId);
      setTabs((current) => [...current, response.tab]);
      setActiveTabId(response.tab.id);
      persistSelectedTabId(response.tab.id);
    } catch (err) {
      applyTabMutationError(err);
    }
  };

  const clearTabLongPressTimer = useCallback(() => {
    if (tabLongPressTimerRef.current !== null) {
      window.clearTimeout(tabLongPressTimerRef.current);
      tabLongPressTimerRef.current = null;
    }
  }, []);

  const handleRenameTab = async (tab: TerminalTab) => {
    const nextTitle = window.prompt(t("terminalRenameTab"), tab.title);
    if (!nextTitle || nextTitle.trim() === tab.title) {
      return;
    }

    try {
      const response = await api.renameProjectTerminalTab(
        projectId,
        tab.id,
        nextTitle.trim(),
      );
      setTabs((current) =>
        current.map((entry) => (entry.id === tab.id ? response.tab : entry)),
      );
    } catch (err) {
      applyTabMutationError(err);
    }
  };

  const handleTabPointerDown = (tab: TerminalTab) => {
    tabLongPressTriggeredRef.current = false;
    clearTabLongPressTimer();
    tabLongPressTimerRef.current = window.setTimeout(() => {
      tabLongPressTriggeredRef.current = true;
      void handleRenameTab(tab);
    }, 500);
  };

  const handleTabPointerUp = () => {
    clearTabLongPressTimer();
  };

  const handleTabClick = (tab: TerminalTab) => {
    if (tabLongPressTriggeredRef.current) {
      tabLongPressTriggeredRef.current = false;
      return;
    }
    handleSelectTab(tab.id);
  };

  const handleDeleteTab = async (tabId: string) => {
    try {
      await api.deleteProjectTerminalTab(projectId, tabId);
      setTabs((current) => {
        const next = current.filter((tab) => tab.id !== tabId);
        const fallbackId = chooseActiveTab(next);
        if (activeTabId === tabId) {
          setActiveTabId(fallbackId);
          persistSelectedTabId(fallbackId);
        }
        return next;
      });
    } catch (err) {
      applyTabMutationError(err);
    }
  };

  useEffect(() => () => clearTabLongPressTimer(), [clearTabLongPressTimer]);

  const handleTerminalContainerKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (isMobile) {
        focusMobileKeyboard();
      } else {
        focusTerminal();
      }
    }
  };

  const mobileShortcutButtons: Array<{
    key: string;
    label: string;
    value: string;
  }> = [
    { key: "paste", label: t("sessionTerminalPaste"), value: "" },
    { key: "esc", label: "Esc", value: "\u001b" },
    { key: "tab", label: "Tab", value: "\t" },
    { key: "clear", label: "Clear", value: "\u000c" },
    { key: "backspace", label: "⌫", value: "\u007f" },
    { key: "ctrlc", label: "^C", value: "\u0003" },
  ];

  const mobileArrowButtons: Array<{
    key: string;
    label: string;
    value: string;
    className: string;
  }> = [
    {
      key: "up",
      label: "↑",
      value: "\u001b[A",
      className: "session-terminal-shortcut-arrow-up",
    },
    {
      key: "left",
      label: "←",
      value: "\u001b[D",
      className: "session-terminal-shortcut-arrow-left",
    },
    {
      key: "down",
      label: "↓",
      value: "\u001b[B",
      className: "session-terminal-shortcut-arrow-down",
    },
    {
      key: "right",
      label: "→",
      value: "\u001b[C",
      className: "session-terminal-shortcut-arrow-right",
    },
  ];

  const handleMobileInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    if (!value) return;
    sendInput(value);
    event.target.value = "";
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendInput(text, { focusTerminal: false });
      }
    } catch {
      setError(t("sessionTerminalPasteFailed"));
    }
  };

  const handleMobileKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      sendInput("\u007f");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      sendInput("\r");
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      sendInput("\t");
    }
  };

  return (
    <Modal
      title={
        <div className="session-terminal-title">
          <span>{t("sessionMenuOpenTerminal")}</span>
          <code>{projectPath}</code>
        </div>
      }
      onClose={handleClose}
      backCloses
    >
      <div className={`session-terminal-modal ${isMobile ? "mobile" : ""}`}>
        <div className="session-terminal-tabs">
          <div className="session-terminal-tab-list">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`session-terminal-tab ${tab.id === activeTabId ? "active" : ""}`}
                role="tab"
                tabIndex={0}
                onPointerDown={() => handleTabPointerDown(tab)}
                onPointerUp={handleTabPointerUp}
                onPointerCancel={handleTabPointerUp}
                onPointerLeave={handleTabPointerUp}
                onClick={() => handleTabClick(tab)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleSelectTab(tab.id);
                  }
                }}
              >
                <span className="session-terminal-tab-title">{tab.title}</span>
                {tab.status === "exited" && (
                  <span className="session-terminal-tab-badge">
                    {t("terminalTabExited")}
                  </span>
                )}
                <button
                  className="session-terminal-tab-close"
                  type="button"
                  aria-label={t("terminalCloseTab")}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleDeleteTab(tab.id);
                  }}
                >
                  <svg
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className="session-terminal-tab-close-icon"
                  >
                    <path d="M2 2L10 10" />
                    <path d="M10 2L2 10" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <div className="session-terminal-tab-actions">
            <button
              type="button"
              className="session-terminal-tab session-terminal-tab-new"
              aria-label={t("terminalNewTab")}
              onClick={() => void handleCreateTab()}
            >
              +
            </button>
          </div>
        </div>
        {error ? (
          <div className="session-terminal-error">{error}</div>
        ) : (
          <>
            {loadingTabs && (
              <div className="session-terminal-error">
                {t("sessionTerminalStatusConnecting")}
              </div>
            )}
            {isMobile && (
              <div className="session-terminal-mobile-controls">
                <div className="session-terminal-mobile-shortcuts">
                  <div className="session-terminal-mobile-shortcuts-main">
                    {mobileShortcutButtons.map((button) => (
                      <button
                        key={button.key}
                        type="button"
                        className="session-terminal-shortcut session-terminal-shortcut-main"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() =>
                          button.key === "paste"
                            ? void handlePaste()
                            : sendInput(button.value, { focusTerminal: false })
                        }
                      >
                        {button.label}
                      </button>
                    ))}
                  </div>
                  <div className="session-terminal-mobile-shortcuts-arrows">
                    {mobileArrowButtons.map((button) => (
                      <button
                        key={button.key}
                        type="button"
                        className={`session-terminal-shortcut ${button.className}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() =>
                          sendInput(button.value, { focusTerminal: false })
                        }
                      >
                        {button.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  ref={mobileInputRef}
                  className="session-terminal-mobile-input session-terminal-mobile-input-hidden"
                  rows={1}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  aria-label={t("sessionTerminalKeyboard")}
                  onChange={handleMobileInput}
                  onKeyDown={handleMobileKeyDown}
                />
              </div>
            )}
            <div
              ref={containerRef}
              className="session-terminal-container"
              style={
                isMobile
                  ? {
                      paddingBottom: `${keyboardInset}px`,
                    }
                  : undefined
              }
              role="button"
              tabIndex={0}
              onClick={isMobile ? focusMobileKeyboard : focusTerminal}
              onKeyDown={handleTerminalContainerKeyDown}
            />
            {/* C4: 断连重连 overlay / reconnect overlay */}
            {(connectionStatus === "disconnected" ||
              connectionStatus === "connecting") && (
              <div className="session-terminal-overlay">
                <span>
                  {connectionStatus === "connecting"
                    ? t("sessionTerminalReconnecting")
                    : t("sessionTerminalDisconnected")}
                </span>
                <button
                  type="button"
                  className="session-terminal-reconnect-button"
                  onClick={() => connectWebSocket()}
                  disabled={connectionStatus === "connecting"}
                >
                  {t("sessionTerminalReconnect")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
