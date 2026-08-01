import styles from "./Widget.module.css";

export function widgetClassNames(): string[] {
  return [
    styles.root,
    styles["bracket-access"],
    styles.badge,
    styles.message,
    styles.notDeclared,
    "fixture-used-global",
    "fixture-prefix-button",
  ];
}

// fixture-comment-only is prose, not a rendered class.
