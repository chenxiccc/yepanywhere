import { matchGlossaryText, type GlossaryArtifact } from "@yep-anywhere/shared";
import styles from "../../components/GlossaryTerm.module.css";

const EXCLUDED_SELECTOR = [
  "a",
  "button",
  "code",
  "input",
  "kbd",
  "pre",
  "samp",
  "script",
  "select",
  "style",
  "textarea",
  "[data-glossary-term]",
  "[data-tooltip]",
  "[title]",
  ".katex",
].join(",");

const BLOCK_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

interface TextSegment {
  end: number;
  node: Text;
  start: number;
}

interface TextRun {
  segments: TextSegment[];
  text: string;
}

export interface AnnotatedGlossaryHtml {
  changed: boolean;
  html: string;
}

function collectTextRuns(root: DocumentFragment): TextRun[] {
  const runs: TextRun[] = [];
  let segments: TextSegment[] = [];
  let text = "";

  const flush = () => {
    if (text) runs.push({ segments, text });
    segments = [];
    text = "";
  };

  const visit = (node: Node) => {
    if (node instanceof Text) {
      if (!node.data) return;
      const start = text.length;
      text += node.data;
      segments.push({ start, end: text.length, node });
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(EXCLUDED_SELECTOR)) {
      flush();
      return;
    }
    const boundary = BLOCK_ELEMENTS.has(node.tagName) || node.tagName === "BR";
    if (boundary) flush();
    for (const child of node.childNodes) visit(child);
    if (boundary) flush();
  };

  for (const child of root.childNodes) visit(child);
  flush();
  return runs;
}

function wrapTextSlice(
  segment: TextSegment,
  start: number,
  end: number,
  definitionText: string,
  focusable: boolean,
  matchId: string,
): void {
  const localStart = Math.max(start, segment.start) - segment.start;
  const localEnd = Math.min(end, segment.end) - segment.start;
  if (localStart >= localEnd) return;

  const suffix = segment.node.splitText(localEnd);
  const matched = segment.node.splitText(localStart);
  const wrapper = document.createElement("span");
  wrapper.className = styles.term!;
  wrapper.dataset.glossaryTerm = "true";
  wrapper.dataset.glossaryMatch = matchId;
  wrapper.title = definitionText;
  if (focusable) {
    wrapper.setAttribute("role", "button");
    wrapper.tabIndex = 0;
  }
  matched.replaceWith(wrapper);
  wrapper.append(matched);
  void suffix;
}

/** Annotate one already-sanitized detached Markdown fragment. */
export function annotateGlossaryHtml(
  html: string,
  artifact: GlossaryArtifact | null | undefined,
): AnnotatedGlossaryHtml {
  if (!artifact || typeof document === "undefined" || !html) {
    return { changed: false, html };
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const runs = collectTextRuns(template.content);
  let matchOrdinal = 0;
  let changed = false;

  for (const run of runs) {
    const matches = matchGlossaryText(run.text, artifact);
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      if (!match) continue;
      const overlapping = run.segments.filter(
        (segment) => segment.start < match.end && match.start < segment.end,
      );
      if (overlapping.length === 0) continue;
      const matchId = `g${matchOrdinal++}`;
      for (
        let segmentIndex = overlapping.length - 1;
        segmentIndex >= 0;
        segmentIndex -= 1
      ) {
        const segment = overlapping[segmentIndex];
        if (!segment) continue;
        wrapTextSlice(
          segment,
          match.start,
          match.end,
          match.definitionText,
          segmentIndex === 0,
          matchId,
        );
      }
      changed = true;
    }
  }

  return { changed, html: changed ? template.innerHTML : html };
}
