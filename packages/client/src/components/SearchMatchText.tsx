import type { HTMLAttributes } from "react";
import { findTextMatch } from "../lib/searchMatch";
import styles from "./SearchMatchText.module.css";

export function SearchMatchText({
  text,
  query,
  wrapMatchOnNarrow = false,
  className,
  ...spanProps
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  text: string;
  query?: string;
  wrapMatchOnNarrow?: boolean;
}) {
  const match = findTextMatch(text, query);
  const textClassName = [
    match ? styles.withMatch : "",
    match && wrapMatchOnNarrow ? styles.wrapMatchOnNarrow : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (!match) {
    return (
      <span {...spanProps} className={textClassName}>
        {text}
      </span>
    );
  }

  return (
    <span {...spanProps} className={textClassName}>
      {match.prefix && (
        <span className={styles.matchPrefix}>{match.prefix}</span>
      )}
      <mark className={styles.match}>{match.text}</mark>
      {match.suffix && (
        <span className={styles.matchSuffix}>{match.suffix}</span>
      )}
    </span>
  );
}
