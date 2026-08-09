import styles from "./CompactResumeButton.module.css";

interface CompactResumeButtonProps {
  label: string;
  title: string;
  pending?: boolean;
  onResume: () => void | Promise<void>;
}

export function CompactResumeButton({
  label,
  title,
  pending = false,
  onResume,
}: CompactResumeButtonProps) {
  return (
    <button
      type="button"
      className={styles.button}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void onResume();
      }}
      disabled={pending}
      title={title}
      aria-label={label}
    >
      {pending ? "…" : label}
    </button>
  );
}
