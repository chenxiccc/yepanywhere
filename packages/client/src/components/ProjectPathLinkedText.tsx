import {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
} from "@yep-anywhere/shared";
import { Fragment, type ReactNode, useMemo } from "react";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { SessionFilePathLink } from "./SessionFilePathLink";

export function ProjectPathLinkedText({
  links,
  renderText,
  text,
}: {
  links?: readonly ProjectPathLinkTarget[];
  renderText?: (text: string) => ReactNode;
  text: string;
}): ReactNode {
  const publicShare = usePublicShareContext();
  const segments = useMemo(() => {
    if (publicShare || !links?.length) return null;
    const targets = new Map(links.map((link) => [link.text, link.filePath]));
    const matches = findProjectPathTokens(text).filter((token) =>
      targets.has(token.text),
    );
    if (matches.length === 0) return null;

    const rendered: ReactNode[] = [];
    let cursor = 0;
    for (const [index, match] of matches.entries()) {
      if (match.start > cursor) {
        const plainText = text.slice(cursor, match.start);
        rendered.push(
          <Fragment key={`text-${cursor}`}>
            {renderText ? renderText(plainText) : plainText}
          </Fragment>,
        );
      }
      rendered.push(
        <SessionFilePathLink
          key={`${match.start}-${index}`}
          displayPath={match.text}
          filePath={targets.get(match.text)!}
          showCopyButton={false}
          showLineSuffix={false}
          showVersionControlLinks={false}
        />,
      );
      cursor = match.end;
    }
    if (cursor < text.length) {
      const plainText = text.slice(cursor);
      rendered.push(
        <Fragment key={`text-${cursor}`}>
          {renderText ? renderText(plainText) : plainText}
        </Fragment>,
      );
    }
    return rendered;
  }, [links, publicShare, renderText, text]);

  if (segments) return segments;
  return renderText ? renderText(text) : text;
}
