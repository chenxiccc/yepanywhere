/** A path occurrence the server proved can open in the current project viewer. */
export interface ProjectPathLinkTarget {
  /** Exact visible token to turn into a link. */
  text: string;
  /** Project-relative or authorized absolute path passed to the file viewer. */
  filePath: string;
}

export interface ProjectPathToken {
  end: number;
  kind: "absolute" | "relative";
  start: number;
  text: string;
}

/** Characters that can occur in a project-relative path token. */
const RELATIVE_PATH_TOKEN = /[^\s"'`<>&,:;()[\]{}=|]+/g;

/** One absolute token runs from a whitespace boundary to the next whitespace. */
const ABSOLUTE_PATH_TOKEN = /(?:^|\s)((?:\/(?!\/)|[A-Za-z]:[\\/])\S+)/g;

/** Sentence punctuation is not part of a project-relative path. */
const TRAILING_NOISE = /[.!?]+$/;

/**
 * Split raw display text into the same candidate tokens used by server path
 * resolution. Consumers still need server-confirmed targets before linking.
 */
export function findProjectPathTokens(text: string): ProjectPathToken[] {
  const absoluteTokens: ProjectPathToken[] = [];

  ABSOLUTE_PATH_TOKEN.lastIndex = 0;
  let absoluteMatch: RegExpExecArray | null = ABSOLUTE_PATH_TOKEN.exec(text);
  while (absoluteMatch !== null) {
    const token = absoluteMatch[1];
    if (token) {
      const start =
        absoluteMatch.index + absoluteMatch[0].length - token.length;
      absoluteTokens.push({
        end: start + token.length,
        kind: "absolute",
        start,
        text: token,
      });
    }
    absoluteMatch = ABSOLUTE_PATH_TOKEN.exec(text);
  }

  const tokens = [...absoluteTokens];
  let absoluteIndex = 0;
  RELATIVE_PATH_TOKEN.lastIndex = 0;
  let relativeMatch: RegExpExecArray | null = RELATIVE_PATH_TOKEN.exec(text);
  while (relativeMatch !== null) {
    const rawToken = relativeMatch[0];
    const token = rawToken.replace(TRAILING_NOISE, "");
    const start = relativeMatch.index;
    const end = start + token.length;
    while (
      absoluteTokens[absoluteIndex] &&
      absoluteTokens[absoluteIndex]!.end <= start
    ) {
      absoluteIndex += 1;
    }
    const absolute = absoluteTokens[absoluteIndex];
    const overlapsAbsolute =
      !!absolute && start < absolute.end && end > absolute.start;
    if (token && !token.startsWith("/") && !overlapsAbsolute) {
      tokens.push({ end, kind: "relative", start, text: token });
    }
    relativeMatch = RELATIVE_PATH_TOKEN.exec(text);
  }

  return tokens.sort((left, right) => left.start - right.start);
}
