import {
  MAX_PROJECT_CODE_NAME_LENGTH,
  normalizeProjectCodeName,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import styles from "./ProjectCodeNameEditor.module.css";

interface ProjectCodeNameEditorProps {
  project: Project;
  onUpdateCodeName?: (project: Project, codeName: string) => Promise<void>;
}

export function ProjectCodeNameEditor({
  project,
  onUpdateCodeName,
}: ProjectCodeNameEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.codeName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEdit = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(project.codeName ?? "");
    setError(null);
    setEditing(true);
  };

  const cancelEdit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(project.codeName ?? "");
    setError(null);
    setEditing(false);
  };

  const commitEdit = async () => {
    if (!onUpdateCodeName || saving) return;
    let codeName: string;
    try {
      codeName = normalizeProjectCodeName(draft);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("projectCodeNameInvalid"),
      );
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (codeName === project.codeName) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onUpdateCodeName(project, codeName);
      setEditing(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("projectCodeNameSaveFailed"),
      );
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  if (!project.codeName) return null;

  return (
    <div className={styles.slot}>
      {editing && onUpdateCodeName ? (
        <div className={styles.editor}>
          <input
            ref={inputRef}
            aria-label={t("projectCodeNameLabel")}
            aria-invalid={error ? true : undefined}
            className={styles.input}
            disabled={saving}
            maxLength={MAX_PROJECT_CODE_NAME_LENGTH}
            value={draft}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={() => void commitEdit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                cancelEdit(event);
              }
            }}
          />
          <button
            type="button"
            className={styles.cancel}
            aria-label={t("projectCodeNameCancelEdit")}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelEdit}
          >
            ×
          </button>
        </div>
      ) : onUpdateCodeName ? (
        <button
          type="button"
          className={styles.codeName}
          aria-label={t("projectCodeNameEdit")}
          onClick={startEdit}
        >
          {project.codeName}
        </button>
      ) : (
        <span className={styles.codeName}>{project.codeName}</span>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
