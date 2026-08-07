import {
  flattenGlossaryInlineMarkdown,
  parseGlossaryInline,
  splitGlossaryAlternatives,
} from "./markdown.js";
import { normalizeGlossaryText } from "./normalization.js";
import {
  GLOSSARY_ARTIFACT_VERSION,
  GLOSSARY_LIMITS,
  type GlossaryArtifactNode,
  type GlossaryArtifactTerminal,
  type GlossaryCompileDiagnostic,
  type GlossaryCompileResult,
  type GlossaryDefinitionContribution,
  type GlossaryLimits,
  type GlossaryRowInput,
} from "./types.js";

interface PhraseToken {
  required: boolean;
  text: string;
}

interface ExpandedPhrase {
  canonicalLabel: string;
  form: string;
  requiredBoldCodePoints: number;
}

interface WorkingTerminal {
  alternatives: Array<{
    alternativeOrder: number;
    glossaryOrder: number;
    requiredBoldCodePoints: number;
    rowOrder: number;
  }>;
  contributions: GlossaryDefinitionContribution[];
  normalizedForm: string;
}

function fail(
  code: GlossaryCompileDiagnostic["code"],
  message: string,
): GlossaryCompileResult {
  return { diagnostic: { code, message }, ok: false };
}

function phraseTokens(
  markdown: string,
  replaceBoldHyphens = false,
): {
  hasBold: boolean;
  hasBoldHyphen: boolean;
  requiredBoldCodePoints: number;
  tokens: PhraseToken[];
} {
  const inline = parseGlossaryInline(markdown);
  const tokens: PhraseToken[] = [];
  let buffer = "";
  let bufferRequired = false;
  let requiredBoldCodePoints = 0;

  const flush = () => {
    if (!buffer) return;
    tokens.push({ required: bufferRequired, text: buffer });
    buffer = "";
    bufferRequired = false;
  };

  for (const piece of inline.pieces) {
    if (piece.required) {
      for (const char of piece.text) {
        if (!/\s/u.test(char)) requiredBoldCodePoints += 1;
      }
    }
    const matchText =
      replaceBoldHyphens && piece.required
        ? piece.text.replaceAll("-", " ")
        : piece.text;
    for (const char of matchText) {
      if (/\s/u.test(char)) {
        flush();
        continue;
      }
      buffer += char;
      bufferRequired ||= piece.required;
    }
  }
  flush();
  if (!inline.hasBold) {
    for (const token of tokens) token.required = true;
  }
  return {
    hasBold: inline.hasBold,
    hasBoldHyphen: inline.pieces.some(
      (piece) => piece.required && piece.text.includes("-"),
    ),
    requiredBoldCodePoints,
    tokens,
  };
}

function expandPhrase(
  markdown: string,
  limits: GlossaryLimits,
): ExpandedPhrase[] | GlossaryCompileDiagnostic {
  const canonicalLabel = flattenGlossaryInlineMarkdown(markdown);
  if (!canonicalLabel) {
    return { code: "empty-term", message: "Glossary term is empty" };
  }
  if (Array.from(canonicalLabel).length > limits.maxPhraseCodePoints) {
    return {
      code: "phrase-too-long",
      message: `Glossary phrase exceeds ${limits.maxPhraseCodePoints} code points`,
    };
  }

  const forms = new Map<string, ExpandedPhrase>();
  const parsed = phraseTokens(markdown);
  const parsedVariants = parsed.hasBoldHyphen
    ? [parsed, phraseTokens(markdown, true)]
    : [parsed];
  for (const parsedVariant of parsedVariants) {
    const optionalIndexes = parsedVariant.tokens
      .map((token, index) => (token.required ? -1 : index))
      .filter((index) => index >= 0);
    if (optionalIndexes.length > limits.maxOptionalTokens) {
      return {
        code: "too-many-optional-tokens",
        message: `Glossary phrase exceeds ${limits.maxOptionalTokens} optional tokens`,
      };
    }

    const variants = 1 << optionalIndexes.length;
    for (let mask = 0; mask < variants; mask += 1) {
      let optionalPosition = 0;
      const selected = parsedVariant.tokens.filter((token) => {
        if (token.required) return true;
        const include = (mask & (1 << optionalPosition)) !== 0;
        optionalPosition += 1;
        return include;
      });
      const form = normalizeGlossaryText(
        selected.map((token) => token.text).join(" "),
      );
      if (!form) continue;
      forms.set(form, {
        canonicalLabel,
        form,
        requiredBoldCodePoints: parsedVariant.hasBold
          ? parsedVariant.requiredBoldCodePoints
          : 0,
      });
    }
  }
  return [...forms.values()];
}

function comparePrecedence(
  left: WorkingTerminal["alternatives"][number],
  right: WorkingTerminal["alternatives"][number],
): number {
  return (
    right.requiredBoldCodePoints - left.requiredBoldCodePoints ||
    left.glossaryOrder - right.glossaryOrder ||
    left.rowOrder - right.rowOrder ||
    left.alternativeOrder - right.alternativeOrder
  );
}

function formatDefinitionText(
  contributions: readonly GlossaryDefinitionContribution[],
): string {
  return contributions
    .map(
      (contribution) =>
        `${contribution.canonicalLabel}: ${contribution.definition}`,
    )
    .join("\n\n");
}

function buildTrie(
  terminals: readonly GlossaryArtifactTerminal[],
  maxStates: number,
): GlossaryArtifactNode[] | GlossaryCompileDiagnostic {
  const nodes: GlossaryArtifactNode[] = [
    { failure: 0, outputs: [], transitions: {} },
  ];
  for (
    let terminalIndex = 0;
    terminalIndex < terminals.length;
    terminalIndex += 1
  ) {
    const terminal = terminals[terminalIndex];
    if (!terminal) continue;
    let state = 0;
    for (const char of terminal.normalizedForm) {
      const existing = nodes[state]?.transitions[char];
      if (existing !== undefined) {
        state = existing;
        continue;
      }
      if (nodes.length >= maxStates) {
        return {
          code: "too-many-trie-states",
          message: `Glossary matcher exceeds ${maxStates} trie states`,
        };
      }
      const nextState = nodes.length;
      nodes.push({ failure: 0, outputs: [], transitions: {} });
      nodes[state]!.transitions[char] = nextState;
      state = nextState;
    }
    nodes[state]?.outputs.push(terminalIndex);
  }

  const queue: number[] = [];
  for (const child of Object.values(nodes[0]?.transitions ?? {})) {
    queue.push(child);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    const node = state === undefined ? undefined : nodes[state];
    if (!node) continue;
    for (const [char, child] of Object.entries(node.transitions)) {
      queue.push(child);
      let failure = node.failure;
      while (failure !== 0 && nodes[failure]?.transitions[char] === undefined) {
        failure = nodes[failure]?.failure ?? 0;
      }
      const fallback = nodes[failure]?.transitions[char];
      nodes[child]!.failure =
        fallback !== undefined && fallback !== child ? fallback : 0;
      const inherited = nodes[nodes[child]!.failure]?.outputs ?? [];
      if (inherited.length > 0) {
        nodes[child]!.outputs = [...nodes[child]!.outputs, ...inherited];
      }
    }
  }
  return nodes;
}

export function compileGlossaryArtifact(
  rows: readonly GlossaryRowInput[],
  sourceVersion: string,
  limits: GlossaryLimits = GLOSSARY_LIMITS,
): GlossaryCompileResult {
  if (rows.length > limits.maxRows) {
    return fail(
      "too-many-rows",
      `Glossary graph exceeds ${limits.maxRows} rows`,
    );
  }

  const working = new Map<string, WorkingTerminal>();
  let alternativeCount = 0;
  let expandedFormCount = 0;

  for (const row of rows) {
    const definition = flattenGlossaryInlineMarkdown(row.definitionMarkdown);
    const alternatives = splitGlossaryAlternatives(row.termMarkdown);
    alternativeCount += alternatives.length;
    if (alternativeCount > limits.maxAlternatives) {
      return fail(
        "too-many-alternatives",
        `Glossary graph exceeds ${limits.maxAlternatives} alternatives`,
      );
    }
    for (
      let alternativeOrder = 0;
      alternativeOrder < alternatives.length;
      alternativeOrder += 1
    ) {
      const alternative = alternatives[alternativeOrder] ?? "";
      const expanded = expandPhrase(alternative, limits);
      if (!Array.isArray(expanded)) return { diagnostic: expanded, ok: false };
      expandedFormCount += expanded.length;
      if (expandedFormCount > limits.maxExpandedForms) {
        return fail(
          "too-many-expanded-forms",
          `Glossary graph exceeds ${limits.maxExpandedForms} expanded forms`,
        );
      }
      for (const phrase of expanded) {
        let terminal = working.get(phrase.form);
        if (!terminal) {
          terminal = {
            alternatives: [],
            contributions: [],
            normalizedForm: phrase.form,
          };
          working.set(phrase.form, terminal);
        }
        terminal.alternatives.push({
          alternativeOrder,
          glossaryOrder: row.glossaryOrder,
          requiredBoldCodePoints: phrase.requiredBoldCodePoints,
          rowOrder: row.rowOrder,
        });
        const contributionKey = `${row.glossaryOrder}\0${row.rowOrder}`;
        const alreadyContributes = terminal.contributions.some(
          (contribution) =>
            `${contribution.glossaryOrder}\0${contribution.rowOrder}` ===
            contributionKey,
        );
        if (!alreadyContributes) {
          terminal.contributions.push({
            alternativeOrder,
            canonicalLabel: phrase.canonicalLabel,
            definition,
            glossaryDirectory: row.glossaryDirectory,
            glossaryOrder: row.glossaryOrder,
            rowOrder: row.rowOrder,
          });
        }
      }
    }
  }

  const terminals: GlossaryArtifactTerminal[] = [];
  for (const terminal of working.values()) {
    terminal.contributions.sort(
      (left, right) =>
        left.glossaryOrder - right.glossaryOrder ||
        left.rowOrder - right.rowOrder ||
        left.alternativeOrder - right.alternativeOrder,
    );
    if (terminal.contributions.length > limits.maxDefinitionParagraphsPerForm) {
      return fail(
        "too-many-definition-paragraphs",
        `Glossary form exceeds ${limits.maxDefinitionParagraphsPerForm} definition paragraphs`,
      );
    }
    terminal.alternatives.sort(comparePrecedence);
    const precedence = terminal.alternatives[0];
    if (!precedence) continue;
    terminals.push({
      alternativeOrder: precedence.alternativeOrder,
      codePointLength: Array.from(terminal.normalizedForm).length,
      contributions: terminal.contributions,
      definitionText: formatDefinitionText(terminal.contributions),
      glossaryOrder: precedence.glossaryOrder,
      normalizedForm: terminal.normalizedForm,
      requiredBoldCodePoints: precedence.requiredBoldCodePoints,
      rowOrder: precedence.rowOrder,
    });
  }
  terminals.sort((left, right) =>
    left.normalizedForm.localeCompare(right.normalizedForm),
  );
  const nodes = buildTrie(terminals, limits.maxTrieStates);
  if (!Array.isArray(nodes)) return { diagnostic: nodes, ok: false };

  return {
    artifact: {
      nodes,
      sourceVersion,
      terminals,
      version: GLOSSARY_ARTIFACT_VERSION,
    },
    ok: true,
  };
}
