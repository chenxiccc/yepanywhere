// @vitest-environment node

import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "@playwright/test";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const evaluatorUrl = new URL("../browserDebugEval.ts", import.meta.url);

let browser: Browser;
let page: Page;
let server: Server;

describe("browser debug evaluation under the served-page CSP", () => {
  beforeAll(async () => {
    const source = await readFile(evaluatorUrl, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    server = createServer((_request, response) => {
      response.setHeader(
        "Content-Security-Policy",
        "script-src 'self' 'unsafe-inline'",
      );
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>diagnostic target</title>
        <body><main id="target"></main></body>
        <script>window.exports = {};${compiled}</script>
        <script>
          try {
            globalThis.eval("6 * 7");
            document.body.dataset.evalFailure = "none";
          } catch (error) {
            document.body.dataset.evalFailure =
              error instanceof Error ? error.name : String(error);
          }
        </script>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function evaluate(code: string): Promise<unknown> {
    return page.evaluate(async (source) => {
      const exported = (
        window as unknown as {
          exports: {
            executeBrowserDebugCode: (value: string) => Promise<unknown>;
          };
        }
      ).exports;
      return exported.executeBrowserDebugCode(source);
    }, code);
  }

  it("executes expressions and promises while runtime compilation is denied", async () => {
    const evalFailure = await page
      .locator("body")
      .getAttribute("data-eval-failure");

    expect(evalFailure).toBe("EvalError");
    await expect(evaluate("document.title")).resolves.toBe("diagnostic target");
    await expect(
      evaluate("Promise.resolve({ answer: 6 * 7 })"),
    ).resolves.toEqual({ answer: 42 });
  });

  it("falls back to statements and propagates mutations and errors", async () => {
    await expect(
      evaluate('document.body.dataset.diagnostic = "active";'),
    ).resolves.toBeUndefined();
    await expect(
      page.locator("body").getAttribute("data-diagnostic"),
    ).resolves.toBe("active");
    await expect(
      evaluate('throw new Error("diagnostic failure")'),
    ).rejects.toThrow("diagnostic failure");
  });
});
