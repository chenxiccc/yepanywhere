/** Extensions whose source can use YA's safe rendered-Markdown view. */
export const MARKDOWN_LIKE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "markdown",
  "md",
  "mdown",
  "mdx",
  "mkd",
  "mkdn",
  "qmd",
]);

function fileExtension(filePath: string): string {
  const normalized = filePath.split(/[?#]/, 1)[0] ?? "";
  const fileName = normalized.split(/[\\/]/).pop() ?? normalized;
  return fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

export function isMarkdownLikeFile(filePath: string | undefined): boolean {
  return filePath
    ? MARKDOWN_LIKE_FILE_EXTENSIONS.has(fileExtension(filePath))
    : false;
}

export function isQuartoMarkdownFile(filePath: string | undefined): boolean {
  return filePath ? fileExtension(filePath) === "qmd" : false;
}
