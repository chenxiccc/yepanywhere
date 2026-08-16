import type {
  GlossaryArtifact,
  ProjectPathLinkTarget,
} from "@yep-anywhere/shared";
import { type ReactNode, useCallback, useMemo } from "react";
import { useGlossaryArtifact } from "../../contexts/GlossaryContext";
import { annotateGlossaryHtml } from "../../lib/glossary/annotateGlossaryHtml";
import { ProjectPathLinkedText } from "../ProjectPathLinkedText";
import { LinkifiedText } from "../ui/LinkifiedText";

function escapePlainTextHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function GlossaryPlainText({
  artifact,
  text,
}: {
  artifact?: GlossaryArtifact;
  text: string;
}): ReactNode {
  const annotated = useMemo(
    () => annotateGlossaryHtml(escapePlainTextHtml(text), artifact),
    [artifact, text],
  );
  if (!annotated.changed) return text;
  return (
    <span
      // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped plain text annotated by the shared glossary transformer
      dangerouslySetInnerHTML={{ __html: annotated.html }}
    />
  );
}

export function UserPromptLinkedTextContent({
  artifact,
  projectPathLinks,
  suppressTrailingUrl,
  text,
}: {
  artifact?: GlossaryArtifact;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  suppressTrailingUrl?: boolean;
  text: string;
}) {
  const renderGlossaryText = useCallback(
    (plainText: string) => (
      <GlossaryPlainText artifact={artifact} text={plainText} />
    ),
    [artifact],
  );
  const renderNonPathText = useCallback(
    (plainText: string) => (
      <LinkifiedText
        text={plainText}
        suppressTrailingUrl={suppressTrailingUrl}
        renderText={renderGlossaryText}
      />
    ),
    [renderGlossaryText, suppressTrailingUrl],
  );

  return (
    <ProjectPathLinkedText
      links={projectPathLinks}
      text={text}
      renderText={renderNonPathText}
    />
  );
}

export function UserPromptLinkedText({
  projectPathLinks,
  suppressTrailingUrl,
  text,
}: {
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  suppressTrailingUrl?: boolean;
  text: string;
}) {
  const glossary = useGlossaryArtifact();
  const artifact =
    glossary.state === "ready" && glossary.result?.status === "ready"
      ? glossary.result.artifact
      : undefined;

  return (
    <UserPromptLinkedTextContent
      artifact={artifact}
      projectPathLinks={projectPathLinks}
      suppressTrailingUrl={suppressTrailingUrl}
      text={text}
    />
  );
}
