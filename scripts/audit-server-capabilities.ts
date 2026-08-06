import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_CAPABILITIES,
  type ServerCapabilityDefinition,
} from "../packages/shared/src/server-capabilities.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RUNTIME_SOURCE_ROOTS = [
  "packages/client/src",
  "packages/server/src",
] as const;
const ROUTE_DECLARATION =
  /\broutes\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

interface AuditFinding {
  kind: "error" | "warning";
  message: string;
}

interface RouteSignature {
  method: string;
  path: string;
}

const capabilities = Object.values(
  SERVER_CAPABILITIES,
) as ServerCapabilityDefinition[];
const findings: AuditFinding[] = [];

await auditOwnedRouteModules();
await auditRawCapabilityChecks();
auditTransitionalReviewDates();

const errors = findings.filter((finding) => finding.kind === "error");
const warnings = findings.filter((finding) => finding.kind === "warning");

for (const finding of findings) {
  const prefix = finding.kind === "error" ? "ERROR" : "WARN";
  console.log(`${prefix}: ${finding.message}`);
}

console.log(
  `Capability audit: ${capabilities.length} registered, ` +
    `${errors.length} error(s), ${warnings.length} warning(s).`,
);

if (errors.length > 0) {
  process.exitCode = 1;
}

async function auditOwnedRouteModules(): Promise<void> {
  for (const capability of capabilities) {
    const routeModules = capability.serverContract?.routeModules ?? [];
    if (routeModules.length === 0) continue;

    const advertised = (capability.serverContract?.routes ?? []).map(
      parseAdvertisedRoute,
    );
    const declared: RouteSignature[] = [];

    for (const modulePath of routeModules) {
      const absolutePath = path.join(REPO_ROOT, modulePath);
      let source: string;
      try {
        source = await readFile(absolutePath, "utf8");
      } catch (error) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} route module is unreadable: ${modulePath} ` +
            `(${String(error)})`,
        });
        continue;
      }

      for (const match of source.matchAll(ROUTE_DECLARATION)) {
        declared.push({
          method: match[1]?.toUpperCase() ?? "",
          path: match[2] ?? "",
        });
      }
    }

    for (const route of declared) {
      if (!advertised.some((entry) => routeMatches(entry, route))) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} owns ${route.method} ${route.path} but ` +
            "serverContract.routes does not advertise it.",
        });
      }
    }

    for (const route of advertised) {
      if (!declared.some((entry) => routeMatches(route, entry))) {
        findings.push({
          kind: "error",
          message:
            `${capability.name} advertises ${route.method} ${route.path}, ` +
            "but no owned route module declares it.",
        });
      }
    }
  }
}

async function auditRawCapabilityChecks(): Promise<void> {
  const capabilityNames = capabilities.map((capability) => capability.name);
  for (const root of RUNTIME_SOURCE_ROOTS) {
    const files = await collectRuntimeFiles(path.join(REPO_ROOT, root));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const name of capabilityNames) {
        const quoted = `["'\`]${escapeRegExp(name)}["'\`]`;
        const rawCheck = new RegExp(
          String.raw`(?:\.includes\s*\(\s*${quoted}|serverHasCapability\s*\([^)]*${quoted}|capabilities\.push\s*\(\s*${quoted})`,
          "s",
        );
        if (rawCheck.test(source)) {
          findings.push({
            kind: "error",
            message:
              `${path.relative(REPO_ROOT, file)} checks raw capability ` +
              `"${name}"; import its registry constant/helper instead.`,
          });
        }
      }
    }
  }
}

function auditTransitionalReviewDates(): void {
  const today = new Date();
  for (const capability of capabilities) {
    if (capability.lifecycle.kind !== "transitional") continue;
    const reviewAfter = new Date(
      `${capability.lifecycle.reviewAfter}T00:00:00Z`,
    );
    if (Number.isNaN(reviewAfter.getTime())) {
      findings.push({
        kind: "error",
        message: `${capability.name} has invalid reviewAfter ${capability.lifecycle.reviewAfter}.`,
      });
    } else if (reviewAfter <= today) {
      findings.push({
        kind: "warning",
        message:
          `${capability.name} transitional review is due ` +
          `(${capability.lifecycle.reviewAfter}).`,
      });
    }
  }
}

function parseAdvertisedRoute(value: string): RouteSignature {
  const separator = value.indexOf(" ");
  if (separator < 1) {
    return { method: "", path: value };
  }
  return {
    method: value.slice(0, separator).toUpperCase(),
    path: value.slice(separator + 1),
  };
}

function routeMatches(
  advertised: RouteSignature,
  declared: RouteSignature,
): boolean {
  return (
    advertised.method === declared.method &&
    advertised.path.endsWith(declared.path)
  );
}

async function collectRuntimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
      files.push(...(await collectRuntimeFiles(entryPath)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
