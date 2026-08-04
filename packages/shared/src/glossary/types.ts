export const GLOSSARY_ARTIFACT_VERSION = 1 as const;

export const GLOSSARY_LIMITS = {
  maxIncludeDepth: 16,
  maxIncludedFiles: 128,
  maxGlossaryBytes: 2 * 1024 * 1024,
  maxRows: 4_096,
  maxAlternatives: 8_192,
  maxPhraseCodePoints: 256,
  maxOptionalTokens: 2,
  maxExpandedForms: 16_384,
  maxDefinitionParagraphsPerForm: 32,
  maxTrieStates: 65_536,
} as const;

export interface GlossaryLimits {
  maxAlternatives: number;
  maxDefinitionParagraphsPerForm: number;
  maxExpandedForms: number;
  maxGlossaryBytes: number;
  maxIncludeDepth: number;
  maxIncludedFiles: number;
  maxOptionalTokens: number;
  maxPhraseCodePoints: number;
  maxRows: number;
  maxTrieStates: number;
}

export interface GlossaryRowInput {
  definitionMarkdown: string;
  glossaryDirectory: string;
  glossaryOrder: number;
  rowOrder: number;
  termMarkdown: string;
}

export interface ParsedGlossaryRow {
  cellsMarkdown: string[];
  definitionMarkdown: string;
  rowOrder: number;
  sourceLine: number;
  termMarkdown: string;
}

export interface ParsedGlossaryTable {
  rows: ParsedGlossaryRow[];
  startLine: number;
}

export interface GlossaryDefinitionContribution {
  canonicalLabel: string;
  definition: string;
  glossaryDirectory: string;
  glossaryOrder: number;
  rowOrder: number;
  alternativeOrder: number;
}

export interface GlossaryArtifactTerminal {
  codePointLength: number;
  definitionText: string;
  normalizedForm: string;
  requiredBoldCodePoints: number;
  glossaryOrder: number;
  rowOrder: number;
  alternativeOrder: number;
  contributions: GlossaryDefinitionContribution[];
}

export interface GlossaryArtifactNode {
  failure: number;
  outputs: number[];
  transitions: Record<string, number>;
}

export interface GlossaryArtifact {
  version: typeof GLOSSARY_ARTIFACT_VERSION;
  sourceVersion: string;
  nodes: GlossaryArtifactNode[];
  terminals: GlossaryArtifactTerminal[];
}

export type GlossaryCompileDiagnosticCode =
  | "empty-term"
  | "too-many-alternatives"
  | "too-many-definition-paragraphs"
  | "too-many-expanded-forms"
  | "too-many-optional-tokens"
  | "too-many-rows"
  | "too-many-trie-states"
  | "phrase-too-long";

export interface GlossaryCompileDiagnostic {
  code: GlossaryCompileDiagnosticCode;
  message: string;
}

export type GlossaryCompileResult =
  | { artifact: GlossaryArtifact; ok: true }
  | { diagnostic: GlossaryCompileDiagnostic; ok: false };

export interface GlossaryMatch {
  definitionText: string;
  end: number;
  start: number;
  terminalIndex: number;
}
