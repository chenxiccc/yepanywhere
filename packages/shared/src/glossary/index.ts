export { compileGlossaryArtifact } from "./compiler.js";
export {
  normalizeGlossaryCaseText,
  normalizeGlossaryText,
} from "./normalization.js";
export {
  flattenGlossaryInlineMarkdown,
  parseFirstGlossaryTable,
  parseGlossaryInline,
  splitGlossaryAlternatives,
} from "./markdown.js";
export { matchGlossaryText } from "./matcher.js";
export {
  GLOSSARY_ARTIFACT_VERSION,
  GLOSSARY_LIMITS,
  type GlossaryArtifact,
  type GlossaryArtifactNode,
  type GlossaryArtifactTerminal,
  type GlossaryCompileDiagnostic,
  type GlossaryCompileDiagnosticCode,
  type GlossaryCompileResult,
  type GlossaryArtifactResponse,
  type GlossaryDependencyIdentity,
  type GlossaryDefinitionContribution,
  type GlossaryLimits,
  type GlossaryMatch,
  type GlossaryPathChangedEvent,
  type GlossaryPathChangeType,
  type GlossaryPathsSnapshotEvent,
  type GlossaryProjectGeneration,
  type GlossaryResolutionDiagnostic,
  type GlossaryResolutionDiagnosticCode,
  type GlossaryRowInput,
  type GlossarySubscriptionEvent,
  type ParsedGlossaryRow,
  type ParsedGlossaryTable,
} from "./types.js";
