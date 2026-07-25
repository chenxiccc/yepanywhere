/**
 * Top-level cross-session `!!` bang-command history: every locally run
 * command with exit status and on-demand rendered output, linking back to
 * the owning session. Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  type BangCommandOutput,
  BangCommandDisplayObject,
} from "../components/BangCommandDisplayObject";
import { PageHeader } from "../components/PageHeader";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { createSessionNavigationState } from "../lib/sessionNavigationState";

interface BangHistoryEntry {
  sessionId: string;
  projectId?: string;
  object: BangCommandTranscriptDisplayObject;
}

/**
 * Per-entry actions, all scoped to the entry's source session (which carries
 * its project cwd). See topics/bang-commands.md § Top-level history view.
 * Each navigates to the source session with navigation state consumed once by
 * SessionPage: edit prefills `!!<command>`, new focuses an empty composer,
 * jump scrolls to the bang block's render row (its `data-render-id` is the
 * transcript display object id).
 */
function BangHistoryEntryActions({
  projectId,
  sessionId,
  command,
  objectId,
}: {
  projectId: string;
  sessionId: string;
  command: string;
  objectId: string;
}) {
  const navigate = useNavigate();
  const sessionPath = `/projects/${projectId}/sessions/${sessionId}`;
  return (
    <span className="bang-history-entry-actions">
      <button
        type="button"
        className="bang-history-entry-action"
        // TODO(i18n): needs an en.json key (e.g. bangHistoryActionEdit);
        // inline literal while packages/client/src/i18n/en.json is peer-held.
        aria-label="Edit / re-issue command"
        title="Edit / re-issue command"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({
              composerPrefill: `!!${command}`,
            }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />
        </svg>
      </button>
      <button
        type="button"
        className="bang-history-entry-action"
        // TODO(i18n): needs an en.json key (e.g. bangHistoryActionNew).
        aria-label="New command in session"
        title="New command in session"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({ focusComposer: true }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </button>
      <button
        type="button"
        className="bang-history-entry-action"
        // TODO(i18n): needs an en.json key (e.g. bangHistoryActionJump).
        aria-label="Jump to command in session"
        title="Jump to command in session"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({
              scrollToRenderId: objectId,
            }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 2.5v7M4.5 6l3.5 3.5L11.5 6M3 13h10" />
        </svg>
      </button>
    </span>
  );
}

export function BangCommandsPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const [entries, setEntries] = useState<BangHistoryEntry[] | null>(null);
  const [expandedEntryKey, setExpandedEntryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchBangCommandHistory().then(
      (result) => {
        if (cancelled) return;
        setEntries(
          result.entries.filter(
            (entry): entry is BangHistoryEntry =>
              entry.object.kind === "bang-command",
          ),
        );
      },
      () => {
        if (!cancelled) setEntries([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("bangHistoryTitle")} onOpenSidebar={openSidebar} />
      <div className="bang-history-page">
        {entries !== null && entries.length === 0 && (
          <div className="bang-history-empty">{t("bangHistoryEmpty")}</div>
        )}
        {entries?.map((entry) => {
          const entryKey = `${entry.sessionId}-${entry.object.id}`;
          return (
            <div className="bang-history-entry" key={entryKey}>
              <div className="bang-history-entry-meta">
                <span className="bang-history-entry-time">
                  {new Date(entry.object.createdAt).toLocaleString()}
                </span>
                <span
                  className="bang-history-entry-cwd"
                  title={entry.object.cwd}
                >
                  {entry.object.cwd.split("/").pop()}
                </span>
                {entry.projectId && (
                  <Link
                    to={`/projects/${entry.projectId}/sessions/${entry.sessionId}`}
                    className="bang-history-entry-session"
                  >
                    {t("bangHistoryOpenSession")}
                  </Link>
                )}
                {entry.projectId && (
                  <BangHistoryEntryActions
                    projectId={entry.projectId}
                    sessionId={entry.sessionId}
                    command={entry.object.command}
                    objectId={entry.object.id}
                  />
                )}
              </div>
              <BangCommandDisplayObject
                object={entry.object}
                outputExpanded={expandedEntryKey === entryKey}
                onOutputExpandedChange={(expanded) => {
                  setExpandedEntryKey(expanded ? entryKey : null);
                }}
                handlers={
                  entry.projectId
                    ? {
                        fetchOutput: (objectId: string) =>
                          api.fetchBangCommandOutput(
                            entry.projectId as string,
                            entry.sessionId,
                            objectId,
                          ) as Promise<BangCommandOutput>,
                      }
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>
    </MainContent>
  );
}
