import {
  augmentEditToolUsesInMessage,
  augmentExitPlanModeAndReadResultsInMessage,
  augmentFinalizedMessage,
  augmentWriteToolUsesInMessage,
} from "../augments/finalized-message-augmenter.js";
import type { SafeMarkdownRenderOptions } from "../augments/safe-markdown.js";
import type { Message } from "../supervisor/types.js";

function asAugmentableMessage(message: Message): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

/**
 * Embed Edit augment data directly into tool_use inputs.
 * Adds _structuredPatch and _diffHtml to Edit tool_use input blocks.
 */
export async function augmentEditToolUses(messages: Message[]): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentEditToolUsesInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Embed Write augment data directly into tool_use inputs.
 * Adds syntax-highlighted fields to Write tool_use input blocks.
 */
export async function augmentWriteToolUses(messages: Message[]): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentWriteToolUsesInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Render ExitPlanMode plan HTML and augment structured Read tool results.
 */
export async function augmentExitPlanModeAndReadResults(
  messages: Message[],
): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentExitPlanModeAndReadResultsInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Apply the same persisted-message augmentation pipeline used by session GET.
 */
export async function augmentPersistedSessionMessages(
  messages: Message[],
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentFinalizedMessage(asAugmentableMessage(message), {
        safeMarkdownOptions,
      }),
    ),
  );
}
