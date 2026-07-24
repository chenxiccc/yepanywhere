// @vitest-environment jsdom

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { BangCommandDisplayObject } from "../BangCommandDisplayObject";

const object: BangCommandTranscriptDisplayObject = {
  id: "bang-1",
  kind: "bang-command",
  createdAt: "2026-07-24T00:00:00.000Z",
  placementAfterMessageId: "",
  command: "git status",
  cwd: "/project",
  status: "done",
  exitCode: 0,
  stdoutPreview: "preview",
};

describe("BangCommandDisplayObject", () => {
  afterEach(cleanup);

  it("does not fetch full output until the user asks for it", async () => {
    const fetchOutput = vi.fn(async () => ({
      stdout: "full output",
      stderr: "",
      stdoutHtml: "<p>full output</p>",
      mode: "markdown" as const,
      responseTruncated: false,
    }));

    const result = render(
      <I18nProvider>
        <BangCommandDisplayObject object={object} handlers={{ fetchOutput }} />
      </I18nProvider>,
    );

    expect(fetchOutput).not.toHaveBeenCalled();
    expect(result.container.textContent).toContain("preview");

    fireEvent.click(screen.getByRole("button", { name: "Load output" }));
    await waitFor(() => expect(fetchOutput).toHaveBeenCalledWith("bang-1"));
    await waitFor(() =>
      expect(result.container.textContent).toContain("full output"),
    );
  });
});
