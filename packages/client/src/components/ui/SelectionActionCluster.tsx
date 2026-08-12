import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import styles from "./SelectionActionCluster.module.css";

export const SELECTION_ACTION_BUTTON_SIZE_PX = 30;
export const SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX = 44;
export const SELECTION_ACTION_GAP_PX = 6;

export type SelectionActionKind = "quote" | "source" | "rich";

interface SelectionActionButtonProps {
  kind: SelectionActionKind;
  label: string;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  specimen?: boolean;
}

const GLYPHS: Record<SelectionActionKind, string> = {
  quote: ">",
  source: "MD",
  rich: "Aa",
};
const KIND_STYLES: Record<SelectionActionKind, string> = {
  quote: styles.quote!,
  source: styles.source!,
  rich: styles.rich!,
};

export function SelectionActionButton({
  kind,
  label,
  onClick,
  onPointerDown,
  onPointerUp,
  specimen = false,
}: SelectionActionButtonProps) {
  const className = `${styles.button} ${KIND_STYLES[kind]} ${specimen ? styles.specimen : ""}`;
  if (specimen) {
    return (
      <span
        className={className}
        aria-hidden="true"
        data-selection-action-specimen={kind}
      >
        {GLYPHS[kind]}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown?.(event);
      }}
      onPointerUp={onPointerUp}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {GLYPHS[kind]}
    </button>
  );
}

interface SelectionActionClusterProps {
  children: ReactNode;
  docked?: boolean;
  mobile?: boolean;
  placement?: "above" | "after" | "before" | "below";
  style?: CSSProperties;
}

export function SelectionActionCluster({
  children,
  docked = false,
  mobile = false,
  placement,
  style,
}: SelectionActionClusterProps) {
  return (
    <div
      className={[
        styles.cluster,
        docked ? styles.docked : "",
        mobile ? styles.mobile : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-selection-action-cluster="true"
      data-selection-action-placement={placement}
    >
      {children}
    </div>
  );
}
