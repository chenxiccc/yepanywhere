import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_INTRODUCED_IN,
} from "../packages/shared/src/capability-ids.js";
import {
  OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS,
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
auditCapabilityAdvertisements();
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

function auditCapabilityAdvertisements(): void {
  const idAllocations = Object.values(CAPABILITY_ID_ALLOCATIONS);
  const idAllocationsByName = new Map(
    idAllocations.map((allocation) => [allocation.name, allocation]),
  );
  const allocatedIds = new Map<number, string>();
  for (const allocation of idAllocations) {
    if (!Number.isInteger(allocation.id) || allocation.id < 0) {
      findings.push({
        kind: "error",
        message: `${allocation.name} has invalid capability ID ${allocation.id}.`,
      });
      continue;
    }
    const existing = allocatedIds.get(allocation.id);
    if (existing) {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} reuses capability ID ${allocation.id} ` +
          `already allocated to ${existing}.`,
      });
    } else {
      allocatedIds.set(allocation.id, allocation.name);
    }
  }
  const highestAllocatedId = Math.max(-1, ...allocatedIds.keys());
  for (let id = 0; id <= highestAllocatedId; id += 1) {
    if (!allocatedIds.has(id)) {
      findings.push({
        kind: "error",
        message:
          `Capability ID ${id} is missing from the permanent ledger; ` +
          "retired IDs must remain reserved.",
      });
    }
  }

  const allocations = Object.values(OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS);
  const allocationsByName = new Map(
    allocations.map((allocation) => [allocation.name, allocation]),
  );
  const capabilitiesByName = new Map(
    capabilities.map((capability) => [capability.name, capability]),
  );
  const allocatedIndices = new Map<number, string>();

  for (const capability of capabilities) {
    const allocation = idAllocationsByName.get(capability.name);
    const requiresId =
      capability.advertisement.kind !== "scoped" &&
      versionAtLeast(
        capability.introducedIn,
        CAPABILITY_ID_ENCODING_INTRODUCED_IN,
      );
    if (requiresId && capability.id === undefined) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} was introduced in ${capability.introducedIn} ` +
          "but has no durable capability ID.",
      });
    }
    if (capability.id === undefined) continue;
    if (allocation?.direction !== "server") {
      findings.push({
        kind: "error",
        message: `${capability.name} has ID ${capability.id} without a server allocation.`,
      });
      continue;
    }
    if (allocation.id !== capability.id) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} uses ID ${capability.id}, ` +
          `not allocated ID ${allocation.id}.`,
      });
    }
    if (allocation.introducedIn !== capability.introducedIn) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} ID allocation records ${allocation.introducedIn}, ` +
          `not introducedIn ${capability.introducedIn}.`,
      });
    }
  }

  for (const allocation of idAllocations) {
    if (allocation.direction !== "server") continue;
    if (!capabilitiesByName.has(allocation.name)) {
      findings.push({
        kind: "error",
        message: `${allocation.name} retains server capability ID ${allocation.id} without a registry entry.`,
      });
    }
  }

  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.index) || allocation.index < 0) {
      findings.push({
        kind: "error",
        message: `${allocation.name} has invalid optional bit index ${allocation.index}.`,
      });
      continue;
    }
    const existing = allocatedIndices.get(allocation.index);
    if (existing) {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} reuses optional bit ${allocation.index} ` +
          `already allocated to ${existing}.`,
      });
    } else {
      allocatedIndices.set(allocation.index, allocation.name);
    }

    const capability = capabilitiesByName.get(allocation.name);
    if (capability && capability.advertisement.kind !== "optional-bit") {
      findings.push({
        kind: "error",
        message:
          `${allocation.name} retains optional bit ${allocation.index} but ` +
          `is advertised as ${capability.advertisement.kind}.`,
      });
    }
  }

  for (const capability of capabilities) {
    if (capability.advertisement.kind !== "optional-bit") continue;
    const allocation = allocationsByName.get(capability.name);
    if (!allocation) {
      findings.push({
        kind: "error",
        message: `${capability.name} has no durable optional-bit allocation.`,
      });
      continue;
    }
    if (allocation.index !== capability.advertisement.index) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} uses optional bit ` +
          `${capability.advertisement.index}, not allocated bit ${allocation.index}.`,
      });
    }
    if (allocation.introducedIn !== capability.introducedIn) {
      findings.push({
        kind: "error",
        message:
          `${capability.name} allocation records ${allocation.introducedIn}, ` +
          `not introducedIn ${capability.introducedIn}.`,
      });
    }
  }
}

function versionAtLeast(candidate: string, baseline: string): boolean {
  const parse = (value: string): readonly [number, number, number] | null => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ];
  };
  const left = parse(candidate);
  const right = parse(baseline);
  if (!left || !right) return false;
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
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
