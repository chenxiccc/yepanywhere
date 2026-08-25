import type { ReactNode } from "react";
import styles from "./DeliveryGlyph.module.css";

interface DeliveryGlyphProps {
  children: ReactNode;
  className?: string;
}

/** Optically centers font arrows without moving their delivery-button target. */
export function DeliveryGlyph({ children, className }: DeliveryGlyphProps) {
  return (
    <span
      className={className ? `${className} ${styles.glyph}` : styles.glyph}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
