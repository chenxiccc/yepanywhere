export function hasAsciiControlCharacter(
  value: string,
  includeSpace = false,
): boolean {
  const upperBound = includeSpace ? 0x20 : 0x1f;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= upperBound || code === 0x7f) return true;
  }
  return false;
}
