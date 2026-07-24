/**
 * Transcript block for a `!!` bang command run: command line, status/exit,
 * markdown-rendered output with a raw toggle, stderr, and the recall /
 * re-run / echo / delete actions. Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { MarkdownPreview } from "./MarkdownPreview";

export interface BangCommandOutput {
  stdout: string;
  stderr: string;
  stdoutHtml: string;
  mode: "markdown" | "json" | "ansi" | "toon" | "raw";
  responseTruncated: boolean;
}

export interface BangCommandHandlers {
  onKill?: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  onRerun?: (command: string) => void;
  onRecall?: (command: string) => void;
  onEcho?: (object: BangCommandTranscriptDisplayObject) => void;
  fetchOutput?: (objectId: string) => Promise<BangCommandOutput>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function BangCommandDisplayObject({
  object,
  handlers,
  outputExpanded,
  onOutputExpandedChange,
}: {
  object: BangCommandTranscriptDisplayObject;
  handlers?: BangCommandHandlers;
  outputExpanded?: boolean;
  onOutputExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useI18n();
  const [output, setOutput] = useState<BangCommandOutput | null>(null);
  const [locallyExpanded, setLocallyExpanded] = useState(false);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputLoadFailed, setOutputLoadFailed] = useState(false);
  const [outputLoadAttempt, setOutputLoadAttempt] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const fetchedForRef = useRef<string | null>(null);

  const finished = object.status !== "running";
  const fetchOutput = handlers?.fetchOutput;
  const expanded = outputExpanded ?? locallyExpanded;
  const setExpanded = (next: boolean) => {
    if (outputExpanded === undefined) {
      setLocallyExpanded(next);
    }
    onOutputExpandedChange?.(next);
  };
  useEffect(() => {
    void outputLoadAttempt;
    if (!expanded) {
      fetchedForRef.current = null;
      setOutput(null);
      setOutputLoading(false);
      setOutputLoadFailed(false);
      setShowRaw(false);
      return;
    }
    if (!finished || !fetchOutput) return;
    const fetchKey = `${object.id}:${object.status}`;
    if (fetchedForRef.current === fetchKey) return;
    fetchedForRef.current = fetchKey;
    setOutputLoading(true);
    setOutputLoadFailed(false);
    let cancelled = false;
    fetchOutput(object.id).then(
      (result) => {
        if (!cancelled) {
          setOutput(result);
          setOutputLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          fetchedForRef.current = null;
          setOutputLoading(false);
          setOutputLoadFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    finished,
    fetchOutput,
    object.id,
    object.status,
    outputLoadAttempt,
  ]);

  const stderrText = output?.stderr ?? object.stderrPreview ?? "";
  const rawStdout = output?.stdout ?? object.stdoutPreview ?? "";
  const renderedHtml = output?.stdoutHtml ?? "";
  const exitLabel =
    object.exitCode !== undefined
      ? t("bangExitCode", { code: String(object.exitCode) })
      : null;

  return (
    <div
      className={`bang-command-display-object bang-command-${object.status}`}
      role="group"
      aria-label={t("bangBlockAriaLabel")}
    >
      <div className="bang-command-header">
        <span className="bang-command-glyph" aria-hidden="true">
          !!
        </span>
        <code className="bang-command-line" title={object.cwd}>
          {object.command}
        </code>
        <span className="bang-command-meta">
          {object.status === "running" && (
            <span className="bang-command-running">
              <span className="bang-command-spinner" aria-hidden="true" />
              {t("bangRunning")}
            </span>
          )}
          {exitLabel && (
            <span
              className={`bang-command-exit${object.exitCode === 0 ? "" : " bang-command-exit-nonzero"}`}
            >
              {exitLabel}
            </span>
          )}
          {object.durationMs !== undefined && (
            <span className="bang-command-duration">
              {formatDuration(object.durationMs)}
            </span>
          )}
        </span>
      </div>

      {object.error && (
        <div className="bang-command-error" role="alert">
          {object.error}
        </div>
      )}

      {object.status === "running" ? (
        (object.stdoutPreview || object.stderrPreview) && (
          <pre className="bang-command-preview">
            {[object.stdoutPreview, object.stderrPreview]
              .filter(Boolean)
              .join("\n")}
          </pre>
        )
      ) : renderedHtml && !showRaw ? (
        <MarkdownPreview
          className="bang-command-output"
          html={renderedHtml}
          ariaLabel={t("bangOutputAriaLabel")}
        />
      ) : rawStdout ? (
        <pre className="bang-command-preview">{rawStdout}</pre>
      ) : null}

      {finished && stderrText.trim() && (
        <details className="bang-command-stderr">
          <summary>{t("bangStderrLabel")}</summary>
          <pre className="bang-command-preview">{stderrText}</pre>
        </details>
      )}

      {(object.stdoutTruncated || output?.responseTruncated) && (
        <div className="bang-command-truncated">{t("bangTruncatedNote")}</div>
      )}

      <div className="bang-command-actions">
        {object.status === "running" && handlers?.onKill && (
          <button
            type="button"
            className="bang-command-action"
            onClick={() => handlers.onKill?.(object.id)}
          >
            {t("bangCancel")}
          </button>
        )}
        {finished && renderedHtml && (
          <button
            type="button"
            className="bang-command-action"
            onClick={() => setShowRaw((value) => !value)}
          >
            {showRaw ? t("bangRendered") : t("bangRaw")}
          </button>
        )}
        {finished && fetchOutput && (
          <button
            type="button"
            className="bang-command-action"
            disabled={outputLoading}
            onClick={() => {
              if (outputLoadFailed) {
                setOutputLoadFailed(false);
                setOutputLoadAttempt((attempt) => attempt + 1);
              } else {
                setExpanded(!expanded);
              }
            }}
          >
            {outputLoading
              ? t("bangLoadingOutput")
              : outputLoadFailed
                ? t("bangRetryOutput")
                : expanded
                  ? t("bangHideOutput")
                  : t("bangLoadOutput")}
          </button>
        )}
        {handlers?.onRecall && (
          <button
            type="button"
            className="bang-command-action"
            onClick={() => handlers.onRecall?.(object.command)}
            title={t("bangRecallTitle")}
          >
            {t("bangRecall")}
          </button>
        )}
        {finished && handlers?.onRerun && (
          <button
            type="button"
            className="bang-command-action"
            onClick={() => handlers.onRerun?.(object.command)}
          >
            {t("bangRerun")}
          </button>
        )}
        {finished && handlers?.onEcho && (
          <button
            type="button"
            className="bang-command-action"
            onClick={() => handlers.onEcho?.(object)}
            title={t("bangEchoTitle")}
          >
            {t("bangEcho")}
          </button>
        )}
        {finished && handlers?.onDelete && (
          <button
            type="button"
            className="bang-command-action bang-command-action-delete"
            onClick={() => handlers.onDelete?.(object.id)}
          >
            {t("bangDelete")}
          </button>
        )}
      </div>
    </div>
  );
}
