export interface TextMatch {
  start: number;
  end: number;
  prefix: string;
  text: string;
  suffix: string;
}

export function findTextMatch(
  text: string,
  rawQuery: string | undefined,
): TextMatch | null {
  const query = rawQuery?.trim();
  if (!query) return null;
  const start = text.toLowerCase().indexOf(query.toLowerCase());
  if (start < 0) return null;
  const end = start + query.length;
  return {
    start,
    end,
    prefix: text.slice(0, start),
    text: text.slice(start, end),
    suffix: text.slice(end),
  };
}
