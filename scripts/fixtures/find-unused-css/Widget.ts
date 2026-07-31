import styles from "./Widget.module.css";

export function widgetClassNames(): string[] {
  return [
    styles.root,
    styles["bracket-access"],
    styles.badge,
    styles.message,
    "fixture-used-global",
  ];
}
