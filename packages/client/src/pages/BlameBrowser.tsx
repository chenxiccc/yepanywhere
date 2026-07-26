import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/ui/Modal";
import { BlameView } from "./BlameView";

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

const FILE_LIST_RENDER_CAP = 500;

/**
 * The all-files blame browser (topic: source-review-to-session, stage 3): the
 * repo's tracked files (`git ls-files`) with an instant filename filter, and a
 * blame view of the selected file. A subsection of the source-control surface,
 * not a standalone browser — blame comments feed the same review accumulator.
 */
export function BlameBrowser({
  projectId,
  isWideScreen,
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
  t: TranslationFn;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);
    setSelectedPath(null);
    api
      .listGitFiles(projectId)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("gitStatusLoading"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list;
  }, [files, query]);

  return (
    <div className="blame-browser">
      <div className="blame-browser-columns">
        <div className="blame-file-column">
          <input
            type="search"
            className="source-search-input"
            value={query}
            placeholder={t("sourceFilterFiles")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading ? (
            <div className="git-diff-loading">{t("gitStatusLoading")}</div>
          ) : error ? (
            <div className="git-diff-error">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="git-status-empty">{t("sourceNoFiles")}</div>
          ) : (
            <ul className="blame-file-list">
              {filtered.slice(0, FILE_LIST_RENDER_CAP).map((file) => (
                <li key={file} className="commit-file-row">
                  <button
                    type="button"
                    className={`blame-file-item ${
                      selectedPath === file ? "selected" : ""
                    }`}
                    onClick={() => setSelectedPath(file)}
                  >
                    <span className="git-file-path">{file}</span>
                  </button>
                  <CopyButton
                    value={file}
                    title={t("sourceCopyPath")}
                    className="source-row-copy"
                  />
                </li>
              ))}
              {filtered.length > FILE_LIST_RENDER_CAP && (
                <li className="blame-file-more">
                  {t("sourceFilesTruncated", {
                    shown: FILE_LIST_RENDER_CAP,
                    total: filtered.length,
                  })}
                </li>
              )}
            </ul>
          )}
        </div>

        {isWideScreen && selectedPath && (
          <BlameView projectId={projectId} path={selectedPath} t={t} />
        )}
      </div>

      {!isWideScreen && selectedPath && (
        <Modal title={selectedPath} onClose={() => setSelectedPath(null)}>
          <BlameView projectId={projectId} path={selectedPath} t={t} />
        </Modal>
      )}
    </div>
  );
}
