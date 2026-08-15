// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { NewSessionProjectQueue } from "../NewSessionProjectQueue";

function renderQueue(error: Error | null) {
  return render(
    <I18nProvider>
      <NewSessionProjectQueue
        items={[]}
        loading={false}
        error={error}
        onOpenItem={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("NewSessionProjectQueue", () => {
  afterEach(cleanup);

  it("hides a confirmed empty queue", () => {
    const view = renderQueue(null);

    expect(view.container.childElementCount).toBe(0);
  });

  it("renders an initial load failure without stale items", () => {
    renderQueue(new Error("source unavailable"));

    expect(screen.getByRole("heading", { name: "Project Queue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Project queue error: source unavailable",
    );
  });
});
