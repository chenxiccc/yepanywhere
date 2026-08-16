import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toBrowserAppHref } from "../lib/appHref";

export function ProviderChildNavTarget({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  const open = (event: MouseEvent | KeyboardEvent, newTab: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (newTab) {
      window.open(toBrowserAppHref(href), "_blank", "noopener");
      return;
    }
    navigate(href);
  };

  return (
    <span
      role="link"
      tabIndex={0}
      className={className}
      onClick={(event) =>
        open(event, event.metaKey || event.ctrlKey || event.shiftKey)
      }
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        open(event, event.metaKey || event.ctrlKey);
      }}
    >
      {children}
    </span>
  );
}
