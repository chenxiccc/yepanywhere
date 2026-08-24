import { sanitizeSessionTitle } from "@yep-anywhere/shared";
import { useEffect } from "react";

const BASE_TITLE = "Yep Anywhere";
export const PROJECT_CODE_NAME_TITLE_ATTRIBUTE = "data-project-code-name";

/**
 * Truncates a string to a maximum length, adding ellipsis if needed.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

export function formatDocumentTitle(
  projectName?: string | null,
  projectCodeName?: string | null,
  sessionName?: string | null,
): string {
  if (!projectName) return BASE_TITLE;
  const safeProjectName = sanitizeSessionTitle(projectName);
  if (!sessionName) return safeProjectName;
  const safeSessionName = sanitizeSessionTitle(sessionName);
  if (projectCodeName) {
    const safeCodeName = sanitizeSessionTitle(projectCodeName);
    return `${safeCodeName}:${safeSessionName}`;
  }
  return `${truncate(safeProjectName, 10)} - ${truncate(safeSessionName, 20)}`;
}

export function useDocumentTitle(
  projectName?: string | null,
  projectCodeName?: string | null,
  sessionName?: string | null,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const titleElement = document.querySelector("title");
    if (projectName && projectCodeName && sessionName) {
      titleElement?.setAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE, "");
    } else {
      titleElement?.removeAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE);
    }
    document.title = formatDocumentTitle(
      projectName,
      projectCodeName,
      sessionName,
    );

    // Restore base title on unmount
    return () => {
      titleElement?.removeAttribute(PROJECT_CODE_NAME_TITLE_ATTRIBUTE);
      document.title = BASE_TITLE;
    };
  }, [enabled, projectCodeName, projectName, sessionName]);
}
