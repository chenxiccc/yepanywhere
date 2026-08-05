/** Choose the exact provider-bound prefix for one delivery. */
export function resolveDeliverySpeechPrefix({
  configuredPrefix,
  speechTriggered,
  recentSpeech,
}: {
  configuredPrefix: string | null;
  speechTriggered: boolean;
  recentSpeech: boolean;
}): string | null {
  if (!configuredPrefix) return null;
  return speechTriggered || recentSpeech ? configuredPrefix : null;
}

/** Apply a resolved prefix once, with one separator before non-empty text. */
export function prependSpeechMessagePrefix(
  text: string,
  prefix: string | null,
): string {
  const trimmed = text.trim();
  if (!prefix) return trimmed;
  return trimmed ? `${prefix} ${trimmed}` : prefix;
}

/** Short visual label; the owning button exposes the exact prefix accessibly. */
export function getSpeechPrefixCueLabel(prefix: string): string {
  const bracketed = /^\[([^\]]+)\]$/.exec(prefix);
  return bracketed?.[1] ?? prefix;
}
