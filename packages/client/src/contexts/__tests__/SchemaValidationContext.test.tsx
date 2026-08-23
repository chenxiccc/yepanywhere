import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { memo, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  SchemaValidationProvider,
  useSchemaValidationContext,
} from "../SchemaValidationContext";
import { ToastProvider } from "../ToastContext";

const writeResult = z
  .object({ bytes: z.number(), path: z.string() })
  .safeParse({ bytes: "many" });
const bashResult = z.object({ stdout: z.string() }).safeParse({});

if (writeResult.success || bashResult.success) {
  throw new Error("schema validation fixtures must fail");
}
const writeError = writeResult.error;
const bashError = bashResult.error;
if (!writeError || !bashError) {
  throw new Error("schema validation fixtures must include errors");
}

function InvalidResultReporter() {
  const { reportValidationError } = useSchemaValidationContext();
  useEffect(() => {
    reportValidationError("Write", writeError);
    reportValidationError("Bash", bashError);
    reportValidationError("Write", writeError);
  }, [reportValidationError]);
  return (
    <div style={{ display: "none" }}>offscreen invalid result fixture</div>
  );
}

describe("SchemaValidationProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("summarizes distinct gaps from non-visible results by sorted tool type", async () => {
    window.localStorage.setItem(
      UI_KEYS.schemaValidation,
      JSON.stringify({ enabled: true, ignoredTools: ["Write"] }),
    );
    let consumerRenderCount = 0;
    const StableConsumer = memo(function StableConsumer() {
      consumerRenderCount += 1;
      useSchemaValidationContext();
      return null;
    });

    render(
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <StableConsumer />
            <InvalidResultReporter />
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    const trigger = await screen.findByRole("button", {
      name: "3 schema gaps across 2 tool types — click for details",
    });
    expect(consumerRenderCount).toBe(1);
    expect(trigger.getAttribute("title")).toBe(
      "3 schema gaps across 2 tool types — click for details",
    );

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.querySelector("code")?.textContent),
    ).toEqual(["Bash", "Write"]);
    expect(within(dialog).getByText("Ignored")).toBeDefined();
    expect(within(dialog).getByText("bytes")).toBeDefined();
    expect(within(dialog).getByText("path")).toBeDefined();
    expect(within(dialog).getByText("stdout")).toBeDefined();
  });

  it("does not collect or render gaps while validation is disabled", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <InvalidResultReporter />
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(screen.queryByText(/schema gaps across/)).toBeNull();
  });
});
