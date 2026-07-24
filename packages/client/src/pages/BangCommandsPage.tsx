/**
 * Top-level cross-session `!!` bang-command history: every locally run
 * command with exit status and on-demand rendered output, linking back to
 * the owning session. Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import {
  type BangCommandOutput,
  BangCommandDisplayObject,
} from "../components/BangCommandDisplayObject";
import { PageHeader } from "../components/PageHeader";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";

interface BangHistoryEntry {
  sessionId: string;
  projectId?: string;
  object: BangCommandTranscriptDisplayObject;
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
