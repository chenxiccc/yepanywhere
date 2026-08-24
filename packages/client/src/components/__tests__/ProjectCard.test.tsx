// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../types";
import { ProjectCard } from "../ProjectCard";

const project: Project = {
  id: "proj-1",
  name: "test-project",
  path: "/tmp/test-project",
  sessionCount: 0,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};

function renderProjectCard(onDeleteProject = vi.fn()) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ProjectCard
          project={project}
          needsAttentionCount={0}
          thinkingCount={0}
          onDeleteProject={onDeleteProject}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ProjectCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers a project removal action", () => {
    const onDeleteProject = vi.fn();
    renderProjectCard(onDeleteProject);

    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove project" }));

    expect(onDeleteProject).toHaveBeenCalledWith(project);
  });

  it("opens project settings from the ellipsis and context menu", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectCard
            project={project}
            needsAttentionCount={0}
            thinkingCount={0}
            onOpenSettings={onOpenSettings}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith(project);

    fireEvent.contextMenu(
      container.querySelector("[data-project-card-link]") as Element,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("commits a longer inline code name on blur", async () => {
    const onUpdateCodeName = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectCard
            project={{ ...project, codeName: "tst" }}
            needsAttentionCount={0}
            thinkingCount={0}
            onUpdateCodeName={onUpdateCodeName}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit code name" }));
    const input = screen.getByRole("textbox", { name: "Project code name" });
    fireEvent.change(input, { target: { value: "test-code" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onUpdateCodeName).toHaveBeenCalledWith(
        expect.objectContaining({ id: "proj-1" }),
        "test-code",
      );
    });
  });

  it("cancels an inline code-name edit with the x control", () => {
    const onUpdateCodeName = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectCard
            project={{ ...project, codeName: "tst" }}
            needsAttentionCount={0}
            thinkingCount={0}
            onUpdateCodeName={onUpdateCodeName}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit code name" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project code name" }),
      { target: { value: "discard-me" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel code name edit" }),
    );

    expect(onUpdateCodeName).not.toHaveBeenCalled();
    expect(screen.getByText("tst")).toBeTruthy();
  });

  it("shows a project queue count badge", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectCard
            project={project}
            needsAttentionCount={0}
            thinkingCount={0}
            queueCount={2}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByTitle("Project Queue items: 2").textContent).toBe("2");
  });

  it("shows a separate warning for a paused queue item", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectCard
            project={project}
            needsAttentionCount={0}
            thinkingCount={0}
            queueCount={1}
            hasQueueWarning
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByTitle("Project Queue items: 1").textContent).toBe("1");
    expect(
      screen.getByLabelText(
        "Project Queue item needs attention. Review or retry it in Project Queue.",
      ).textContent,
    ).toBe("!");
  });
});
