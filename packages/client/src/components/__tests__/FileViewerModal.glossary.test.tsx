import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicShareProvider } from "../../contexts/PublicShareContext";
import { I18nProvider } from "../../i18n";
import type { FileViewerSource } from "../FileViewer";
import { FileViewerModal } from "../FilePathLink";

const boundaryCalls = vi.hoisted(() => [] as string[]);

vi.mock("../../contexts/GlossaryContext", () => ({
  GlossaryProjectBoundary: ({
    children,
    projectId,
  }: {
    children: ReactNode;
    projectId: string;
  }) => {
    boundaryCalls.push(projectId);
    return children;
  },
}));

const source: FileViewerSource = {
  loadFile: () => new Promise<never>(() => {}),
};

describe("FileViewerModal glossary context", () => {
  afterEach(() => {
    boundaryCalls.length = 0;
  });

  it("uses the viewed file's project for authenticated glossary hints", () => {
    render(
      <I18nProvider>
        <FileViewerModal
          projectId="target-project"
          filePath="paper/handout.md"
          source={source}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(boundaryCalls.length).toBeGreaterThan(0);
    expect(new Set(boundaryCalls)).toEqual(new Set(["target-project"]));
  });

  it("does not grant glossary access to public-share file modals", () => {
    render(
      <I18nProvider>
        <PublicShareProvider
          value={{
            projectId: "shared-project",
            relayUrl: "wss://relay.example/ws",
            relayUsername: "shared-host",
            secret: "share-secret",
          }}
        >
          <FileViewerModal
            projectId="shared-project"
            filePath="paper/handout.md"
            source={source}
            onClose={() => {}}
          />
        </PublicShareProvider>
      </I18nProvider>,
    );

    expect(boundaryCalls).toEqual([]);
  });
});
