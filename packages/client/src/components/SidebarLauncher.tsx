import type { KeyboardEvent, MouseEvent } from "react";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { toBrowserAppHref } from "../lib/appHref";

interface SidebarLauncherProps {
  label: string;
  newSessionLabel: string;
  onActivate: () => void;
}

export function SidebarToggleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

export function SidebarLauncher({
  label,
  newSessionLabel,
  onActivate,
}: SidebarLauncherProps) {
  const basePath = useRemoteBasePath();
  const newSessionHref = toBrowserAppHref(
    `${basePath}/new-session?sidebar=expanded`,
  );

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onActivate();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== " ") {
      return;
    }
    event.preventDefault();
    onActivate();
  };

  return (
    <a
      className="sidebar-toggle"
      href={newSessionHref}
      target="_blank"
      rel="noopener"
      role="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={`${label} / [Shift] ${newSessionLabel}`}
      aria-label={label}
    >
      <SidebarToggleIcon />
    </a>
  );
}
