import { useState } from "react";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { LocalMediaModal } from "../../LocalMediaModal";
import type { ToolRenderer } from "./types";

interface ViewImageInput {
  path: string;
}

function getFileName(path: string): string {
  return getPathBasename(path);
}

/**
 * Clickable filename button that opens a modal to view the image.
 * Does NOT fetch anything until the modal is opened.
 */
function ViewImageButton({
  path,
  className,
  onClick,
  projectPath,
}: {
  path: string;
  className: string;
  onClick: (e: React.MouseEvent) => void;
  projectPath?: string | null;
}) {
  const displayPath = makeDisplayPath(path, projectPath);
  return (
    <button type="button" className={className} onClick={onClick}>
      {getFileName(displayPath)}
      <span className="file-line-count-inline">(image)</span>
    </button>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  path,
  buttonClass,
  stopPropagation,
  projectPath,
}: {
  path: string;
  buttonClass: string;
  stopPropagation?: boolean;
  projectPath?: string | null;
}) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <ViewImageButton
        path={path}
        className={buttonClass}
        projectPath={projectPath}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          setShowModal(true);
        }}
      />
      {showModal && (
        <LocalMediaModal
          path={path}
          mediaType="image"
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

export const viewImageRenderer: ToolRenderer<ViewImageInput, unknown> = {
  tool: "ViewImage",
  displayName: "View Image",

  renderToolUse(input, context) {
    const { path } = input as ViewImageInput;
    return (
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  renderToolResult(_result, _isError, context, input) {
    const { path } = input as ViewImageInput;
    return (
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  getUseSummary(input, context) {
    const path = (input as ViewImageInput)?.path ?? "";
    return getFileName(makeDisplayPath(path, context?.projectPath));
  },

  getResultSummary(_result, isError) {
    return isError ? "Error" : "Image loaded";
  },

  renderInteractiveSummary(input, _result, _isError, context) {
    const { path } = input as ViewImageInput;
    return (
      <ViewImageClickable
        path={path}
        buttonClass="file-link-inline"
        projectPath={context.projectPath}
        stopPropagation
      />
    );
  },
};
