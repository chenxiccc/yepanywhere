/**
 * A stylesheet-contract test whose selector vocabulary exists only inside
 * regular-expression literals, like
 * `packages/client/src/styles/__tests__/turnGalleryNaturalSize.test.ts`.
 */
export const selectorPattern = /\.fixture-regex-selector\s*\{[^}]*\}/s;

/**
 * Neither a bare word nor an escaped backslash before the any-character
 * metacharacter names a class.
 */
export const noisePattern = /fixture-regex-noise|\\.fixture-regex-noise/;
