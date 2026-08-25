import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";

const mocks = vi.hoisted(() => ({
  openSidebar: vi.fn(),
}));

vi.mock("../../components/FileViewer", () => ({
  FileViewer: ({ filePath }: { filePath: string }) => (
    <div data-testid="file-viewer">{filePath}</div>
  ),
}));

vi.mock("../../contexts/GlossaryContext", () => ({
  GlossaryProjectBoundary: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({ openSidebar: mocks.openSidebar }),
}));

import { FilePage } from "../FilePage";

describe("FilePage", () => {
  it("opens the shared sidebar without leaving the standalone viewer", () => {
    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={["/projects/project-1/file?path=README.md"]}
        >
          <Routes>
            <Route path="/projects/:projectId/file" element={<FilePage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(mocks.openSidebar).toHaveBeenCalledOnce();
    expect(screen.getByTestId("file-viewer").textContent).toBe("README.md");
    expect(
      screen
        .getByRole("link", { name: "Back to project" })
        .getAttribute("href"),
    ).toBe("/projects/project-1");
  });
});
