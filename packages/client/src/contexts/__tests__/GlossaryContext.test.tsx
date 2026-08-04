import type { GlossaryArtifactResponse } from "@yep-anywhere/shared";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { FakeSourceTransport } from "../../lib/transport";

const mocks = vi.hoisted(() => ({
  runtime: null as YaSourceRuntime | null,
}));

vi.mock("../../hooks/useGlossaryHints", () => ({
  useGlossaryHints: () => ({ glossaryHintsEnabled: true }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: ["glossary-tooltips"] },
  }),
}));

vi.mock("../SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => mocks.runtime,
}));

import {
  GlossaryProjectProvider,
  useGlossaryArtifact,
} from "../GlossaryContext";

const PROJECT_ID = toUrlProjectId("/projects/paper");

function readyResponse(): GlossaryArtifactResponse {
  return {
    artifact: {
      nodes: [{ failure: 0, outputs: [], transitions: {} }],
      sourceVersion: "root-v1",
      terminals: [],
      version: 1,
    },
    dependencies: [{ contentHash: "root-v1", path: "GLOSSARY.md", size: 12 }],
    diagnostics: [],
    governingPath: "GLOSSARY.md",
    sourceVersion: "root-v1",
    status: "ready",
  };
}

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    api: {} as YaSourceRuntime["api"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
    sourceKey: asClientSummarySourceKey("test:glossary-context"),
    summary: {} as YaSourceRuntime["summary"],
    transport,
  };
}

function SessionText({ sessionId }: { sessionId: string }) {
  const glossary = useGlossaryArtifact();
  return (
    <div>
      <span>{`session text ${sessionId}`}</span>
      <span data-testid="glossary-state">{glossary.state}</span>
    </div>
  );
}

describe("GlossaryProjectProvider", () => {
  afterEach(() => {
    cleanup();
    mocks.runtime = null;
  });

  it("renders cold session text and reuses one warm same-project artifact", async () => {
    let resolveArtifact!: (response: GlossaryArtifactResponse) => void;
    const pendingArtifact = new Promise<GlossaryArtifactResponse>((resolve) => {
      resolveArtifact = resolve;
    });
    const fetchMock = vi.fn();
    const fetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      return (await pendingArtifact) as T;
    };
    const transport = new FakeSourceTransport({ fetch });
    mocks.runtime = createRuntime(transport);

    const view = render(
      <GlossaryProjectProvider projectId={PROJECT_ID}>
        <GlossaryProjectProvider projectId={PROJECT_ID}>
          <SessionText key="session-1" sessionId="session-1" />
        </GlossaryProjectProvider>
      </GlossaryProjectProvider>,
    );

    expect(screen.getByText("session text session-1")).toBeDefined();
    expect(screen.getByTestId("glossary-state").textContent).toBe("loading");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.getSubscriptions("glossary")).toHaveLength(1);

    await act(async () => resolveArtifact(readyResponse()));
    await waitFor(() =>
      expect(screen.getByTestId("glossary-state").textContent).toBe("ready"),
    );

    view.rerender(
      <GlossaryProjectProvider projectId={PROJECT_ID}>
        <GlossaryProjectProvider projectId={PROJECT_ID}>
          <SessionText key="session-2" sessionId="session-2" />
        </GlossaryProjectProvider>
      </GlossaryProjectProvider>,
    );

    expect(screen.getByText("session text session-2")).toBeDefined();
    expect(screen.getByTestId("glossary-state").textContent).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.getSubscriptions("glossary")).toHaveLength(1);
  });
});
