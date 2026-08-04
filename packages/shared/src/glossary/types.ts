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

export type GlossaryResolutionDiagnosticCode =
  | "escaped-include"
  | "include-depth-limit"
  | "included-file-limit"
  | "invalid-governing-glossary"
  | "total-byte-limit"
  | "unresolved-include";

export interface GlossaryResolutionDiagnostic {
  code: GlossaryResolutionDiagnosticCode;
  glossaryPath: string;
  message: string;
}

export interface GlossaryDependencyIdentity {
  contentHash: string;
  path: string;
  size: number;
}

export type GlossaryPathChangeType = "create" | "modify" | "delete";

/** Process-local identity for one project's current glossary-path snapshot. */
export interface GlossaryProjectGeneration {
  epoch: string;
  sequence: number;
}

export interface GlossaryPathsSnapshotEvent {
  type: "glossary-paths-snapshot";
  generation: GlossaryProjectGeneration;
  paths: string[];
  timestamp: string;
}

export interface GlossaryPathChangedEvent {
  type: "glossary-path-changed";
  changeType: GlossaryPathChangeType;
  generation: GlossaryProjectGeneration;
  path: string;
  timestamp: string;
}

export type GlossarySubscriptionEvent =
  | GlossaryPathsSnapshotEvent
  | GlossaryPathChangedEvent;

export type GlossaryArtifactResponse =
  | {
      reason:
        | "governing-glossary-is-source"
        | "invalid-source-path"
        | "no-governing-glossary";
      status: "none";
    }
  | {
      artifact: GlossaryArtifact;
      dependencies: GlossaryDependencyIdentity[];
      diagnostics: GlossaryResolutionDiagnostic[];
      governingPath: string;
      sourceVersion: string;
      status: "ready";
    }
  | {
      dependencies: GlossaryDependencyIdentity[];
      diagnostic: GlossaryCompileDiagnostic | GlossaryResolutionDiagnostic;
      diagnostics: GlossaryResolutionDiagnostic[];
      governingPath: string;
      sourceVersion: string | null;
      status: "disabled";
    };

export interface GlossaryMatch {
  definitionText: string;
  end: number;
  start: number;
  terminalIndex: number;
}
