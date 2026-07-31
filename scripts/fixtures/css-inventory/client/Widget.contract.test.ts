/**
 * A stylesheet-contract test that pins `.widget-title` only through a
 * regular-expression literal, with no string-literal mention anywhere.
 */
export const titleRule = /\.widget-title\s*\{[^}]*font-weight:\s*600;/s;
