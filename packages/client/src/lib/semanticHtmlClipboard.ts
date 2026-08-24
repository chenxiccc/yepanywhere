const SEMANTIC_ELEMENTS = new Set([
  "A",
  "ABBR",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CAPTION",
  "CITE",
  "CODE",
  "COL",
  "COLGROUP",
  "DD",
  "DEL",
  "DL",
  "DT",
  "EM",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "INS",
  "KBD",
  "LI",
  "MARK",
  "MATH",
  "MENCLOSE",
  "MFENCED",
  "MFRAC",
  "MI",
  "MMULTISCRIPTS",
  "MN",
  "MO",
  "MOVER",
  "MPADDED",
  "MPHANTOM",
  "MROOT",
  "MROW",
  "MS",
  "SEMANTICS",
  "MSPACE",
  "MSQRT",
  "MSTYLE",
  "MSUB",
  "MSUBSUP",
  "MSUP",
  "MTABLE",
  "MTD",
  "MTEXT",
  "MTR",
  "MUNDER",
  "MUNDEROVER",
  "OL",
  "P",
  "PRE",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TIME",
  "TR",
  "U",
  "UL",
  "VAR",
  "ANNOTATION",
]);
const SEMANTIC_ATTRIBUTES = new Map([
  ["COL", new Set(["span"])],
  ["COLGROUP", new Set(["span"])],
  ["OL", new Set(["reversed", "start", "type"])],
  ["TD", new Set(["colspan", "rowspan"])],
  ["TH", new Set(["colspan", "rowspan", "scope"])],
  ["TIME", new Set(["datetime"])],
]);
const ACTIVE_CONTENT_ELEMENTS =
  "applet, audio, canvas, embed, iframe, object, script, style, svg, template, video";
const TABLE_CONTEXT_ELEMENTS = new Set([
  "COLGROUP",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
]);

function rangeIsWithin(root: HTMLElement, range: Range): boolean {
  return (
    (range.startContainer === root || root.contains(range.startContainer)) &&
    (range.endContainer === root || root.contains(range.endContainer))
  );
}

function removeKatexVisualBranches(fragment: DocumentFragment): void {
  for (const visualMath of fragment.querySelectorAll(".katex-html")) {
    visualMath.remove();
  }
}

function removePresentation(fragment: DocumentFragment): void {
  removeKatexVisualBranches(fragment);

  for (const activeContent of fragment.querySelectorAll(
    ACTIVE_CONTENT_ELEMENTS,
  )) {
    activeContent.remove();
  }

  for (const element of fragment.querySelectorAll("*")) {
    const tagName = element.tagName.toUpperCase();
    if (!SEMANTIC_ELEMENTS.has(tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const allowedAttributes = SEMANTIC_ATTRIBUTES.get(tagName);
    for (const attribute of element.getAttributeNames()) {
      if (!allowedAttributes?.has(attribute.toLowerCase())) {
        element.removeAttribute(attribute);
      }
    }
  }
}

function cloneWithTableContext(
  range: Range,
  root: HTMLElement,
): DocumentFragment {
  const fragment = range.cloneContents();
  const commonElement =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!commonElement || !TABLE_CONTEXT_ELEMENTS.has(commonElement.tagName)) {
    return fragment;
  }

  let wrapped: Node = fragment;
  let context: Element | null = commonElement;
  while (context && context !== root) {
    const wrapper = context.cloneNode(false) as Element;
    wrapper.append(wrapped);
    wrapped = wrapper;
    if (context.tagName === "TABLE") {
      break;
    }
    context = context.parentElement;
  }

  const contextualFragment = root.ownerDocument.createDocumentFragment();
  contextualFragment.append(wrapped);
  return contextualFragment;
}

export interface SemanticHtmlClipboardPayload {
  html: string;
  text: string;
}

/** Build the payload a rendered-document select-all would produce. */
export function getSemanticHtmlClipboardPayloadFromHtml(
  html: string,
): SemanticHtmlClipboardPayload | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const range = parsed.createRange();
  range.selectNodeContents(parsed.body);
  return getSemanticHtmlClipboardPayload(parsed.body, [range]);
}

export function getSemanticHtmlClipboardPayload(
  root: HTMLElement,
  ranges: readonly Range[],
): SemanticHtmlClipboardPayload | null {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const range of ranges) {
    if (!rangeIsWithin(root, range)) {
      return null;
    }

    const fragment = cloneWithTableContext(range, root);
    removePresentation(fragment);
    const container = root.ownerDocument.createElement("div");
    container.append(fragment);
    if (container.innerHTML) {
      htmlParts.push(container.innerHTML);
      textParts.push(container.textContent ?? range.toString());
    }
  }

  if (htmlParts.length === 0) {
    return null;
  }

  return {
    html: htmlParts.join("<br><br>"),
    text: textParts.join("\n\n"),
  };
}

export function copySemanticHtmlSelectionToClipboard(
  event: ClipboardEvent,
  root: HTMLElement,
): boolean {
  if (event.defaultPrevented || !event.clipboardData) {
    return false;
  }

  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index));
  }
  const payload = getSemanticHtmlClipboardPayload(root, ranges);
  if (!payload) {
    return false;
  }

  event.clipboardData.setData("text/html", payload.html);
  event.clipboardData.setData("text/plain", payload.text);
  event.preventDefault();
  return true;
}
