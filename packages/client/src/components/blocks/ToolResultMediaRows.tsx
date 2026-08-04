import type {
  StoredToolResultMedia,
  ToolResultMedia,
  ToolResultMediaRejectionReason,
} from "@yep-anywhere/shared";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useRememberedDisclosureState } from "../../contexts/RememberedDisclosureStateContext";
import { useSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../../hooks/useInlineMedia";
import { useI18n, type MessageKey } from "../../i18n";
import { toSourceTransportApiPath } from "../../lib/sourceTransportPaths";
import type { ToolCallItem } from "../../types/renderItems";
import { LocalMediaModal, type LocalMediaSource } from "../LocalMediaModal";
import styles from "./ToolResultMediaRows.module.css";

interface ToolResultMediaRowsProps {
  displayName: string;
  media: ToolResultMedia[];
  status: ToolCallItem["status"];
}

type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; objectUrl: string }
  | { state: "error" };

type MediaPreviewStyle = CSSProperties & {
  "--tool-result-media-aspect-ratio": string;
  "--tool-result-media-max-width": string;
};

const REJECTION_KEYS: Record<ToolResultMediaRejectionReason, MessageKey> = {
  "invalid-image-data": "toolResultMediaInvalidImageData",
  "source-unavailable": "toolResultMediaSourceUnavailable",
  "storage-unavailable": "toolResultMediaStorageUnavailable",
  "too-large": "toolResultMediaTooLarge",
  "unsupported-media": "toolResultMediaUnsupportedMedia",
};

export function ToolResultMediaRows({
  displayName,
  media,
  status,
}: ToolResultMediaRowsProps) {
  return (
    <div className={`tool-row ${styles.root} timeline-item status-${status}`}>
      {media.map((item, index) => (
        <ToolResultMediaRow
          key={item.state === "stored" ? item.id : `${item.reason}-${index}`}
          displayName={displayName}
          index={index}
          media={item}
        />
      ))}
    </div>
  );
}

function ToolResultMediaRow({
  displayName,
  index,
  media,
}: {
  displayName: string;
  index: number;
  media: ToolResultMedia;
}) {
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const { t } = useI18n();
  const filename =
    media.filename || t("toolResultMediaUnnamed", { number: index + 1 });

  if (media.state === "rejected") {
    return (
      <div className={`${styles.row} ${styles.rejected}`}>
        <div
          className={styles.rowHeader}
          title={t(REJECTION_KEYS[media.reason])}
        >
          <span className={styles.togglePlaceholder}>+</span>
          <span className="tool-name">{displayName}</span>
          <span className={styles.filename}>{filename}</span>
          <span className={styles.suffix}>
            ({t("toolResultMediaUnavailable")})
          </span>
        </div>
      </div>
    );
  }

  return (
    <StoredToolResultMediaRow
      displayName={displayName}
      filename={filename}
      initialExpanded={inlineMediaExpandedByDefault}
      media={media}
    />
  );
}

function StoredToolResultMediaRow({
  displayName,
  filename,
  initialExpanded,
  media,
}: {
  displayName: string;
  filename: string;
  initialExpanded: boolean;
  media: StoredToolResultMedia;
}) {
  const { projectId, sessionId } = useSessionMetadata();
  const transport = useCurrentSourceRuntime().transport;
  const { t } = useI18n();
  const [expanded, setExpanded] = useRememberedDisclosureState(
    media.toolCallId,
    `media-preview:${media.id}`,
    initialExpanded,
  );
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [modalOpen, setModalOpen] = useState(false);
  const apiPath = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(media.id)}`;
  const mediaSource = useMemo<LocalMediaSource>(
    () => ({ buildApiPath: () => apiPath }),
    [apiPath],
  );

  useEffect(() => {
    if (!expanded) {
      setPreview({ state: "idle" });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setPreview({ state: "loading" });
    void transport
      .fetchBlob(toSourceTransportApiPath(apiPath))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreview({ state: "loaded", objectUrl });
      })
      .catch(() => {
        if (!cancelled) setPreview({ state: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiPath, expanded, transport]);

  const dimensions =
    media.width && media.height ? `${media.width}×${media.height}` : null;
  const previewStyle: MediaPreviewStyle = {
    "--tool-result-media-aspect-ratio":
      media.width && media.height
        ? `${media.width} / ${media.height}`
        : "16 / 9",
    "--tool-result-media-max-width": media.width
      ? `${Math.min(media.width, 720)}px`
      : "720px",
  };
  const toggleLabel = expanded
    ? t("toolResultMediaCollapse")
    : t("toolResultMediaExpand");

  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpanded((current) => !current)}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          title={toggleLabel}
        >
          {expanded ? "−" : "+"}
        </button>
        <span className="tool-name">{displayName}</span>
        <button
          type="button"
          className={styles.filename}
          onClick={() => setModalOpen(true)}
        >
          {filename}
        </button>
        <span className={styles.suffix}>({t("toolResultMediaImage")})</span>
        {dimensions && <span className={styles.dimensions}>{dimensions}</span>}
      </div>

      {expanded && (
        <div className={styles.preview} style={previewStyle}>
          {preview.state === "loading" && (
            <span className={styles.loading}>
              {t("toolResultMediaLoading")}
            </span>
          )}
          {preview.state === "error" && (
            <span className={styles.error}>
              {t("toolResultMediaLoadFailed")}
            </span>
          )}
          {preview.state === "loaded" && (
            <button
              type="button"
              className={styles.imageButton}
              onClick={() => setModalOpen(true)}
              aria-label={t("toolResultMediaOpen", { filename })}
            >
              <img
                src={preview.objectUrl}
                alt={t("toolResultMediaAlt", { filename })}
                width={media.width}
                height={media.height}
              />
            </button>
          )}
        </div>
      )}

      {modalOpen && (
        <LocalMediaModal
          path={filename}
          mediaType="image"
          mediaSource={mediaSource}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
