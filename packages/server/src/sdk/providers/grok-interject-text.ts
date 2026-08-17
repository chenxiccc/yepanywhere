/**
 * Grok's x.ai/interject drain wraps the user's text in a synthetic envelope
 * before writing it back as a user_message_chunk. YA already echoed the
 * raw steer; replay must show that inner text, not the wrapper.
 *
 * Match the outer envelope only. A steer that quotes another <user_query>
 * block keeps that inner markup.
 */

const INTERJECT_PREFIX =
  /^The user sent a message while you were working:\r?\n<user_query>\r?\n/;
const INTERJECT_SUFFIX =
  /\r?\n<\/user_query>\r?\nMake sure to complete any unfinished tasks from previous turns\.\s*$/;

export function unwrapGrokInterjectText(text: string): string {
  const prefix = text.match(INTERJECT_PREFIX);
  if (prefix?.index !== 0) return text;
  const suffix = text.match(INTERJECT_SUFFIX);
  if (!suffix) return text;
  const start = prefix[0].length;
  const end = text.length - suffix[0].length;
  if (end < start) return text;
  return text.slice(start, end);
}
