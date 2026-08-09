const SCRIPTLESS_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "style-src 'unsafe-inline'",
].join("; ");

/**
 * Put untrusted HTML after a client-owned CSP so iframe srcdoc previews cannot
 * inherit network or application authority from the trusted YA document.
 * The iframe itself must still use an empty sandbox.
 */
export function createScriptlessHtmlPreviewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SCRIPTLESS_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}
