// @vitest-environment jsdom

import { compileGlossaryArtifact } from "@yep-anywhere/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../i18n";
import { UserPromptLinkedTextContent } from "../UserPromptLinkedText";

function artifact() {
  const result = compileGlossaryArtifact(
    [
      {
        termMarkdown: "**user turn**",
        definitionMarkdown: "A human-authored request.",
        glossaryDirectory: "",
        glossaryOrder: 0,
        rowOrder: 0,
      },
      {
        termMarkdown: "**performance-regression-suite**",
        definitionMarkdown: "The performance regression suite.",
        glossaryDirectory: "",
        glossaryOrder: 0,
        rowOrder: 1,
      },
    ],
    "source-v1",
  );
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.artifact;
}

describe("UserPromptLinkedText", () => {
  afterEach(cleanup);

  it("keeps file and URL anchors whole while annotating glossary prose", () => {
    const path = "topics/performance-regression-suite.md";
    const { container } = render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <UserPromptLinkedTextContent
            artifact={artifact()}
            projectPathLinks={[{ filePath: path, text: path }]}
            text={`Read this user turn in ${path} and https://example.com/docs.`}
          />
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const fileLink = screen.getByRole("link", { name: path });
    expect(fileLink.getAttribute("href")).toContain(
      "path=topics%2Fperformance-regression-suite.md",
    );
    expect(fileLink.querySelector("[data-glossary-term]")).toBeNull();
    expect(
      screen.getByRole("link", { name: "https://example.com/docs" }),
    ).toBeDefined();

    const term = container.querySelector<HTMLElement>("[data-glossary-term]");
    expect(term?.textContent).toBe("user turn");
    expect(term?.title).toBe("user turn: A human-authored request.");
  });

  it("leaves an unconfirmed path as ordinary text", () => {
    render(
      <I18nProvider>
        <UserPromptLinkedTextContent
          artifact={artifact()}
          text="Read topics/commits.md"
        />
      </I18nProvider>,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/topics\/commits\.md/)).toBeDefined();
  });
});
