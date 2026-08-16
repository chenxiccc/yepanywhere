import {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
} from "@yep-anywhere/shared";
import { type ReactNode, useMemo } from "react";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { SessionFilePathLink } from "./SessionFilePathLink";

export function ProjectPathLinkedText({
  links,
  text,
}: {
  links?: readonly ProjectPathLinkTarget[];
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
        rendered.push(text.slice(cursor, match.start));
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
    if (cursor < text.length) rendered.push(text.slice(cursor));
    return rendered;
  }, [links, publicShare, text]);

  return segments ?? text;
}
