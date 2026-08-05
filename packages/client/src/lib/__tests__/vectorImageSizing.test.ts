import { describe, expect, it } from "vitest";
import { isVectorImage, svgDeclaresSize } from "../vectorImageSizing";

describe("isVectorImage", () => {
  it("recognizes the SVG content type, including parameters", () => {
    expect(isVectorImage("image/svg+xml", "fig.svg")).toBe(true);
    expect(isVectorImage("image/svg+xml; charset=utf-8", "fig.svg")).toBe(true);
  });

  it("falls back to the extension only when no type is served", () => {
    expect(isVectorImage(undefined, "/tmp/fig.SVG")).toBe(true);
    expect(isVectorImage("", "fig.png")).toBe(false);
    expect(isVectorImage("image/png", "mislabelled.svg")).toBe(false);
  });
});

describe("svgDeclaresSize", () => {
  it("accepts absolute lengths, with or without units", () => {
    expect(
      svgDeclaresSize('<svg width="200" height="120" viewBox="0 0 200 120">'),
    ).toBe(true);
    expect(
      svgDeclaresSize(
        '<svg xmlns="http://www.w3.org/2000/svg" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6">',
      ),
    ).toBe(true);
    expect(svgDeclaresSize("<svg width='10em' height='4em'>")).toBe(true);
  });

  it("treats a viewBox alone as no declared size", () => {
    expect(svgDeclaresSize('<svg viewBox="0 0 400 300">')).toBe(false);
  });

  it("requires both dimensions", () => {
    expect(svgDeclaresSize('<svg width="200" viewBox="0 0 200 120">')).toBe(
      false,
    );
  });

  it("rejects percentages, which defer to the container", () => {
    expect(svgDeclaresSize('<svg width="100%" height="100%">')).toBe(false);
  });

  it("skips a leading XML declaration, doctype, and comment", () => {
    expect(
      svgDeclaresSize(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!-- width="999" -->\n<svg xmlns="http://www.w3.org/2000/svg" height="80" width="120"></svg>`,
      ),
    ).toBe(true);
  });

  it("reports no declared size when no root element is present", () => {
    expect(svgDeclaresSize("not markup at all")).toBe(false);
  });
});
