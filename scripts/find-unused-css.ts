#!/usr/bin/env npx tsx
/**
 * Find and optionally remove unused CSS class selectors.
 *
 * Two analyses run side by side, because the two kinds of stylesheet have
 * different namespaces (see topics/css-architecture.md):
 *
 * - Global stylesheets share one document-wide class namespace, so a class is
 *   used when any source file mentions it as a string.
 * - `*.module.css` selectors are scoped per file and reached only through the
 *   binding an importer gives them (`styles.foo`, `styles["foo"]`), so usage is
 *   resolved per module rather than by name. Two modules may both define
 *   `.error` without being the same class, and a module `.container` is not
 *   used merely because the word "container" appears somewhere in the client.
 *
 * Usage:
 *   npx tsx scripts/find-unused-css.ts [options]
 *   pnpm css:unused
 *
 * Options:
 *   --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
 *   --src-dir <dir>  Directory to scan for source files (default: packages/client/src)
 *   --verbose        Show which files each class was found in
 *   --json           Output as JSON
 *   --remove         Remove unused global CSS rules (writes changes to files)
 *   --dry-run        Show what would be removed without making changes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface Options {
  cssDir: string;
  srcDir: string;
  verbose: boolean;
  json: boolean;
  remove: boolean;
  dryRun: boolean;
}

export interface ClassInfo {
  name: string;
  cssFile: string;
  line: number;
  usedIn: string[];
}

/** Why a module's selectors cannot be judged unused. */
export type ModuleUnknownReason =
  | "no-importer"
  | "side-effect-import"
  | "computed-access";

export interface ModuleReport {
  cssFile: string;
  /** Source files importing this module. */
  importers: string[];
  /** Other modules reaching this one through `composes ... from`. */
  composers: string[];
  selectors: ClassInfo[];
  unused: ClassInfo[];
  /** Global class names this module references through `:global(...)`. */
  globalRefs: string[];
  /**
   * Set when usage cannot be determined statically. Selectors are then
   * reported as unknown rather than unused.
   */
  unknownReasons: ModuleUnknownReason[];
}

export interface AnalysisResult {
  globalClasses: ClassInfo[];
  globalUsed: ClassInfo[];
  globalUnused: ClassInfo[];
  modules: ModuleReport[];
  moduleUnused: ClassInfo[];
  dynamicPrefixes: string[];
  cssFileCount: number;
  moduleFileCount: number;
  srcFileCount: number;
}

const USAGE = `
Find and optionally remove unused CSS class selectors.

Usage:
  npx tsx scripts/find-unused-css.ts [options]

Options:
  --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
  --src-dir <dir>  Directory to scan for source files (default: packages/client/src)
  --verbose        Show which files each class was found in
  --json           Output as JSON
  --remove         Remove unused global CSS rules (writes changes to files)
  --dry-run        Show what would be removed without making changes
  --help           Show this help

CSS Module rules are never removed automatically; module selectors are reported
so their owning component can delete them deliberately.
`;

export function parseArgs(argv: string[] = process.argv.slice(2)): Options {
  const options: Options = {
    cssDir: "packages/client/src",
    srcDir: "packages/client/src",
    verbose: false,
    json: false,
    remove: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--css-dir":
        options.cssDir = argv[++i];
        break;
      case "--src-dir":
        options.srcDir = argv[++i];
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--remove":
        options.remove = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
    }
  }

  return options;
}

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

export function isModuleStylesheet(file: string): boolean {
  return file.endsWith(".module.css");
}

function escapeRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Match class selectors like .foo, .foo-bar, .foo_bar. */
const CLASS_REGEX = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;

function isLikelySelectorLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
  // Declarations (`color: red;`) carry a colon without a brace; selectors with
  // pseudo-classes keep their brace or trailing comma.
  if (line.includes(":") && !line.includes("{") && !line.includes(","))
    return false;
  return true;
}

function isLikelyClassName(name: string): boolean {
  if (name.match(/^[0-9]/)) return false; // .5em etc
  if (name.length < 2) return false; // Single char classes
  return true;
}

export function extractClassSelectors(
  cssContent: string,
  filename: string,
): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const lines = cssContent.split("\n");
  const seen = new Set<string>();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!isLikelySelectorLine(line)) continue;

    for (const match of line.matchAll(CLASS_REGEX)) {
      const className = match[1];
      if (!isLikelyClassName(className)) continue;
      if (seen.has(className)) continue;
      seen.add(className);
      classes.push({
        name: className,
        cssFile: filename,
        line: lineNum + 1,
        usedIn: [],
      });
    }
  }

  return classes;
}

/**
 * Split a module line into its module-scoped part and the class names it
 * references through `:global(...)`.
 *
 * `:global(.modal):has(.content)` declares nothing global; it reaches an
 * existing global class from inside the module. The global names are returned
 * as references so the global analysis counts them as used, and are removed
 * from the line so they are not mistaken for module-owned selectors.
 */
export function splitGlobalReferences(line: string): {
  scoped: string;
  globalRefs: string[];
} {
  const globalRefs: string[] = [];
  let scoped = "";
  let index = 0;

  while (index < line.length) {
    const start = line.indexOf(":global(", index);
    if (start === -1) {
      scoped += line.slice(index);
      break;
    }

    scoped += line.slice(index, start);

    let depth = 0;
    let end = -1;
    for (let i = start + ":global".length; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) {
      // Unbalanced (selector continues on the next line); treat the remainder
      // as global so its classes are not claimed as module-owned.
      const rest = line.slice(start);
      for (const match of rest.matchAll(CLASS_REGEX)) {
        if (isLikelyClassName(match[1])) globalRefs.push(match[1]);
      }
      break;
    }

    const inner = line.slice(start + ":global(".length, end);
    for (const match of inner.matchAll(CLASS_REGEX)) {
      if (isLikelyClassName(match[1])) globalRefs.push(match[1]);
    }
    index = end + 1;
  }

  return { scoped, globalRefs };
}

export interface ComposesReference {
  /** Local class names this module composes from itself. */
  local: string[];
  /** Class names composed from another module, keyed by import specifier. */
  external: Array<{ specifier: string; names: string[] }>;
  /** Class names composed from the global namespace. */
  global: string[];
}

export function extractComposes(cssContent: string): ComposesReference {
  const result: ComposesReference = { local: [], external: [], global: [] };
  const composesRegex = /composes\s*:\s*([^;}]+)/g;

  for (const match of cssContent.matchAll(composesRegex)) {
    const value = match[1].trim();
    const fromMatch = /^([\s\S]+?)\s+from\s+(.+)$/.exec(value);

    if (!fromMatch) {
      result.local.push(...value.split(/\s+/).filter(Boolean));
      continue;
    }

    const names = fromMatch[1].split(/\s+/).filter(Boolean);
    const source = fromMatch[2].trim();
    if (source === "global") {
      result.global.push(...names);
      continue;
    }
    const specifier = source.replace(/^["']|["']$/g, "");
    result.external.push({ specifier, names });
  }

  return result;
}

/**
 * Extract module-scoped selectors from a `*.module.css` file, along with the
 * global class names it references.
 */
export function extractModuleSelectors(
  cssContent: string,
  filename: string,
): { selectors: ClassInfo[]; globalRefs: string[] } {
  const selectors: ClassInfo[] = [];
  const globalRefs = new Set<string>();
  const lines = cssContent.split("\n");
  const seen = new Set<string>();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const { scoped, globalRefs: lineGlobals } = splitGlobalReferences(line);
    for (const name of lineGlobals) globalRefs.add(name);

    if (!isLikelySelectorLine(line)) continue;

    for (const match of scoped.matchAll(CLASS_REGEX)) {
      const className = match[1];
      if (!isLikelyClassName(className)) continue;
      if (seen.has(className)) continue;
      seen.add(className);
      selectors.push({
        name: className,
        cssFile: filename,
        line: lineNum + 1,
        usedIn: [],
      });
    }
  }

  const composes = extractComposes(cssContent);
  for (const name of composes.global) globalRefs.add(name);

  return { selectors, globalRefs: Array.from(globalRefs) };
}

export interface ModuleImport {
  /** Local binding, or null for a side-effect import. */
  binding: string | null;
  specifier: string;
}

const MODULE_IMPORT_REGEX =
  /import\s+(?:(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+)?["']([^"']+\.module\.css)["']/g;

export function extractModuleImports(content: string): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const match of content.matchAll(MODULE_IMPORT_REGEX)) {
    imports.push({ binding: match[1] ?? null, specifier: match[2] });
  }
  return imports;
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export interface BindingUsage {
  names: Set<string>;
  /** The binding was used in a way that hides which selectors it reaches. */
  computed: boolean;
}

/**
 * Resolve which module selectors an importer reaches through its binding.
 *
 * Recognizes `styles.foo`, `styles?.foo`, and string-literal bracket access.
 * Any other use of the binding — a computed key, a spread, passing the object
 * to a helper — makes the module's usage unknown rather than unused.
 */
export function extractBindingUsage(
  content: string,
  binding: string,
): BindingUsage {
  const names = new Set<string>();
  let computed = false;

  const withoutImports = content.replace(MODULE_IMPORT_REGEX, " ");
  const scanned = stripComments(withoutImports);
  const occurrence = new RegExp(
    `(^|[^\\w$.])${escapeRegExp(binding)}(?![\\w$])`,
    "g",
  );

  for (const match of scanned.matchAll(occurrence)) {
    const rest = scanned.slice(match.index + match[0].length);

    const property = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (property) {
      names.add(property[1]);
      continue;
    }

    const literalKey = /^\s*(?:\?\.)?\[\s*(["'`])([^"'`]*)\1\s*\]/.exec(rest);
    if (literalKey) {
      names.add(literalKey[2]);
      continue;
    }

    computed = true;
  }

  return { names, computed };
}

/**
 * Extract dynamic class prefixes from template literals like `mode-${m}` or `status-${status}`.
 * Returns an array of prefixes found (e.g., ["mode-", "status-"]).
 */
export function extractDynamicPrefixes(
  srcFiles: Map<string, string>,
): string[] {
  const prefixes = new Set<string>();

  // Match patterns like: `prefix-${variable}`
  // Captures the prefix before ${...}
  const templateLiteralRegex = /`([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  // Match patterns like: `something ${prefix}-${var}` (space before prefix)
  const spacePrefixRegex = /\s([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  // Match patterns like: className={`something ${prefix}-${var}`}
  const nestedTemplateRegex = /\$\{[^}]*\}\s*([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  for (const content of srcFiles.values()) {
    for (const match of content.matchAll(templateLiteralRegex)) {
      prefixes.add(`${match[1]}-`);
    }
    for (const match of content.matchAll(spacePrefixRegex)) {
      prefixes.add(`${match[1]}-`);
    }
    for (const match of content.matchAll(nestedTemplateRegex)) {
      prefixes.add(`${match[1]}-`);
    }
  }

  return Array.from(prefixes);
}

/**
 * Check if a class name matches any dynamic prefix pattern.
 */
function matchesDynamicPrefix(className: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => className.startsWith(prefix));
}

function searchForClass(
  className: string,
  srcFiles: Map<string, string>,
  dynamicPrefixes: string[],
): string[] {
  const foundIn: string[] = [];

  // Check if this class matches a dynamic prefix pattern
  // e.g., "mode-default" matches prefix "mode-" from `mode-${m}`
  if (matchesDynamicPrefix(className, dynamicPrefixes)) {
    // Consider it "used" via dynamic construction
    return ["<dynamic>"];
  }

  // Patterns to search for:
  // - className="foo" or className={`... foo ...`}
  // - "foo" in ternary like isActive ? "foo" : ""
  // - classList.add("foo")
  // - class="foo" (HTML)

  const escaped = escapeRegExp(className);

  // Match the class name as a whole word in string contexts
  const patterns = [
    new RegExp(`["'\`]${escaped}["'\`]`, "g"), // Exact match in quotes
    new RegExp(`["'\`][^"'\`]*\\b${escaped}\\b[^"'\`]*["'\`]`, "g"), // Part of a string
    new RegExp(`\\b${escaped}\\b`, "g"), // Bare identifier (helper-built names)
  ];

  for (const [filename, content] of srcFiles) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        foundIn.push(filename);
        break;
      }
    }
  }

  return foundIn;
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  return path.resolve(path.dirname(fromFile), specifier);
}

export function analyze(options: Pick<Options, "cssDir" | "srcDir">): {
  result: AnalysisResult;
  srcContents: Map<string, string>;
} {
  const cssFiles = findFiles(options.cssDir, [".css"]);
  const moduleFiles = cssFiles.filter(isModuleStylesheet);
  const globalCssFiles = cssFiles.filter((file) => !isModuleStylesheet(file));

  const srcFiles = findFiles(options.srcDir, [".tsx", ".ts", ".jsx", ".js"]);
  const srcContents = new Map<string, string>();
  for (const file of srcFiles) {
    srcContents.set(file, fs.readFileSync(file, "utf-8"));
  }

  // --- Module analysis -----------------------------------------------------
  // Selectors are resolved per module file, so identically named classes in
  // different modules stay distinct.
  const moduleReports = new Map<string, ModuleReport>();
  const moduleContents = new Map<string, string>();
  for (const file of moduleFiles) {
    const content = fs.readFileSync(file, "utf-8");
    moduleContents.set(path.resolve(file), content);
    const { selectors, globalRefs } = extractModuleSelectors(content, file);
    moduleReports.set(path.resolve(file), {
      cssFile: file,
      importers: [],
      composers: [],
      selectors,
      unused: [],
      globalRefs,
      unknownReasons: [],
    });
  }

  // Names reached from source files, plus names composed from other modules.
  const reachedNames = new Map<string, Map<string, Set<string>>>();
  const noteReached = (
    modulePath: string,
    name: string,
    origin: string,
  ): void => {
    let byName = reachedNames.get(modulePath);
    if (!byName) {
      byName = new Map();
      reachedNames.set(modulePath, byName);
    }
    const origins = byName.get(name) ?? new Set<string>();
    origins.add(origin);
    byName.set(name, origins);
  };

  for (const [srcFile, content] of srcContents) {
    for (const { binding, specifier } of extractModuleImports(content)) {
      const resolved = resolveSpecifier(srcFile, specifier);
      const report = moduleReports.get(resolved);
      if (!report) continue;

      report.importers.push(srcFile);

      if (!binding) {
        report.unknownReasons.push("side-effect-import");
        continue;
      }

      const usage = extractBindingUsage(content, binding);
      if (usage.computed) report.unknownReasons.push("computed-access");
      for (const name of usage.names) noteReached(resolved, name, srcFile);
    }
  }

  for (const [modulePath, content] of moduleContents) {
    const composes = extractComposes(content);
    for (const name of composes.local) {
      noteReached(modulePath, name, `${path.basename(modulePath)} (composes)`);
    }
    for (const { specifier, names } of composes.external) {
      const resolved = resolveSpecifier(modulePath, specifier);
      const target = moduleReports.get(resolved);
      if (!target) continue;
      target.composers.push(path.relative(process.cwd(), modulePath));
      for (const name of names) {
        noteReached(
          resolved,
          name,
          `${path.basename(modulePath)} (composes from)`,
        );
      }
    }
  }

  const moduleUnused: ClassInfo[] = [];
  for (const [modulePath, report] of moduleReports) {
    // A module composed by another module is still reachable, so its
    // remaining selectors can be judged.
    if (report.importers.length === 0 && report.composers.length === 0) {
      report.unknownReasons.push("no-importer");
    }
    const byName = reachedNames.get(modulePath);
    for (const selector of report.selectors) {
      selector.usedIn = Array.from(byName?.get(selector.name) ?? []);
    }
    if (report.unknownReasons.length > 0) continue;
    report.unused = report.selectors.filter(
      (selector) => selector.usedIn.length === 0,
    );
    moduleUnused.push(...report.unused);
  }

  // --- Global analysis -----------------------------------------------------
  // Global stylesheets share one namespace, so classes stay deduplicated by
  // name across files, as before.
  const allGlobalClasses: ClassInfo[] = [];
  for (const cssFile of globalCssFiles) {
    const content = fs.readFileSync(cssFile, "utf-8");
    allGlobalClasses.push(...extractClassSelectors(content, cssFile));
  }

  const uniqueGlobalClasses = new Map<string, ClassInfo>();
  for (const cls of allGlobalClasses) {
    if (!uniqueGlobalClasses.has(cls.name)) {
      uniqueGlobalClasses.set(cls.name, cls);
    }
  }

  // A module's `:global(...)` selector is a real consumer of global vocabulary.
  const globalRefsFromModules = new Map<string, string[]>();
  for (const report of moduleReports.values()) {
    for (const name of report.globalRefs) {
      const files = globalRefsFromModules.get(name) ?? [];
      files.push(report.cssFile);
      globalRefsFromModules.set(name, files);
    }
  }

  const dynamicPrefixes = extractDynamicPrefixes(srcContents);
  const globalUsed: ClassInfo[] = [];
  const globalUnused: ClassInfo[] = [];

  for (const cls of uniqueGlobalClasses.values()) {
    cls.usedIn = [
      ...searchForClass(cls.name, srcContents, dynamicPrefixes),
      ...(globalRefsFromModules.get(cls.name) ?? []),
    ];
    if (cls.usedIn.length === 0) {
      globalUnused.push(cls);
    } else {
      globalUsed.push(cls);
    }
  }

  return {
    result: {
      globalClasses: Array.from(uniqueGlobalClasses.values()),
      globalUsed,
      globalUnused,
      modules: Array.from(moduleReports.values()).sort((a, b) =>
        a.cssFile.localeCompare(b.cssFile),
      ),
      moduleUnused,
      dynamicPrefixes,
      cssFileCount: globalCssFiles.length,
      moduleFileCount: moduleFiles.length,
      srcFileCount: srcFiles.length,
    },
    srcContents,
  };
}

interface CssRule {
  startLine: number; // 0-indexed
  endLine: number; // 0-indexed, inclusive
  selector: string;
  isPartOfGroup: boolean; // true if selector is comma-separated with others
}

/**
 * Find the CSS rule that contains the given class on the given line.
 * Returns the line range to delete, or null if it can't be safely removed.
 */
function findRuleForClass(
  lines: string[],
  _className: string,
  lineNum: number,
): CssRule | null {
  // lineNum is 1-indexed from ClassInfo, convert to 0-indexed
  const lineIdx = lineNum - 1;

  // Find the start of the selector (scan backwards for { or })
  let selectorStart = lineIdx;
  for (let i = lineIdx; i >= 0; i--) {
    if (lines[i].includes("{")) {
      // This line has the opening brace, selector starts here or before
      selectorStart = i;
      break;
    }
    if (lines[i].includes("}") && i !== lineIdx) {
      // Previous rule ends here, selector starts after
      selectorStart = i + 1;
      break;
    }
    selectorStart = i;
  }

  // Find the opening brace
  let braceLineIdx = -1;
  for (let i = selectorStart; i < lines.length; i++) {
    if (lines[i].includes("{")) {
      braceLineIdx = i;
      break;
    }
  }

  if (braceLineIdx === -1) return null;

  // Get the full selector text
  const selectorLines = lines.slice(selectorStart, braceLineIdx + 1);
  const selectorText = selectorLines.join("\n").replace(/\{.*$/, "").trim();

  // Check if it's a grouped selector (has commas at the top level)
  // Simple heuristic: if there's a comma not inside parens/brackets
  const isGrouped = /,(?![^(]*\))/.test(selectorText);

  if (isGrouped) {
    // Can't safely remove just one selector from a group
    return {
      startLine: selectorStart,
      endLine: braceLineIdx,
      selector: selectorText,
      isPartOfGroup: true,
    };
  }

  // Find the closing brace by counting braces
  let braceCount = 0;
  let ruleEndIdx = -1;

  for (let i = braceLineIdx; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === "{") braceCount++;
      if (char === "}") braceCount--;
    }
    if (braceCount === 0) {
      ruleEndIdx = i;
      break;
    }
  }

  if (ruleEndIdx === -1) return null;

  // Check for preceding comment (look for lines starting with /* or *)
  let commentStart = selectorStart;
  for (let i = selectorStart - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed === "") {
      commentStart = i;
    } else if (trimmed.endsWith("*/")) {
      // End of a previous comment, don't include
      break;
    } else {
      break;
    }
  }

  // Don't include standalone comments that aren't directly attached
  // (i.e., there's a blank line between comment and selector)
  if (commentStart < selectorStart) {
    let hasBlankBetween = false;
    for (let i = commentStart; i < selectorStart; i++) {
      if (lines[i].trim() === "") {
        hasBlankBetween = true;
        break;
      }
    }
    if (hasBlankBetween) {
      commentStart = selectorStart;
    }
  }

  return {
    startLine: commentStart,
    endLine: ruleEndIdx,
    selector: selectorText,
    isPartOfGroup: false,
  };
}

interface RemovalResult {
  file: string;
  removed: number;
  skipped: number;
  skippedClasses: string[];
}

/**
 * Remove unused CSS rules from files.
 *
 * Only global stylesheets are eligible. Module rules are left to their owning
 * component: the line-based parser cannot yet remove a complete module rule
 * (including `composes` dependents) safely.
 */
function removeUnusedRules(
  unusedByFile: Map<string, ClassInfo[]>,
  dryRun: boolean,
): RemovalResult[] {
  const results: RemovalResult[] = [];

  for (const [file, classes] of unusedByFile) {
    if (isModuleStylesheet(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");

    // Find all rules to remove, sorted by line number descending
    // (so we can remove from bottom to top without messing up line numbers)
    const rulesToRemove: CssRule[] = [];
    const skippedClasses: string[] = [];

    for (const cls of classes) {
      const rule = findRuleForClass(lines, cls.name, cls.line);
      if (rule && !rule.isPartOfGroup) {
        // Check if we already have a rule that overlaps
        const overlaps = rulesToRemove.some(
          (r) =>
            (rule.startLine >= r.startLine && rule.startLine <= r.endLine) ||
            (rule.endLine >= r.startLine && rule.endLine <= r.endLine),
        );
        if (!overlaps) {
          rulesToRemove.push(rule);
        }
      } else if (rule?.isPartOfGroup) {
        skippedClasses.push(cls.name);
      }
    }

    // Sort by startLine descending
    rulesToRemove.sort((a, b) => b.startLine - a.startLine);

    if (rulesToRemove.length === 0) {
      results.push({
        file,
        removed: 0,
        skipped: skippedClasses.length,
        skippedClasses,
      });
      continue;
    }

    // Remove rules from bottom to top
    for (const rule of rulesToRemove) {
      // Remove lines from startLine to endLine inclusive
      lines.splice(rule.startLine, rule.endLine - rule.startLine + 1);
    }

    // Clean up multiple consecutive blank lines
    const cleanedLines: string[] = [];
    let prevBlank = false;
    for (const line of lines) {
      const isBlank = line.trim() === "";
      if (isBlank && prevBlank) continue;
      cleanedLines.push(line);
      prevBlank = isBlank;
    }

    if (!dryRun) {
      fs.writeFileSync(file, cleanedLines.join("\n"));
    }

    results.push({
      file,
      removed: rulesToRemove.length,
      skipped: skippedClasses.length,
      skippedClasses,
    });
  }

  return results;
}

const UNKNOWN_REASON_TEXT: Record<ModuleUnknownReason, string> = {
  "no-importer": "no source file imports it",
  "side-effect-import": "imported for side effects without a binding",
  "computed-access": "reached through a computed key",
};

function describeUnknown(report: ModuleReport): string {
  return Array.from(new Set(report.unknownReasons))
    .map((reason) => UNKNOWN_REASON_TEXT[reason])
    .join("; ");
}

function main() {
  const options = parseArgs();

  let analysis: ReturnType<typeof analyze>;
  try {
    analysis = analyze(options);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const { result } = analysis;

  if (result.cssFileCount + result.moduleFileCount === 0) {
    console.error(`No CSS files found in: ${options.cssDir}`);
    process.exit(1);
  }
  if (result.srcFileCount === 0) {
    console.error(`No source files found in: ${options.srcDir}`);
    process.exit(1);
  }

  const unknownModules = result.modules.filter(
    (report) => report.unknownReasons.length > 0,
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          summary: {
            totalClasses: result.globalClasses.length,
            usedClasses: result.globalUsed.length,
            unusedClasses: result.globalUnused.length,
            cssFiles: result.cssFileCount,
            srcFiles: result.srcFileCount,
            moduleFiles: result.moduleFileCount,
            moduleSelectors: result.modules.reduce(
              (total, report) => total + report.selectors.length,
              0,
            ),
            unusedModuleSelectors: result.moduleUnused.length,
            unknownModules: unknownModules.length,
          },
          unused: result.globalUnused.map((c) => ({
            name: c.name,
            file: c.cssFile,
            line: c.line,
          })),
          modules: result.modules.map((report) => ({
            file: report.cssFile,
            importers: report.importers,
            unknownReasons: Array.from(new Set(report.unknownReasons)),
            globalRefs: report.globalRefs,
            unused: report.unused.map((c) => ({ name: c.name, line: c.line })),
            ...(options.verbose
              ? {
                  selectors: report.selectors.map((c) => ({
                    name: c.name,
                    line: c.line,
                    usedIn: c.usedIn,
                  })),
                }
              : {}),
          })),
          ...(options.verbose
            ? {
                used: result.globalUsed.map((c) => ({
                  name: c.name,
                  file: c.cssFile,
                  line: c.line,
                  usedIn: c.usedIn,
                })),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    process.exit(exitCode(result, options));
  }

  console.log(
    `Found ${result.globalClasses.length} unique global class selectors in ${result.cssFileCount} global stylesheets`,
  );
  console.log(
    `Found ${result.modules.reduce((total, r) => total + r.selectors.length, 0)} module selectors in ${result.moduleFileCount} CSS Modules`,
  );
  console.log(`Searching ${result.srcFileCount} source files...`);
  if (result.dynamicPrefixes.length > 0) {
    console.log(
      `Detected dynamic prefixes: ${result.dynamicPrefixes.join(", ")}`,
    );
  }
  console.log();

  // Group unused global classes by CSS file
  const byFile = new Map<string, ClassInfo[]>();
  for (const cls of result.globalUnused) {
    const existing = byFile.get(cls.cssFile) || [];
    existing.push(cls);
    byFile.set(cls.cssFile, existing);
  }

  if (result.globalUnused.length === 0) {
    console.log("No unused global classes found!");
  } else {
    console.log(
      `Found ${result.globalUnused.length} potentially unused global classes:\n`,
    );

    for (const [file, classes] of byFile) {
      const relPath = path.relative(process.cwd(), file);
      console.log(`${relPath} (${classes.length} unused):`);
      for (const cls of classes.sort((a, b) => a.line - b.line)) {
        console.log(`  Line ${cls.line}: .${cls.name}`);
      }
      console.log();
    }
  }

  console.log("CSS Modules:");
  if (result.moduleFileCount === 0) {
    console.log("  (none)");
  }
  for (const report of result.modules) {
    const relPath = path.relative(process.cwd(), report.cssFile);
    if (report.unknownReasons.length > 0) {
      console.log(`  ${relPath}: usage unknown — ${describeUnknown(report)}`);
      continue;
    }
    if (report.unused.length === 0) {
      if (options.verbose) {
        console.log(
          `  ${relPath}: all ${report.selectors.length} selectors used`,
        );
      }
      continue;
    }
    console.log(`  ${relPath} (${report.unused.length} unused):`);
    for (const cls of report.unused.sort((a, b) => a.line - b.line)) {
      console.log(`    Line ${cls.line}: .${cls.name}`);
    }
  }
  console.log();

  console.log("---");
  console.log(
    `Summary: ${result.globalUsed.length} used, ${result.globalUnused.length} unused out of ${result.globalClasses.length} global classes`,
  );
  console.log(
    `         ${result.moduleUnused.length} unused module selectors; ${unknownModules.length} module${unknownModules.length === 1 ? "" : "s"} with undetermined usage`,
  );

  if (options.verbose && result.globalUsed.length > 0) {
    console.log("\nUsed global classes:");
    for (const cls of result.globalUsed) {
      console.log(
        `  .${cls.name} -> ${cls.usedIn.map((f) => path.relative(process.cwd(), f)).join(", ")}`,
      );
    }
  }

  // Handle removal if requested
  if (
    (options.remove || options.dryRun) &&
    (result.globalUnused.length > 0 || result.moduleUnused.length > 0)
  ) {
    console.log(
      options.dryRun
        ? "\n[DRY RUN] Would remove:"
        : "\nRemoving unused rules...",
    );

    const results = removeUnusedRules(byFile, options.dryRun);

    let totalRemoved = 0;
    let totalSkipped = 0;

    for (const removal of results) {
      const relPath = path.relative(process.cwd(), removal.file);
      if (removal.removed > 0 || removal.skipped > 0) {
        console.log(
          `  ${relPath}: ${removal.removed} removed, ${removal.skipped} skipped`,
        );
        if (removal.skippedClasses.length > 0 && options.verbose) {
          console.log(
            `    Skipped (grouped selectors): ${removal.skippedClasses.join(", ")}`,
          );
        }
      }
      totalRemoved += removal.removed;
      totalSkipped += removal.skipped;
    }

    console.log(
      `\n${options.dryRun ? "Would remove" : "Removed"} ${totalRemoved} rules, skipped ${totalSkipped} (grouped selectors)`,
    );
    if (result.moduleUnused.length > 0) {
      console.log(
        `Left ${result.moduleUnused.length} module selector${result.moduleUnused.length === 1 ? "" : "s"} in place; delete module rules in the owning component.`,
      );
    }
  }

  process.exit(exitCode(result, options));
}

function exitCode(result: AnalysisResult, options: Options): number {
  const globalOutstanding = options.remove ? 0 : result.globalUnused.length;
  return globalOutstanding + result.moduleUnused.length > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
