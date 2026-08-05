import {
  DEFAULT_RELAY_URL,
  sanitizeSessionTitle,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareMode,
  type PublicSessionShareResponse,
  normalizeRelayUrl,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { BrandWordmark } from "../components/BrandWordmark";
import { ConversationViewIcon } from "../components/ConversationViewIcon";
import { MessageList } from "../components/MessageList";
import { ViewerCountIndicator } from "../components/ViewerCountIndicator";
import {
  PublicShareProvider,
  rewritePublicShareLocalAppHref,
  rewritePublicShareLocalAppLinks,
  type PublicShareContextValue,
} from "../contexts/PublicShareContext";
import { SchemaValidationProvider } from "../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { StreamingMarkdownProvider } from "../contexts/StreamingMarkdownContext";
import { ToastProvider } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  fetchPublicShareMetadataViaRelay,
  fetchPublicShareViaRelay,
  PublicShareRelayError,
} from "../lib/publicShareRelay";
import type { Message } from "../types";

const LIVE_POLL_MS = 2000;
const RETRY_POLL_MS = 2000;
const PUBLIC_SHARE_VIEWER_ID_KEY = "yep-anywhere-public-share-viewer-id";
const PUBLIC_SHARE_VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

interface PublicShareHints {
  capturedAt: string | null;
  initialPrompt: string | null;
  mode: PublicSessionShareMode | null;
  projectName: string | null;
  title: string | null;
  version: number | null;
}

function generateViewerId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
}

function getPublicShareViewerId(): string {
  try {
    const existing = sessionStorage.getItem(PUBLIC_SHARE_VIEWER_ID_KEY);
    if (existing && PUBLIC_SHARE_VIEWER_ID_REGEX.test(existing)) {
      return existing;
    }
    const next = generateViewerId();
    sessionStorage.setItem(PUBLIC_SHARE_VIEWER_ID_KEY, next);
    return next;
  } catch {
    return generateViewerId();
  }
}

function parseShareHints(hash: string): PublicShareHints {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const mode = params.get("m");
  return {
    capturedAt: params.get("c"),
    initialPrompt: params.get("q"),
    mode: mode === "frozen" || mode === "live" ? mode : null,
    projectName: params.get("p"),
    title: params.get("t"),
    version: params.get("v") === "2" ? 2 : null,
  };
}

function formatSnapshotDate(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

function shouldRetryPublicShareError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof PublicShareRelayError) {
    return error.retryable;
  }
  return (
    error.message === "Relay connection closed" ||
    error.message === "Relay connection failed" ||
    error.message === "Share request timed out"
  );
}

export function isPublicShareLocalAppHref(
  href: string,
  currentHref = window.location.href,
): boolean {
  let url: URL;
  try {
    url = new URL(href, currentHref);
  } catch {
    return false;
  }

  const currentUrl = new URL(currentHref);
  if (url.origin !== currentUrl.origin) {
    return false;
  }

  return (
    url.pathname.startsWith("/projects/") ||
    url.pathname === "/api/local-file" ||
    url.pathname === "/api/local-image"
  );
}

function getAnchorFromEventTarget(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest("a[href]");
}

function getPublicShareMessageId(
  message: PublicSessionShareResponse["session"]["messages"][number],
): string | null {
  const value = (message as { id?: unknown; uuid?: unknown }).id;
  if (typeof value === "string" && value) {
    return value;
  }
  const uuid = (message as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid ? uuid : null;
}

function getLastPublicShareMessageId(
  messages: PublicSessionShareResponse["session"]["messages"],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const id = getPublicShareMessageId(message);
    if (id) {
      return id;
    }
  }
  return null;
}

function mergePublicShareResponse(
  current: PublicSessionShareResponse | null,
  next: PublicSessionShareResponse,
  incremental: boolean,
): PublicSessionShareResponse {
  if (
    !current ||
    !incremental ||
    current.share.mode !== "live" ||
    next.share.mode !== "live"
  ) {
    return next;
  }

  const seenMessageIds = new Set<string>();
  for (const message of current.session.messages) {
    const id = getPublicShareMessageId(message);
    if (id) {
      seenMessageIds.add(id);
    }
  }

  const mergedMessages = [...current.session.messages];
  for (const message of next.session.messages) {
    const id = getPublicShareMessageId(message);
    if (id && seenMessageIds.has(id)) {
      continue;
    }
    if (id) {
      seenMessageIds.add(id);
    }
    mergedMessages.push(message);
  }

  return {
    share: next.share,
    session: {
      ...next.session,
      messageCount: Math.max(
        current.session.messageCount,
        next.session.messageCount,
        mergedMessages.length,
      ),
      messages: mergedMessages,
    },
  };
}

export function getPublicShareCautionKey(
  mode: PublicSessionShareMode | null,
): "publicShareLiveSecretWarning" | "publicShareReadOnlySecretCaution" | null {
  if (mode === "live") {
    return "publicShareLiveSecretWarning";
  }
  if (mode === "frozen") {
    return "publicShareReadOnlySecretCaution";
  }
  return null;
}

export function PublicSharePage() {
  const { t } = useI18n();
  const { secret } = useParams<{ secret: string }>();
  const [searchParams] = useSearchParams();
  const [share, setShare] = useState<PublicSessionShareResponse | null>(null);
  const [metadata, setMetadata] =
    useState<PublicSessionSharePublicMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [viewerId] = useState(() => {
    const requestedViewerId = searchParams.get("viewerId");
    return requestedViewerId &&
      PUBLIC_SHARE_VIEWER_ID_REGEX.test(requestedViewerId)
      ? requestedViewerId
      : getPublicShareViewerId();
  });
  const [conversationViewEnabled, setConversationViewEnabled] = useState(true);
  const [floatingControlsElement, setFloatingControlsElement] =
    useState<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const shareRef = useRef<PublicSessionShareResponse | null>(null);

  const relayUsername = searchParams.get("h") ?? "";
  const relayConfig = useMemo((): { error: string | null; url: string } => {
    try {
      return {
        error: null,
        url: normalizeRelayUrl(searchParams.get("r") ?? DEFAULT_RELAY_URL),
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        url: DEFAULT_RELAY_URL,
      };
    }
  }, [searchParams]);
  const hints = useMemo(() => parseShareHints(window.location.hash), []);
  const publicShareContext = useMemo<PublicShareContextValue | null>(() => {
    if (!secret || !relayUsername) {
      return null;
    }
    return {
      projectId: share?.share.source.projectId ?? null,
      relayUrl: relayConfig.url,
      relayUsername,
      secret,
      viewerId,
    };
  }, [
    relayConfig.url,
    relayUsername,
    secret,
    share?.share.source.projectId,
    viewerId,
  ]);

  const title = useMemo(
    () =>
      share?.share.title ??
      share?.session.customTitle ??
      share?.session.title ??
      metadata?.title ??
      hints.title,
    [share, metadata?.title, hints.title],
  );
  const projectName =
    share?.share.source.projectName ?? metadata?.projectName ?? hints.projectName;
  const mode = share?.share.mode ?? metadata?.mode ?? hints.mode;
  const capturedAt =
    share?.share.capturedAt ?? metadata?.capturedAt ?? hints.capturedAt;
  const linkedFileMode =
    share?.share.linkedFileMode ?? metadata?.linkedFileMode;
  const activeViewerCount = share?.share.activeViewerCount ?? null;
  const badgeLabel = useMemo(() => {
    if (mode === "live") {
      return t("publicShareLiveBadge");
    }
    if (mode === "frozen") {
      const snapshotDate = formatSnapshotDate(capturedAt);
      return snapshotDate
        ? `${t("publicShareFrozenBadge")} ${snapshotDate}`
        : t("publicShareFrozenBadge");
    }
    return null;
  }, [capturedAt, mode, t]);
  const loadStatusLabel = retrying
    ? t("publicShareRetrying")
    : t("publicShareLoading");
  const isFetching = loading || retrying;
  const cautionKey = getPublicShareCautionKey(mode);
  const cautionLabel = cautionKey ? t(cautionKey) : null;
  const initialPromptPreview =
    metadata?.initialPrompt ?? hints.initialPrompt;

  const refresh = useCallback(
    async (afterMessageId?: string) => {
      if (!secret || !relayUsername) {
        throw new Error(t("publicShareMissingRelay"));
      }
      if (relayConfig.error) {
        throw new Error(relayConfig.error);
      }
      return await fetchPublicShareViaRelay({
        afterMessageId,
        relayUrl: relayConfig.url,
        relayUsername,
        secret,
        viewerId,
        rawJson: hints.version === 2,
      });
    },
    [
      hints.version,
      relayConfig.error,
      relayConfig.url,
      relayUsername,
      secret,
      t,
      viewerId,
    ],
  );

  useEffect(() => {
    if (
      hints.version !== 2 ||
      !secret ||
      !relayUsername ||
      relayConfig.error
    ) {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadMetadata = async () => {
      try {
        const next = await fetchPublicShareMetadataViaRelay({
          relayUrl: relayConfig.url,
          relayUsername,
          secret,
        });
        if (!cancelled) setMetadata(next);
      } catch (metadataError) {
        if (
          !cancelled &&
          metadataError instanceof PublicShareRelayError &&
          metadataError.retryable
        ) {
          timer = setTimeout(loadMetadata, RETRY_POLL_MS);
        }
      }
    };
    void loadMetadata();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    hints.version,
    relayConfig.error,
    relayConfig.url,
    relayUsername,
    secret,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const afterMessageId =
          shareRef.current?.share.mode === "live"
            ? (lastMessageIdRef.current ?? undefined)
            : undefined;
        const response = await refresh(afterMessageId);
        if (cancelled) return;
        const nextShare = mergePublicShareResponse(
          shareRef.current,
          response,
          !!afterMessageId,
        );
        shareRef.current = nextShare;
        lastMessageIdRef.current = getLastPublicShareMessageId(
          nextShare.session.messages,
        );
        setShare(nextShare);
        setError(null);
        setLoading(false);
        setRetrying(false);
        if (response.share.mode === "live") {
          timer = setTimeout(run, LIVE_POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        if (shouldRetryPublicShareError(err)) {
          setRetrying(true);
          setError(null);
          timer = setTimeout(run, RETRY_POLL_MS);
          return;
        }
        setRetrying(false);
        setError(
          err instanceof Error ? err.message : t("publicShareUnavailable"),
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [refresh, t]);

  useEffect(() => {
    const safeTitle = title ? sanitizeSessionTitle(title) : "";
    document.title = safeTitle ? `${safeTitle} - Public Share` : "Public Share";
  }, [title]);

  useEffect(() => {
    if (!publicShareContext) {
      return;
    }

    const rewriteLinks = () => {
      rewritePublicShareLocalAppLinks(document.body, publicShareContext);
    };
    const handleActivation = (event: MouseEvent) => {
      const anchor = getAnchorFromEventTarget(event.target);
      if (!anchor) {
        return;
      }
      if (anchor.getAttribute("data-ya-private-project-file-link") === "true") {
        event.preventDefault();
        event.stopPropagation();
        setLinkNotice(t("publicShareLocalFileLinksUnavailable"));
        return;
      }
      const href = anchor?.getAttribute("href");
      if (!href) {
        return;
      }
      const rewritten = rewritePublicShareLocalAppHref(
        href,
        publicShareContext,
      );
      if (rewritten) {
        anchor.setAttribute("href", rewritten);
        anchor.setAttribute("data-public-share-file-link", "true");
        return;
      }
      if (!isPublicShareLocalAppHref(href)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setLinkNotice(t("publicShareLocalFileLinksUnavailable"));
    };

    rewriteLinks();
    const observer = new MutationObserver(rewriteLinks);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", handleActivation, true);
    document.addEventListener("auxclick", handleActivation, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleActivation, true);
      document.removeEventListener("auxclick", handleActivation, true);
    };
  }, [publicShareContext, t]);

  const messageContent =
    share && publicShareContext ? (
      <PublicShareProvider value={publicShareContext}>
        <SessionMetadataProvider
          projectId={share.share.source.projectId}
          projectPath={null}
          sessionId={share.share.source.sessionId}
        >
          <MessageList
            messages={share.session.messages as Message[]}
            provider={share.session.provider}
            conversationViewEnabledOverride={conversationViewEnabled}
            conversationViewStateKey={`${relayUsername}:${secret ?? ""}`}
            showFollowButton={mode === "live"}
            followButtonPortalTarget={floatingControlsElement}
          />
        </SessionMetadataProvider>
      </PublicShareProvider>
    ) : null;

  return (
    <main className="public-share-page">
      <header className="public-share-header">
        <div className="public-share-header-inner">
          <div className="public-share-header-left">
            <BrandWordmark
              variant="full"
              className="public-share-brand-wordmark"
            />
            {projectName && (
              <span className="public-share-project" title={projectName}>
                {projectName}
              </span>
            )}
            <div className="public-share-title-row">
              <h1 className="public-share-title">
                {title ?? t("publicShareUntitled")}
              </h1>
            </div>
          </div>
          <div className="public-share-header-actions">
            {mode === "live" && activeViewerCount !== null && (
              <ViewerCountIndicator
                className="public-share-viewer-count"
                count={activeViewerCount}
                label={t("publicShareActiveViewers", {
                  count: activeViewerCount,
                })}
              />
            )}
            {badgeLabel && (
              <span className="public-share-badge">{badgeLabel}</span>
            )}
          </div>
        </div>
      </header>
      <section className="public-share-scroll">
        {cautionLabel && (
          <div
            className={`public-share-caution public-share-caution--${mode}`}
            role="note"
          >
            {cautionLabel}
          </div>
        )}
        {mode === "frozen" && linkedFileMode === "live" && (
          <div className="public-share-caution" role="note">
            {t("publicShareFrozenLinkedFilesLiveWarning")}
          </div>
        )}
        <ToastProvider>
          <SchemaValidationProvider>
            <StreamingMarkdownProvider>
              {linkNotice && (
                <div className="public-share-notice" role="status">
                  {linkNotice}
                </div>
              )}
              {error && !retrying && !share ? (
                <div className="public-share-error public-share-error--inline">
                  {error}
                </div>
              ) : messageContent ? (
                messageContent
              ) : initialPromptPreview ? (
                <div className="public-share-preview">
                  <div className="public-share-preview-text">
                    {initialPromptPreview}
                  </div>
                  <div className="public-share-fetch-status" role="status">
                    <span className="public-share-spinner" aria-hidden="true" />
                    {loadStatusLabel}
                  </div>
                </div>
              ) : (
                <div className="public-share-empty">
                  {isFetching && (
                    <span className="public-share-spinner" aria-hidden="true" />
                  )}
                  {loadStatusLabel}
                </div>
              )}
            </StreamingMarkdownProvider>
          </SchemaValidationProvider>
        </ToastProvider>
      </section>
      {messageContent && (
        <div
          className="public-share-floating-controls"
          ref={setFloatingControlsElement}
        >
          <button
            type="button"
            className={`conversation-view-toolbar-button public-share-conversation-toggle${
              conversationViewEnabled ? " active" : ""
            }`}
            onClick={() => setConversationViewEnabled((enabled) => !enabled)}
            title={
              conversationViewEnabled
                ? t("toolbarConversationViewDisable")
                : t("toolbarConversationViewEnable")
            }
            aria-label={
              conversationViewEnabled
                ? t("toolbarConversationViewDisable")
                : t("toolbarConversationViewEnable")
            }
            aria-pressed={conversationViewEnabled}
          >
            <ConversationViewIcon />
          </button>
        </div>
      )}
    </main>
  );
}
