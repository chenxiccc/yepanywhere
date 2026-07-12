const PROJECT_TERMINAL_SELECTED_TAB_PREFIX = "project-terminal-selected-tab-";

function getStorageKey(projectId: string): string {
  return `${PROJECT_TERMINAL_SELECTED_TAB_PREFIX}${projectId}`;
}

export function getSelectedTerminalTabId(projectId: string): string | null {
  try {
    return localStorage.getItem(getStorageKey(projectId));
  } catch {
    return null;
  }
}

export function setSelectedTerminalTabId(
  projectId: string,
  tabId: string,
): void {
  try {
    localStorage.setItem(getStorageKey(projectId), tabId);
  } catch {
    // localStorage may be unavailable
  }
}

export function clearSelectedTerminalTabId(projectId: string): void {
  try {
    localStorage.removeItem(getStorageKey(projectId));
  } catch {
    // localStorage may be unavailable
  }
}
