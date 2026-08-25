import { useEffect, useRef } from "react";
import { useInboxCounts } from "../lib/clientSummaryStore";
import { PROJECT_CODE_NAME_TITLE_ATTRIBUTE } from "./useDocumentTitle";
import { useProjectCodeNamePreferences } from "./useProjectCodeNamePreferences";
import { useTabTitleActivityPreference } from "./useTabTitleActivityPreference";

// Regex to match and strip existing badge prefix like "(3) "
const BADGE_PREFIX_REGEX = /^\(\d+\)\s*/;
const ACTIVITY_PREFIX_REGEX = /^\((?:●|○|\*| )\)\s*/u;
const ACTIVITY_FRAMES = ["bold", "plain"] as const;
export type TabTitleActivityFrame = (typeof ACTIVITY_FRAMES)[number];
export const TAB_TITLE_ACTIVITY_CADENCE_MS = 1500;

function mapCodePoints(
  value: string,
  mapper: (codePoint: number) => number | undefined,
): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) as number;
      const mapped = mapper(codePoint);
      return mapped === undefined ? character : String.fromCodePoint(mapped);
    })
    .join("");
}

export function toMathematicalBold(value: string): string {
  return mapCodePoints(value, (codePoint) => {
    if (codePoint >= 0x41 && codePoint <= 0x5a) {
      return 0x1d400 + codePoint - 0x41;
    }
    if (codePoint >= 0x61 && codePoint <= 0x7a) {
      return 0x1d41a + codePoint - 0x61;
    }
    if (codePoint >= 0x30 && codePoint <= 0x39) {
      return 0x1d7ce + codePoint - 0x30;
    }
    return undefined;
  });
}

export function fromMathematicalBold(value: string): string {
  return mapCodePoints(value, (codePoint) => {
    if (codePoint >= 0x1d400 && codePoint <= 0x1d419) {
      return 0x41 + codePoint - 0x1d400;
    }
    if (codePoint >= 0x1d41a && codePoint <= 0x1d433) {
      return 0x61 + codePoint - 0x1d41a;
    }
    if (codePoint >= 0x1d7ce && codePoint <= 0x1d7d7) {
      return 0x30 + codePoint - 0x1d7ce;
    }
    return undefined;
  });
}

function renderActivityCodeFrame(
  title: string,
  frame: TabTitleActivityFrame | undefined,
  projectCodeNameTitle: boolean,
): string {
  if (!projectCodeNameTitle) return title;
  return title.replace(/^([^:]+):/u, (_match, codeName: string) => {
    const ordinaryCodeName = fromMathematicalBold(codeName);
    return `${frame === "bold" ? toMathematicalBold(ordinaryCodeName) : ordinaryCodeName}:`;
  });
}

export function stripTabTitlePrefixes(
  title: string,
  hostIdentityIcon?: string,
  projectCodeNameTitle = /^[A-Za-z0-9_-]{1,12}:/u.test(title),
): string {
  let next = title;
  for (;;) {
    const stripped = next
      .replace(BADGE_PREFIX_REGEX, "")
      .replace(ACTIVITY_PREFIX_REGEX, "");
    if (stripped === next) {
      break;
    }
    next = stripped;
  }

  const hostPrefix = hostIdentityIcon ? `${hostIdentityIcon} ` : "";
  const withoutHost =
    hostPrefix && next.startsWith(hostPrefix)
      ? next.slice(hostPrefix.length)
      : next;
  return renderActivityCodeFrame(withoutHost, "plain", projectCodeNameTitle);
}

export function composeTabTitle(
  baseTitle: string,
  count: number,
  activityFrame?: TabTitleActivityFrame,
  hostIdentityIcon?: string,
  projectCodeNameTitle = /^[A-Za-z0-9_-]{1,12}:/u.test(baseTitle),
  projectCodeNameActivityPulseEnabled = false,
): string {
  const pulseProjectCodeName =
    projectCodeNameTitle && projectCodeNameActivityPulseEnabled;
  const prefixes: string[] = [];
  if (count > 0) {
    prefixes.push(`(${count})`);
  }
  if (activityFrame && !pulseProjectCodeName) {
    prefixes.push(activityFrame === "bold" ? "(●)" : "(○)");
  }
  if (hostIdentityIcon) {
    prefixes.push(hostIdentityIcon);
  }
  const renderedBaseTitle = renderActivityCodeFrame(
    baseTitle,
    pulseProjectCodeName ? activityFrame : "plain",
    projectCodeNameTitle,
  );
  return prefixes.length > 0
    ? `${prefixes.join(" ")} ${renderedBaseTitle}`
    : renderedBaseTitle;
}

export function getTabTitleActivityFrame(
  activityStartedAtMs: number,
  nowMs = Date.now(),
): TabTitleActivityFrame {
  const elapsedMs = Math.max(0, nowMs - activityStartedAtMs);
  const frameIndex =
    Math.floor(elapsedMs / TAB_TITLE_ACTIVITY_CADENCE_MS) %
    ACTIVITY_FRAMES.length;
  return ACTIVITY_FRAMES[frameIndex] ?? ACTIVITY_FRAMES[0];
}

/**
 * Hook that monitors the global inbox "needs attention" count and updates
 * the browser tab title with indicator prefixes like "(3)" and "(●)".
 *
 * This hook works independently of useDocumentTitle - it observes title changes
 * and prepends/updates indicators as needed.
 *
 * Uses client summary inbox counts - no independent fetching.
 */
export function useNeedsAttentionBadge(hostIdentityIcon?: string) {
  const activityStartedAtRef = useRef<number | null>(null);
  const { needsAttention: count, active } = useInboxCounts();
  const { tabTitleActivityEnabled } = useTabTitleActivityPreference();
  const { projectCodeNameActivityPulseEnabled } =
    useProjectCodeNamePreferences();
  const showSessionActivity = tabTitleActivityEnabled && active > 0;

  useEffect(() => {
    return () => {
      const projectCodeNameTitle = document
        .querySelector("title")
        ?.hasAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE);
      document.title = stripTabTitlePrefixes(
        document.title,
        hostIdentityIcon,
        projectCodeNameTitle,
      );
    };
  }, [hostIdentityIcon]);

  // Update document title when count or configured activity changes.
  useEffect(() => {
    if (showSessionActivity && activityStartedAtRef.current === null) {
      activityStartedAtRef.current = Date.now();
    } else if (!showSessionActivity) {
      activityStartedAtRef.current = null;
    }

    // Track if we're currently updating to avoid observer loop
    let isUpdating = false;
    let activityTimer: ReturnType<typeof setInterval> | null = null;

    const updateTitle = () => {
      isUpdating = true;
      const projectCodeNameTitle = document
        .querySelector("title")
        ?.hasAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE);
      // Strip existing indicator prefixes before composing the next title.
      const baseTitle = stripTabTitlePrefixes(
        document.title,
        hostIdentityIcon,
        projectCodeNameTitle,
      );
      const activityStartedAt = activityStartedAtRef.current;
      const activityFrame =
        showSessionActivity && activityStartedAt !== null
          ? getTabTitleActivityFrame(activityStartedAt)
          : undefined;

      document.title = composeTabTitle(
        baseTitle,
        count,
        activityFrame,
        hostIdentityIcon,
        projectCodeNameTitle,
        projectCodeNameActivityPulseEnabled,
      );
      // Use setTimeout to reset flag after current mutation cycle completes
      setTimeout(() => {
        isUpdating = false;
      }, 0);
    };

    updateTitle();

    if (showSessionActivity) {
      activityTimer = setInterval(() => {
        updateTitle();
      }, TAB_TITLE_ACTIVITY_CADENCE_MS);
    }

    // Also observe title changes from useDocumentTitle and re-apply indicators
    const observer = new MutationObserver(() => {
      // Skip if we're the ones who triggered the change
      if (isUpdating) return;

      // Check if the indicators need to be (re)applied
      const currentTitle = document.title;
      const projectCodeNameTitle = document
        .querySelector("title")
        ?.hasAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE);
      const baseTitle = stripTabTitlePrefixes(
        currentTitle,
        hostIdentityIcon,
        projectCodeNameTitle,
      );
      const activityStartedAt = activityStartedAtRef.current;
      const activityFrame =
        showSessionActivity && activityStartedAt !== null
          ? getTabTitleActivityFrame(activityStartedAt)
          : undefined;
      const expectedTitle = composeTabTitle(
        baseTitle,
        count,
        activityFrame,
        hostIdentityIcon,
        projectCodeNameTitle,
        projectCodeNameActivityPulseEnabled,
      );

      if (currentTitle !== expectedTitle) {
        updateTitle();
      }
    });

    const titleElement = document.querySelector("title");
    if (titleElement) {
      observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return () => {
      observer.disconnect();
      if (activityTimer) {
        clearInterval(activityTimer);
      }
    };
  }, [
    count,
    hostIdentityIcon,
    projectCodeNameActivityPulseEnabled,
    showSessionActivity,
  ]);

  return count;
}
