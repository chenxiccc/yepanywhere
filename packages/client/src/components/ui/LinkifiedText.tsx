import { Fragment, memo, type ReactNode, useMemo } from "react";
import { containsLinkifiableUrl, splitUrlSegments } from "../../lib/linkify";
import styles from "./LinkifiedText.module.css";

interface Props {
  text: string;
  /** See SplitUrlSegmentsOptions.suppressTrailingUrl. */
  suppressTrailingUrl?: boolean;
  /** Decorate text outside URL anchors without entering those anchors. */
  renderText?: (text: string) => ReactNode;
}

/**
 * Plain text with bare URLs rendered as external links. Anchors stop click
 * propagation so row-level handlers (debug snapshot, chip jump targets) do
 * not also fire on a link click.
 */
export const LinkifiedText = memo(function LinkifiedText({
  text,
  suppressTrailingUrl,
  renderText,
}: Props) {
  const segments = useMemo(
    () =>
      containsLinkifiableUrl(text)
        ? splitUrlSegments(text, { suppressTrailingUrl })
        : null,
    [text, suppressTrailingUrl],
  );

  if (!segments?.some((segment) => segment.type === "url")) {
    return <>{renderText ? renderText(text) : text}</>;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "url" ? (
          <a
            key={`${index}-${segment.text}`}
            className={styles.link}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {segment.text}
          </a>
        ) : (
          <Fragment key={index}>
            {renderText ? renderText(segment.text) : segment.text}
          </Fragment>
        ),
      )}
    </>
  );
});
