import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { getCachedTranscriptProjection } from "./transcriptProjection/cache";
import { compileTranscriptProjection } from "./transcriptProjection/compiler";
import type { MessageProjectionDiagnostics } from "./transcriptProjection/messageProjection";
import type { TranscriptProjectionAugments } from "./transcriptProjection/types";
import { applyRecentProjectPathLinks } from "./recentProjectPathLinks";

const webProjectionDiagnostics: MessageProjectionDiagnostics = {
  onAssistantMessage(details) {
    // Preserve the historical debug label across the structural refactor.
    console.log("[preprocessMessages] Processing assistant message:", details);
  },
};

export function compileWebTranscriptProjection(
  messages: Message[],
  augments?: TranscriptProjectionAugments,
): RenderItem[] {
  const diagnostics =
    typeof window !== "undefined" && window.__STREAMING_DEBUG__
      ? webProjectionDiagnostics
      : undefined;
  return applyRecentProjectPathLinks(
    compileTranscriptProjection(messages, augments, diagnostics),
  );
}

export function getCachedWebTranscriptProjection(
  messages: Message[],
  augments?: TranscriptProjectionAugments,
): RenderItem[] {
  return getCachedTranscriptProjection(
    messages,
    augments,
    compileWebTranscriptProjection,
  );
}
