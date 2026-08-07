import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GLOSSARY_LIMITS, compileGlossaryArtifact } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGlossaryIncludeMentions,
  GlossaryIndexService,
} from "../../src/projects/glossaryIndexService.js";
import { invalidateProjectPathIndex } from "../../src/projects/projectPathIndex.js";
import { readFileHandleBounded } from "../../src/utils/projectFileAccess.js";

const projects: string[] = [];

async function createProject(): Promise<string> {
  const project = await realpath(
    await mkdtemp(join(tmpdir(), "ya-glossary-index-")),
  );
  projects.push(project);
  return project;
}

async function writeProjectFile(
  project: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(project, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function readPathBounded(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await open(path, "r");
  try {
    return await readFileHandleBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

function glossary(
  rows: ReadonlyArray<
    readonly [term: string, definition: string, refs?: string]
  >,
): string {
  return [
    "| term | definition | references |",
    "| --- | --- | --- |",
    ...rows.map(
      ([term, definition, refs = ""]) =>
        `| ${term} | ${definition} | ${refs} |`,
    ),
    "",
  ].join("\n");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const project of projects.splice(0)) {
    invalidateProjectPathIndex(project);
    await rm(project, { recursive: true });
  }
});

describe("glossary include discovery", () => {
  it("finds exact GLOSSARY.md paths in authored source order", () => {
    const markdown = [
      "See [paper](papers/GLOSSARY.md),",
      "<docs/My Terms/GLOSSARY.md>,",
      "`../shared/GLOSSARY.md`, and /opt/terms/GLOSSARY.md.",
      "Ignore OTHERGLOSSARY.md and GLOSSARY.md.bak.",
    ].join(" ");

    expect(extractGlossaryIncludeMentions(markdown)).toEqual([
      "papers/GLOSSARY.md",
      "docs/My Terms/GLOSSARY.md",
      "../shared/GLOSSARY.md",
      "/opt/terms/GLOSSARY.md",
    ]);
  });
});

describe("governing glossary resolution", () => {
  it("builds a depth-first explicit union with concatenated conflicts", async () => {
    const project = await createProject();
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([["shared term", "Root meaning", "papers/GLOSSARY.md"]]),
    );
    await writeProjectFile(
      project,
      "papers/GLOSSARY.md",
      glossary([
        [
          "shared term",
          "Paper meaning",
          "../shared/GLOSSARY.md and ../GLOSSARY.md",
        ],
      ]),
    );
    await writeProjectFile(
      project,
      "shared/GLOSSARY.md",
      glossary([["shared term", "Shared meaning"]]),
    );

    const result = await new GlossaryIndexService().resolve(project);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.dependencies.map(({ path }) => path)).toEqual([
      "GLOSSARY.md",
      "papers/GLOSSARY.md",
      "shared/GLOSSARY.md",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.artifact.terminals.find(
        ({ normalizedForm }) => normalizedForm === "shared term",
      )?.definitionText,
    ).toBe(
      "shared term: Root meaning\n\n" +
        "shared term: Paper meaning\n\n" +
        "shared term: Shared meaning",
    );
  });

  it("uses the nearest glossary and never annotates a glossary itself", async () => {
    const project = await createProject();
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([["root term", "Root"]]),
    );
    await writeProjectFile(
      project,
      "papers/GLOSSARY.md",
      glossary([["paper term", "Paper"]]),
    );

    const service = new GlossaryIndexService();
    const rootResult = await service.resolve(project, "README.md");
    const paperResult = await service.resolve(project, "papers/notes/draft.md");

    expect(rootResult).toMatchObject({
      governingPath: "GLOSSARY.md",
      status: "ready",
    });
    expect(paperResult).toMatchObject({
      governingPath: "papers/GLOSSARY.md",
      status: "ready",
    });
    expect(service.getObservedGlossaryPaths(project)).toMatchObject([
      { identity: expect.any(Object), path: "GLOSSARY.md" },
      { identity: expect.any(Object), path: "papers/GLOSSARY.md" },
      { identity: null, path: "papers/notes/GLOSSARY.md" },
    ]);
    expect(await service.resolve(project, "papers/GLOSSARY.md")).toEqual({
      reason: "governing-glossary-is-source",
      status: "none",
    });
    expect(await service.resolve(project, "../outside.md")).toEqual({
      reason: "invalid-source-path",
      status: "none",
    });
    expect(await service.resolve(project, "papers/draft\0.md")).toEqual({
      reason: "invalid-source-path",
      status: "none",
    });
  });

  it("rejects lexical and symlink escapes from the project", async () => {
    const project = await createProject();
    const outside = await createProject();
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([
        ["safe term", "Safe", "../GLOSSARY.md and linked/GLOSSARY.md"],
      ]),
    );
    await writeProjectFile(
      outside,
      "GLOSSARY.md",
      glossary([["secret term", "Secret"]]),
    );
    await symlink(outside, join(project, "linked"), "dir");

    const result = await new GlossaryIndexService().resolve(project);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.dependencies.map(({ path }) => path)).toEqual([
      "GLOSSARY.md",
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "escaped-include",
      "unresolved-include",
    ]);
    expect(
      result.artifact.terminals.some(
        ({ normalizedForm }) => normalizedForm === "secret term",
      ),
    ).toBe(false);
  });
});

describe("glossary byte limits", () => {
  it("rejects an oversized sparse governing file before reading it", async () => {
    const project = await createProject();
    const glossaryPath = join(project, "GLOSSARY.md");
    await writeProjectFile(project, "GLOSSARY.md", "");
    await truncate(glossaryPath, 65);
    const read = vi.fn(async () => Buffer.alloc(0));
    const compile = vi.fn(compileGlossaryArtifact);
    const service = new GlossaryIndexService({
      compile,
      io: { readFileBounded: read },
      limits: { ...GLOSSARY_LIMITS, maxGlossaryBytes: 64 },
    });

    await expect(service.resolve(project)).resolves.toMatchObject({
      dependencies: [],
      diagnostic: {
        code: "total-byte-limit",
        glossaryPath: "GLOSSARY.md",
      },
      governingPath: "GLOSSARY.md",
      sourceVersion: null,
      status: "disabled",
    });
    expect(read).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it("stops a governing read that grows beyond its post-stat budget", async () => {
    const project = await createProject();
    const content = glossary([["growing term", "Meaning"]]);
    const maxGlossaryBytes = Buffer.byteLength(content);
    await writeProjectFile(project, "GLOSSARY.md", content);
    const read = vi.fn(async (path: string, maxBytes: number) => {
      await appendFile(path, "x");
      return readPathBounded(path, maxBytes);
    });
    const compile = vi.fn(compileGlossaryArtifact);
    const service = new GlossaryIndexService({
      compile,
      io: { readFileBounded: read },
      limits: { ...GLOSSARY_LIMITS, maxGlossaryBytes },
    });

    await expect(service.resolve(project)).resolves.toMatchObject({
      dependencies: [],
      diagnostic: {
        code: "total-byte-limit",
        glossaryPath: "GLOSSARY.md",
      },
      status: "disabled",
    });
    expect(read).toHaveBeenCalledWith(
      join(project, "GLOSSARY.md"),
      maxGlossaryBytes,
    );
    expect(compile).not.toHaveBeenCalled();
  });

  it("passes each include only the aggregate graph remainder", async () => {
    const project = await createProject();
    const governing = glossary([["root term", "Root", "nested/GLOSSARY.md"]]);
    const included = glossary([["nested term", "Nested"]]);
    const maxGlossaryBytes =
      Buffer.byteLength(governing) + Buffer.byteLength(included);
    await writeProjectFile(project, "GLOSSARY.md", governing);
    await writeProjectFile(project, "nested/GLOSSARY.md", included);
    const includedPath = join(project, "nested/GLOSSARY.md");
    const read = vi.fn(async (path: string, maxBytes: number) => {
      if (path === includedPath) await appendFile(path, "x");
      return readPathBounded(path, maxBytes);
    });
    const compile = vi.fn(compileGlossaryArtifact);
    const service = new GlossaryIndexService({
      compile,
      io: { readFileBounded: read },
      limits: { ...GLOSSARY_LIMITS, maxGlossaryBytes },
    });

    await expect(service.resolve(project)).resolves.toMatchObject({
      dependencies: [
        { path: "GLOSSARY.md", size: Buffer.byteLength(governing) },
      ],
      diagnostic: {
        code: "total-byte-limit",
        glossaryPath: "nested/GLOSSARY.md",
      },
      status: "disabled",
    });
    expect(read).toHaveBeenNthCalledWith(
      1,
      join(project, "GLOSSARY.md"),
      maxGlossaryBytes,
    );
    expect(read).toHaveBeenNthCalledWith(
      2,
      includedPath,
      Buffer.byteLength(included),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(compile).not.toHaveBeenCalled();
  });
});

describe("glossary process cache", () => {
  it("detects a same-size edit even when its mtime is restored", async () => {
    const project = await createProject();
    const path = join(project, "GLOSSARY.md");
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([["cache term", "First"]]),
    );
    const originalTimes = await stat(path);
    const compile = vi.fn(compileGlossaryArtifact);
    const service = new GlossaryIndexService({ compile });

    const first = await service.resolve(project);
    await writeFile(path, glossary([["cache term", "Other"]]));
    await utimes(path, originalTimes.atime, originalTimes.mtime);
    const second = await service.resolve(project);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(second.artifact.sourceVersion).not.toBe(
      first.artifact.sourceVersion,
    );
    expect(second.artifact.terminals[0]?.definitionText).toContain("Other");
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("reuses successful and bounded-failure compilations", async () => {
    const project = await createProject();
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([["cache term", "Meaning"]]),
    );
    const successfulCompile = vi.fn(compileGlossaryArtifact);
    const successful = new GlossaryIndexService({ compile: successfulCompile });

    expect((await successful.resolve(project)).status).toBe("ready");
    expect((await successful.resolve(project)).status).toBe("ready");
    expect(successfulCompile).toHaveBeenCalledTimes(1);

    const failedCompile = vi.fn(compileGlossaryArtifact);
    const failed = new GlossaryIndexService({
      compile: failedCompile,
      limits: { ...GLOSSARY_LIMITS, maxRows: 0 },
    });
    expect(await failed.resolve(project)).toMatchObject({
      diagnostic: { code: "too-many-rows" },
      status: "disabled",
    });
    expect(await failed.resolve(project)).toMatchObject({
      diagnostic: { code: "too-many-rows" },
      status: "disabled",
    });
    expect(failedCompile).toHaveBeenCalledTimes(1);
  });

  it("shares one unfinished resolution across canonical project aliases", async () => {
    const project = await createProject();
    const projectAlias = join(project, "project-alias");
    await writeProjectFile(
      project,
      "GLOSSARY.md",
      glossary([["flight term", "Meaning"]]),
    );
    await symlink(".", projectAlias, "dir");
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolveGate) => {
      releaseRead = resolveGate;
    });
    const read = vi.fn(async (path: string) => {
      await readGate;
      return readFile(path);
    });
    const service = new GlossaryIndexService({ io: { readFileBounded: read } });

    const first = service.resolve(project, "README.md");
    const second = service.resolve(project, "README.md");
    const aliased = service.resolve(projectAlias, "README.md");
    expect(second).toBe(first);
    releaseRead?.();

    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(aliased).resolves.toMatchObject({ status: "ready" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
