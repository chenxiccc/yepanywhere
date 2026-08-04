export { compileGlossaryArtifact, normalizeGlossaryText } from "./compiler.js";
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
  type GlossaryDefinitionContribution,
  type GlossaryLimits,
  type GlossaryMatch,
  type GlossaryRowInput,
  type ParsedGlossaryRow,
  type ParsedGlossaryTable,
} from "./types.js";
