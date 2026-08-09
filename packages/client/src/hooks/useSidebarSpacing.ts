import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type SidebarSpacing = "compact" | "comfortable";

export const SIDEBAR_SPACINGS: SidebarSpacing[] = ["compact", "comfortable"];

const DEFAULT_SIDEBAR_SPACING: SidebarSpacing = "comfortable";

const sidebarSpacingMetrics: Record<
  SidebarSpacing,
  {
    rowMinHeight: string;
    rowPaddingBlock: string;
    rowLineHeight: string;
    navigationPaddingBlock: string;
    navigationInlineSpacing: string;
    sectionGap: string;
    sectionHeaderGap: string;
    headerPadding: string;
    actionsPaddingTop: string;
    sessionsPaddingTop: string;
  }
> = {
  compact: {
    rowMinHeight: "calc(1.5rem + 1px)",
    rowPaddingBlock: "2px",
    rowLineHeight: "1.2",
    navigationPaddingBlock: "0.25em",
    navigationInlineSpacing: "0.5rem",
    sectionGap: "0.5em",
    sectionHeaderGap: "0.25em",
    headerPadding: "0.25rem 0.5rem",
    actionsPaddingTop: "1px",
    sessionsPaddingTop: "0",
  },
  comfortable: {
    rowMinHeight: "34px",
    rowPaddingBlock: "var(--space-1)",
    rowLineHeight: "1.3",
    navigationPaddingBlock: "0.5rem",
    navigationInlineSpacing: "0.75rem",
    sectionGap: "1rem",
    sectionHeaderGap: "0.5rem",
    headerPadding: "0.75rem 1rem",
    actionsPaddingTop: "0",
    sessionsPaddingTop: "0.25rem",
  },
};

function applySidebarSpacing(spacing: SidebarSpacing): void {
  const root = document.documentElement;
  const metrics = sidebarSpacingMetrics[spacing];
  root.style.removeProperty("--sidebar-navigation-font-size");
  root.style.removeProperty("--sidebar-header-justify-content");
  root.style.removeProperty("--sidebar-brand-display");
  root.dataset.sidebarSpacing = spacing;
  root.style.setProperty("--sidebar-row-min-height", metrics.rowMinHeight);
  root.style.setProperty(
    "--sidebar-row-padding-block",
    metrics.rowPaddingBlock,
  );
  root.style.setProperty("--sidebar-row-line-height", metrics.rowLineHeight);
  root.style.setProperty(
    "--sidebar-navigation-padding-block",
    metrics.navigationPaddingBlock,
  );
  root.style.setProperty(
    "--sidebar-navigation-inline-spacing",
    metrics.navigationInlineSpacing,
  );
  root.style.setProperty("--sidebar-section-gap", metrics.sectionGap);
  root.style.setProperty(
    "--sidebar-section-header-gap",
    metrics.sectionHeaderGap,
  );
  root.style.setProperty("--sidebar-header-padding", metrics.headerPadding);
  root.style.setProperty(
    "--sidebar-actions-padding-top",
    metrics.actionsPaddingTop,
  );
  root.style.setProperty(
    "--sidebar-sessions-padding-top",
    metrics.sessionsPaddingTop,
  );
}

function loadSidebarSpacing(): SidebarSpacing {
  const stored = localStorage.getItem(UI_KEYS.sidebarSpacing);
  return SIDEBAR_SPACINGS.includes(stored as SidebarSpacing)
    ? (stored as SidebarSpacing)
    : DEFAULT_SIDEBAR_SPACING;
}

export function useSidebarSpacing() {
  const [sidebarSpacing, setSidebarSpacingState] =
    useState<SidebarSpacing>(loadSidebarSpacing);

  useEffect(() => {
    applySidebarSpacing(sidebarSpacing);
  }, [sidebarSpacing]);

  const setSidebarSpacing = useCallback((spacing: SidebarSpacing) => {
    setSidebarSpacingState(spacing);
    localStorage.setItem(UI_KEYS.sidebarSpacing, spacing);
  }, []);

  return { sidebarSpacing, setSidebarSpacing };
}

export function initializeSidebarSpacing(): void {
  applySidebarSpacing(loadSidebarSpacing());
}
