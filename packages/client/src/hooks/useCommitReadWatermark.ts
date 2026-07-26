import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * A per-project "read watermark" for the commit browser (topic:
 * source-review-to-session). One boundary — the author time of the newest
 * commit considered read — splits the list into read (at/older, shown lighter)
 * and unread (newer, shown bold), the usual mail-style convention.
 *
 * "Mark read to here" sets the boundary to the selected commit's author time;
 * "mark unread since here" drops it just below, so the selected commit and
 * everything newer become unread again. Date-based (not list-position) so it
 * survives paging and search, which replace the loaded slice.
 *
 * Device-local (localStorage): read state is personal, like the other UI
 * preferences, not shared through the server.
 */
export interface CommitReadWatermark {
  /** ISO boundary, or null when nothing is marked read (all unread). */
  watermark: string | null;
  /** True when a commit at this author time is at/older than the boundary. */
  isRead: (authorDate: string) => boolean;
  /** Mark this commit and everything older as read. */
  markReadTo: (authorDate: string) => void;
  /** Mark this commit and everything newer as unread. */
  markUnreadSince: (authorDate: string) => void;
}

type WatermarkMap = Record<string, string>;

function loadMap(): WatermarkMap {
  try {
    const raw = localStorage.getItem(UI_KEYS.commitReadWatermarks);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: WatermarkMap = {};
    for (const [key, value] of Object.entries(parsed as object)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function saveMap(map: WatermarkMap) {
  try {
    localStorage.setItem(UI_KEYS.commitReadWatermarks, JSON.stringify(map));
  } catch {
    // Best-effort: a full or unavailable store just loses the read boundary.
  }
}

export function useCommitReadWatermark(projectId: string): CommitReadWatermark {
  const [watermark, setWatermark] = useState<string | null>(
    () => loadMap()[projectId] ?? null,
  );

  useEffect(() => {
    setWatermark(loadMap()[projectId] ?? null);
  }, [projectId]);

  const persist = useCallback(
    (iso: string | null) => {
      setWatermark(iso);
      const map = loadMap();
      if (iso) map[projectId] = iso;
      else delete map[projectId];
      saveMap(map);
    },
    [projectId],
  );

  const isRead = useCallback(
    (authorDate: string) => {
      if (!watermark) return false;
      const boundary = new Date(watermark).getTime();
      const at = new Date(authorDate).getTime();
      if (Number.isNaN(boundary) || Number.isNaN(at)) return false;
      return at <= boundary;
    },
    [watermark],
  );

  const markReadTo = useCallback(
    (authorDate: string) => {
      const at = new Date(authorDate).getTime();
      if (Number.isNaN(at)) return;
      persist(new Date(at).toISOString());
    },
    [persist],
  );

  const markUnreadSince = useCallback(
    (authorDate: string) => {
      const at = new Date(authorDate).getTime();
      if (Number.isNaN(at)) return;
      // One second below: git author times are second-resolution, so this puts
      // the boundary strictly under this commit without needing its neighbor.
      persist(new Date(at - 1000).toISOString());
    },
    [persist],
  );

  return { watermark, isRead, markReadTo, markUnreadSince };
}
