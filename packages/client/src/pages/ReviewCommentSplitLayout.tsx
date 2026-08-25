import type { ReactNode } from "react";
import styles from "./ReviewCommentSplitLayout.module.css";

/** Keep the selected source row visible by placing the editor between views. */
export function ReviewCommentSplitLayout({
  before,
  editor,
  after,
}: {
  before: ReactNode;
  editor: ReactNode | null;
  after?: ReactNode;
}) {
  if (!editor) return <>{before}</>;

  return (
    <div className={styles.root} data-review-comment-split="">
      <div className={styles.source} data-review-comment-before="">
        {before}
      </div>
      <div className={styles.editor}>{editor}</div>
      <div className={styles.source} data-review-comment-after="">
        {after}
      </div>
    </div>
  );
}

/** Render the shared editor styling inside a source-owned insertion host. */
export function ReviewCommentInlineLayout({
  editor,
}: {
  editor: ReactNode | null;
}) {
  if (!editor) return null;

  return (
    <div className={styles.root} data-review-comment-inline="">
      <div className={styles.editor}>{editor}</div>
    </div>
  );
}
