type CharacterMatcher = (character: string) => boolean;

type PatternNode =
  | { kind: "empty" }
  | { kind: "character"; matches: CharacterMatcher }
  | { kind: "start" | "end" }
  | { kind: "concatenate" | "alternate"; left: PatternNode; right: PatternNode }
  | { kind: "repeat"; child: PatternNode; minimum: 0 | 1; optional: boolean };

interface ClassAtom {
  literal?: string;
  matches: CharacterMatcher;
}

const ASCII_WORD = /^[A-Za-z0-9_]$/;
const WHITESPACE = /^\s$/;
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

class LinearRegexParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): PatternNode {
    const node = this.parseAlternation();
    if (this.index !== this.source.length) {
      throw new Error("Unsupported linear regular expression");
    }
    return node;
  }

  private parseAlternation(): PatternNode {
    let node = this.parseSequence();
    while (this.peek() === "|") {
      this.index += 1;
      node = {
        kind: "alternate",
        left: node,
        right: this.parseSequence(),
      };
    }
    return node;
  }

  private parseSequence(): PatternNode {
    let node: PatternNode = { kind: "empty" };
    while (
      this.index < this.source.length &&
      this.peek() !== ")" &&
      this.peek() !== "|"
    ) {
      const next = this.parseQuantifiedAtom();
      node =
        node.kind === "empty"
          ? next
          : { kind: "concatenate", left: node, right: next };
    }
    return node;
  }

  private parseQuantifiedAtom(): PatternNode {
    const atom = this.parseAtom();
    const quantifier = this.peek();
    if (quantifier !== "*" && quantifier !== "+" && quantifier !== "?") {
      if (quantifier === "{") {
        throw new Error("Braced quantifiers are not supported");
      }
      return atom;
    }
    this.index += 1;
    const node: PatternNode = {
      kind: "repeat",
      child: atom,
      minimum: quantifier === "+" ? 1 : 0,
      optional: quantifier === "?",
    };
    if (this.peek() === "?") {
      this.index += 1;
    }
    if (this.peek() === "*" || this.peek() === "+" || this.peek() === "?") {
      throw new Error("Invalid quantifier sequence");
    }
    return node;
  }

  private parseAtom(): PatternNode {
    const character = this.source[this.index++];
    switch (character) {
      case undefined:
        throw new Error("Missing regular expression atom");
      case ".":
        return { kind: "character", matches: () => true };
      case "^":
        return { kind: "start" };
      case "$":
        return { kind: "end" };
      case "[":
        return this.parseCharacterClass();
      case "(": {
        if (this.peek() === "?") {
          this.index += 1;
          if (this.peek() !== ":") {
            throw new Error("Lookarounds and inline flags are not supported");
          }
          this.index += 1;
        }
        const child = this.parseAlternation();
        if (this.peek() !== ")") {
          throw new Error("Unclosed regular expression group");
        }
        this.index += 1;
        return child;
      }
      case "\\": {
        const escaped = this.parseEscape(false);
        return { kind: "character", matches: escaped.matches };
      }
      case "*":
      case "+":
      case "?":
      case "{":
      case "}":
        throw new Error("Unsupported regular expression syntax");
      default:
        return {
          kind: "character",
          matches: (candidate) => candidate === character,
        };
    }
  }

  private parseCharacterClass(): PatternNode {
    const negate = this.peek() === "^";
    if (negate) this.index += 1;
    const matchers: CharacterMatcher[] = [];
    let first = true;

    while (this.index < this.source.length) {
      if (this.peek() === "]" && !first) {
        this.index += 1;
        const matches = (character: string) =>
          matchers.some((matcher) => matcher(character));
        return {
          kind: "character",
          matches: negate ? (character) => !matches(character) : matches,
        };
      }
      const start = this.parseClassAtom();
      first = false;
      if (
        start.literal !== undefined &&
        this.peek() === "-" &&
        this.source[this.index + 1] !== "]"
      ) {
        this.index += 1;
        const end = this.parseClassAtom();
        if (end.literal === undefined) {
          throw new Error("Character-class ranges require literal endpoints");
        }
        const firstCode = start.literal.charCodeAt(0);
        const lastCode = end.literal.charCodeAt(0);
        if (firstCode > lastCode) {
          throw new Error("Character-class range is reversed");
        }
        matchers.push((character) => {
          const code = character.charCodeAt(0);
          return code >= firstCode && code <= lastCode;
        });
      } else {
        matchers.push(start.matches);
      }
    }
    throw new Error("Unclosed character class");
  }

  private parseClassAtom(): ClassAtom {
    const character = this.source[this.index++];
    if (character === undefined) {
      throw new Error("Unclosed character class");
    }
    if (character === "\\") return this.parseEscape(true);
    return {
      literal: character,
      matches: (candidate) => candidate === character,
    };
  }

  private parseEscape(inCharacterClass: boolean): ClassAtom {
    const escaped = this.source[this.index++];
    switch (escaped) {
      case undefined:
        throw new Error("Trailing regular expression escape");
      case "d":
        return { matches: (character) => character >= "0" && character <= "9" };
      case "D":
        return { matches: (character) => character < "0" || character > "9" };
      case "s":
        return { matches: (character) => WHITESPACE.test(character) };
      case "S":
        return { matches: (character) => !WHITESPACE.test(character) };
      case "w":
        return { matches: (character) => ASCII_WORD.test(character) };
      case "W":
        return { matches: (character) => !ASCII_WORD.test(character) };
      case "n":
        return this.literalEscape("\n");
      case "r":
        return this.literalEscape("\r");
      case "t":
        return this.literalEscape("\t");
      case "f":
        return this.literalEscape("\f");
      case "v":
        return this.literalEscape("\v");
      case "b":
        if (inCharacterClass) return this.literalEscape("\b");
        throw new Error("Word-boundary assertions are not supported");
      case "x":
        return this.literalEscape(this.readHexEscape(2));
      case "u":
        return this.literalEscape(this.readHexEscape(4));
      case "0":
        if (/^[0-9]$/.test(this.peek() ?? "")) {
          throw new Error("Octal escapes are not supported");
        }
        return this.literalEscape("\0");
      default:
        if (/^[A-Za-z0-9]$/.test(escaped)) {
          throw new Error("Backreferences and named escapes are not supported");
        }
        return this.literalEscape(escaped);
    }
  }

  private readHexEscape(length: number): string {
    const digits = this.source.slice(this.index, this.index + length);
    if (
      digits.length !== length ||
      [...digits].some((digit) => !HEX_DIGIT.test(digit))
    ) {
      throw new Error("Invalid hexadecimal escape");
    }
    this.index += length;
    return String.fromCharCode(Number.parseInt(digits, 16));
  }

  private literalEscape(literal: string): ClassAtom {
    return { literal, matches: (candidate) => candidate === literal };
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }
}

type StateKind = "character" | "epsilon" | "split" | "start" | "end" | "match";

interface PatternState {
  kind: StateKind;
  matches?: CharacterMatcher;
  out: number | null;
  out1: number | null;
}

interface PatchReference {
  state: number;
  output: "out" | "out1";
}

interface PatternFragment {
  start: number;
  pending: PatchReference[];
}

function compilePattern(root: PatternNode): {
  start: number;
  states: PatternState[];
} {
  const states: PatternState[] = [];
  const add = (state: PatternState): number => states.push(state) - 1;
  const patch = (references: PatchReference[], target: number) => {
    for (const reference of references) {
      states[reference.state]![reference.output] = target;
    }
  };

  const compile = (node: PatternNode): PatternFragment => {
    switch (node.kind) {
      case "empty": {
        const state = add({ kind: "epsilon", out: null, out1: null });
        return { start: state, pending: [{ state, output: "out" }] };
      }
      case "character": {
        const state = add({
          kind: "character",
          matches: node.matches,
          out: null,
          out1: null,
        });
        return { start: state, pending: [{ state, output: "out" }] };
      }
      case "start":
      case "end": {
        const state = add({ kind: node.kind, out: null, out1: null });
        return { start: state, pending: [{ state, output: "out" }] };
      }
      case "concatenate": {
        const left = compile(node.left);
        const right = compile(node.right);
        patch(left.pending, right.start);
        return { start: left.start, pending: right.pending };
      }
      case "alternate": {
        const left = compile(node.left);
        const right = compile(node.right);
        const state = add({
          kind: "split",
          out: left.start,
          out1: right.start,
        });
        return {
          start: state,
          pending: [...left.pending, ...right.pending],
        };
      }
      case "repeat": {
        const child = compile(node.child);
        if (node.optional) {
          const state = add({ kind: "split", out: child.start, out1: null });
          return {
            start: state,
            pending: [...child.pending, { state, output: "out1" }],
          };
        }
        const state = add({ kind: "split", out: child.start, out1: null });
        patch(child.pending, state);
        return {
          start: node.minimum === 1 ? child.start : state,
          pending: [{ state, output: "out1" }],
        };
      }
    }
  };

  const fragment = compile(root);
  const match = add({ kind: "match", out: null, out1: null });
  patch(fragment.pending, match);
  return { start: fragment.start, states };
}

export function compileLinearWholeRegex(
  source: string,
  maxInputCodeUnits: number,
): (input: string) => boolean {
  const root = new LinearRegexParser(source).parse();
  const { start, states } = compilePattern(root);
  const seen = new Uint32Array(states.length);
  let generation = 0;

  const closure = (
    seeds: readonly number[],
    position: number,
    inputLength: number,
  ): number[] => {
    generation += 1;
    if (generation === 0xffffffff) {
      seen.fill(0);
      generation = 1;
    }
    const active: number[] = [];
    const stack = [...seeds];
    while (stack.length > 0) {
      const stateIndex = stack.pop()!;
      if (seen[stateIndex] === generation) continue;
      seen[stateIndex] = generation;
      const state = states[stateIndex]!;
      if (state.kind === "epsilon") {
        if (state.out !== null) stack.push(state.out);
      } else if (state.kind === "split") {
        if (state.out !== null) stack.push(state.out);
        if (state.out1 !== null) stack.push(state.out1);
      } else if (state.kind === "start") {
        if (position === 0 && state.out !== null) stack.push(state.out);
      } else if (state.kind === "end") {
        if (position === inputLength && state.out !== null)
          stack.push(state.out);
      } else {
        active.push(stateIndex);
      }
    }
    return active;
  };

  return (input: string): boolean => {
    if (input.length > maxInputCodeUnits) return false;
    let active = closure([start], 0, input.length);
    for (let position = 0; position < input.length; position += 1) {
      const character = input[position]!;
      const seeds: number[] = [];
      for (const stateIndex of active) {
        const state = states[stateIndex]!;
        if (
          state.kind === "character" &&
          state.matches?.(character) &&
          state.out !== null
        ) {
          seeds.push(state.out);
        }
      }
      if (seeds.length === 0) return false;
      active = closure(seeds, position + 1, input.length);
    }
    return active.some((stateIndex) => states[stateIndex]!.kind === "match");
  };
}
