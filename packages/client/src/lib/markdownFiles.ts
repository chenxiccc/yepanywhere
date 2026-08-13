const MARKDOWN_EXTENSIONS = new Set([
  "markdown",
  "md",
  "mdown",
  "mdx",
  "mkd",
  "mkdn",
  "qmd",
]);

export function isMarkdownLikeFile(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.split(/[?#]/, 1)[0] ?? "";
  const fileName = normalized.split(/[\\/]/).pop() ?? normalized;
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return MARKDOWN_EXTENSIONS.has(ext);
}
