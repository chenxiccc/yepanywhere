import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { getProjectRelativePath, makeDisplayPath } from "../lib/text";
import { FilePathCopyButton, FilePathLink } from "./FilePathLink";
import type { FileViewerMode } from "./FileViewer";
import { FilePathDisplay } from "./ui/FilePathDisplay";

export function SessionFilePathLink({
  displayPath,
  filePath,
  lineEnd,
  lineNumber,
  showLineSuffix,
  viewMode,
  showCopyButton = true,
  showVersionControlLinks = true,
}: {
  displayPath?: string;
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
  showLineSuffix?: boolean;
  viewMode?: FileViewerMode;
  /** Set false where the same path already carries a copy button nearby */
  showCopyButton?: boolean;
  /** Set false in prose-like text where adjacent source-control chrome is noise. */
  showVersionControlLinks?: boolean;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const resolvedDisplayPath =
    displayPath ?? makeDisplayPath(filePath, sessionMetadata?.projectPath);
  if (sessionMetadata?.projectId) {
    return (
      <FilePathLink
        projectId={sessionMetadata.projectId}
        filePath={filePath}
        displayText={resolvedDisplayPath}
        lineEnd={lineEnd}
        lineNumber={lineNumber}
        showLineSuffix={showLineSuffix}
        viewMode={viewMode}
        showCopyButton={showCopyButton}
        showVersionControlLinks={showVersionControlLinks}
      />
    );
  }
  return (
    <>
      <FilePathDisplay displayPath={resolvedDisplayPath} />
      {showCopyButton && (
        <FilePathCopyButton
          filePath={
            // Relative when under the project; verbatim otherwise. Not the
            // display path, which may be a caller label or ~-shortened.
            getProjectRelativePath(filePath, sessionMetadata?.projectPath) ??
            filePath
          }
        />
      )}
    </>
  );
}
