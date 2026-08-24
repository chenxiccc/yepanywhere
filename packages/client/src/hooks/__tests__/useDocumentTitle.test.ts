import { describe, expect, it } from "vitest";
import { formatDocumentTitle } from "../useDocumentTitle";

describe("formatDocumentTitle", () => {
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
});
