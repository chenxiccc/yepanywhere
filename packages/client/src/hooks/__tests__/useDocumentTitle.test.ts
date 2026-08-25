// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { UI_KEYS } from "../../lib/storageKeys";
import { formatDocumentTitle, useDocumentTitle } from "../useDocumentTitle";

describe("formatDocumentTitle", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues();
  });

  it("uses the compact project code name without truncating the session title", () => {
    expect(
      formatDocumentTitle(
        "yepanywhere",
        "yep",
        "Improve tab title animation space efficiency",
      ),
    ).toBe("yep:Improve tab title animation space efficiency");
  });

  it("keeps the released full-name title fallback for older servers", () => {
    expect(
      formatDocumentTitle(
        "project-with-a-long-name",
        undefined,
        "session title that is also quite long",
      ),
    ).toBe("project-w… - session title that …");
  });

  it("uses the full-name title fallback by default even when a code exists", () => {
    renderHook(() =>
      useDocumentTitle(
        "yepanywhere",
        "yep",
        "Improve tab title animation space efficiency",
      ),
    );

    expect(document.title).toBe("yepanywhe… - Improve tab title a…");
    expect(
      document.querySelector("title")?.hasAttribute("data-project-code-name"),
    ).toBe(false);
  });

  it("uses the project code title only after browser opt-in", () => {
    localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
    invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);

    renderHook(() =>
      useDocumentTitle(
        "yepanywhere",
        "yep",
        "Improve tab title animation space efficiency",
      ),
    );

    expect(document.title).toBe(
      "yep:Improve tab title animation space efficiency",
    );
    expect(
      document.querySelector("title")?.hasAttribute("data-project-code-name"),
    ).toBe(true);
  });
});
