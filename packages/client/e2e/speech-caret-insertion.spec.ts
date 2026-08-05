import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

interface FakeSpeechResultInput {
  transcript: string;
  isFinal: boolean;
}

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function openBrowserSpeechComposer(
  page: Page,
  baseURL: string,
  initialText = "",
) {
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-voice-input-enabled", "true");
    localStorage.setItem("yep-anywhere-speech-method", "browser-native");

    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      unspokenPunctuation = false;
      lang = "";
      maxAlternatives = 1;
      onstart: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      onaudiostart: ((event: Event) => void) | null = null;
      onaudioend: ((event: Event) => void) | null = null;
      onsoundstart: ((event: Event) => void) | null = null;
      onsoundend: ((event: Event) => void) | null = null;
      onspeechstart: ((event: Event) => void) | null = null;
      onspeechend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onresult: ((event: Event) => void) | null = null;

      constructor() {
        super();
        (
          window as unknown as {
            __yaFakeSpeechRecognition?: FakeSpeechRecognition;
          }
        ).__yaFakeSpeechRecognition = this;
      }

      start() {
        queueMicrotask(() => {
          this.onstart?.call(this, new Event("start"));
          this.onaudiostart?.call(this, new Event("audiostart"));
        });
      }

      stop() {
        queueMicrotask(() => this.onend?.call(this, new Event("end")));
      }

      abort() {}

      emit(entries: FakeSpeechResultInput[], resultIndex: number) {
        const mapped = entries.map(({ transcript, isFinal }) => {
          const alternative = { transcript, confidence: 1 };
          return {
            isFinal,
            length: 1,
            0: alternative,
            item: () => alternative,
          };
        });
        const results = {
          length: mapped.length,
          ...mapped,
          item: (index: number) => mapped[index],
        };
        this.onresult?.call(this, { resultIndex, results } as unknown as Event);
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
  });

  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const textarea = page.locator("[data-composer-input]");
  await expect(textarea).toBeVisible();
  if (initialText) {
    await textarea.fill(initialText);
    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(
    page.getByRole("button", { name: "Stop voice input" }),
  ).toHaveAttribute("data-speech-method", "browser-native");
  return textarea;
}

async function emitSpeechResults(
  page: Page,
  entries: FakeSpeechResultInput[],
  resultIndex = 0,
) {
  await page.evaluate(
    ({ nextEntries, nextResultIndex }) => {
      (
        window as unknown as {
          __yaFakeSpeechRecognition: {
            emit(entries: FakeSpeechResultInput[], resultIndex: number): void;
          };
        }
      ).__yaFakeSpeechRecognition.emit(nextEntries, nextResultIndex);
    },
    { nextEntries: entries, nextResultIndex: resultIndex },
  );
}

test("moves only the next fragment when the caret changes mid-interim", async ({
  page,
  baseURL,
}) => {
  const textarea = await openBrowserSpeechComposer(
    page,
    baseURL,
    "existing text",
  );

  await emitSpeechResults(page, [
    { transcript: "spoken first", isFinal: false },
  ]);
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "spoken first",
  );

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);
  await expect(textarea).toHaveValue("existing text");

  await emitSpeechResults(page, [
    { transcript: "spoken first still speaking", isFinal: false },
  ]);
  await expect(textarea).toHaveValue("existing text");
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "spoken first still speaking",
  );

  await emitSpeechResults(page, [
    { transcript: "spoken first still speaking", isFinal: true },
    { transcript: "resumed speech", isFinal: false },
  ]);
  await expect(textarea).toHaveValue(
    "existing text spoken first still speaking",
  );
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "resumed speech",
  );

  await emitSpeechResults(
    page,
    [
      { transcript: "spoken first still speaking", isFinal: true },
      { transcript: "resumed speech", isFinal: true },
    ],
    1,
  );
  await expect(textarea).toHaveValue(
    "resumed speech existing text spoken first still speaking",
  );
});

test("moves a later final-only browser result to the live caret", async ({
  page,
  baseURL,
}) => {
  const textarea = await openBrowserSpeechComposer(page, baseURL);

  await emitSpeechResults(page, [
    { transcript: "spoken first", isFinal: true },
  ]);
  await expect(textarea).toHaveValue("spoken first");

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);

  await emitSpeechResults(
    page,
    [
      { transcript: "spoken first", isFinal: true },
      { transcript: "resumed speech", isFinal: true },
    ],
    1,
  );
  await expect(textarea).toHaveValue("resumed speech spoken first");
});
