import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(siteRoot, "dist");
const remoteEntry = join(siteRoot, "..", "packages", "client", "remote.html");
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(directory, entry.name)) : join(directory, entry.name),
    ),
  );
  return files.flat();
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function publicPath(file) {
  const outputPath = relative(distRoot, file).split(sep).join("/");
  if (outputPath === "index.html") return "/";
  if (outputPath.endsWith("/index.html")) return `/${outputPath.slice(0, -10)}`;
  return `/${outputPath.replace(/\.html$/, "")}`;
}

async function resolvesToBuildFile(pathname) {
  const normalized = pathname.replace(/^\/+|\/+$/g, "");
  if (!normalized) return exists(join(distRoot, "index.html"));
  if (pathname.endsWith("/")) return exists(join(distRoot, normalized, "index.html"));
  return (
    (await exists(join(distRoot, normalized))) ||
    (await exists(join(distRoot, `${normalized}.html`))) ||
    (await exists(join(distRoot, normalized, "index.html")))
  );
}

const htmlFiles = (await walk(distRoot)).filter((file) => file.endsWith(".html"));
const astroPages = htmlFiles.filter((file) => !file.endsWith(`${sep}open${sep}index.html`));

for (const file of astroPages) {
  const html = await readFile(file, "utf8");
  const route = publicPath(file);

  if (!/<link rel="canonical" href="https:\/\/yepanywhere\.com\//.test(html)) {
    failures.push(`${route}: missing canonical URL`);
  }
  if (!html.includes("static.cloudflareinsights.com/beacon.min.js")) {
    failures.push(`${route}: missing Cloudflare Web Analytics beacon`);
  }

  const hrefs = [...html.matchAll(/\shref=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const href of hrefs) {
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const url = new URL(href, "https://yepanywhere.com");
    if (url.pathname === "/remote" || url.pathname.startsWith("/remote/")) continue;
    if (!(await resolvesToBuildFile(url.pathname))) {
      failures.push(`${route}: internal link ${href} has no built destination`);
    }
  }
}

for (const requiredRoute of [
  "/features",
  "/docs",
  "/docs/getting-started",
  "/docs/desktop-apps",
  "/privacy",
]) {
  if (!(await resolvesToBuildFile(requiredRoute))) {
    failures.push(`${requiredRoute}: required public route was not built`);
  }
}

const remoteHtml = await readFile(remoteEntry, "utf8");
if (/cloudflareinsights|data-cf-beacon|beacon\.min\.js/i.test(remoteHtml)) {
  failures.push("/remote/: marketing analytics beacon must not be present");
}

const privacyHtml = await readFile(join(distRoot, "privacy.html"), "utf8");
if (!privacyHtml.includes("Cloudflare Web Analytics") || !privacyHtml.includes("/remote/")) {
  failures.push("/privacy: analytics inclusion and /remote/ exclusion must be disclosed");
}

if (failures.length > 0) {
  console.error("Built-site validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${astroPages.length} public pages, internal links, metadata, and analytics boundaries.`);
}
