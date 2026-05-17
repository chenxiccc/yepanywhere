import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { getDesktopTokenQuery } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface SessionTerminalModalProps {
  projectId: string;
  projectPath: string;
  onClose: () => void;
}

type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

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
  const [error, setError] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [keyboardInset, setKeyboardInset] = useState(0);

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
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.focus();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = getDesktopTokenQuery();
    const wsUrl = `${protocol}//${window.location.host}/api/projects/${projectId}/terminal/ws${query ? `?${query}` : ""}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      fitAddon.fit();
      sendMessage({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as TerminalServerMessage;
        if (message.type === "output") {
          terminal.write(message.data);
          requestAnimationFrame(keepCursorVisible);
        } else if (message.type === "error") {
          setError(message.message);
        } else if (message.type === "exit") {
          terminal.writeln(
            `\r\n[${t("sessionTerminalExited")}${message.exitCode == null ? "" : `: ${message.exitCode}`}]`,
          );
          requestAnimationFrame(keepCursorVisible);
        }
      } catch {
        setError("Invalid terminal response");
      }
    };

    ws.onerror = () => {
      setError(t("sessionTerminalOpenFailed"));
    };

    const dataDisposable = terminal.onData((data: string) => {
      sendMessage({ type: "input", data });
    });

    const syncSize = () => {
      fitAddon.fit();
      sendMessage({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
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
      socketRef.current = null;
      terminalRef.current = null;
      ws.close();
      terminal.dispose();
    };
  }, [keepCursorVisible, projectId, sendMessage, t]);

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
      onClose={onClose}
    >
      <div className={`session-terminal-modal ${isMobile ? "mobile" : ""}`}>
        {error ? (
          <div className="session-terminal-error">{error}</div>
        ) : (
          <>
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
                          sendInput(button.value, { focusTerminal: false })
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
          </>
        )}
      </div>
    </Modal>
  );
}
