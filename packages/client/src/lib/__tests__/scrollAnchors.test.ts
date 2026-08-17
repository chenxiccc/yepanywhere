import { describe, expect, it } from "vitest";
import { findRenderRow, indexRenderRowsById } from "../scrollAnchors";

function row(id: string): HTMLElement {
  const element = document.createElement("div");
  element.dataset.renderId = id;
  return element;
}

describe("indexRenderRowsById", () => {
  it("prefers the top-level row when a nested entry reuses the id", () => {
    const messageList = document.createElement("div");
    const group = row("explored-1");
    const nested = row("tool-1");
    const topLevel = row("tool-1");
    group.append(nested);
    messageList.append(group, topLevel);
    document.body.append(messageList);

    expect(findRenderRow(messageList, "tool-1")).toBe(topLevel);
    expect(indexRenderRowsById(messageList).get("explored-1")).toBe(group);

    messageList.remove();
  });

  it("falls back to the nested entry when it is the only row for that id", () => {
    const messageList = document.createElement("div");
    const group = row("explored-1");
    const nested = row("tool-1");
    group.append(nested);
    messageList.append(group);
    document.body.append(messageList);

    expect(findRenderRow(messageList, "tool-1")).toBe(nested);

    messageList.remove();
  });
});
