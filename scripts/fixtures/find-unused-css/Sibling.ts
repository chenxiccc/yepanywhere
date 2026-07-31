import styles from "./Sibling.module.css";

// The word "message" appears here as prose, which must not make
// Sibling.module.css `.message` look used.
export function siblingClassName(): string {
  return styles.card;
}
