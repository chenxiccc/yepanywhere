/** Whether the document's current non-collapsed selection crosses an element. */
export function selectionIntersectsElement(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) {
      return true;
    }
  }
  return false;
}
