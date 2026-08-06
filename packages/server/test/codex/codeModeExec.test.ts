import { describe, expect, it } from "vitest";
import {
  extractCodexCodeModeCalls,
  extractCodexCodeModeTextOutput,
} from "../../src/codex/codeModeExec.js";

describe("extractCodexCodeModeCalls", () => {
  it("extracts a literal exec_command input", () => {
    const calls = extractCodexCodeModeCalls(`
      const r = await tools.exec_command({"cmd":"pwd","workdir":"/repo"});
      text(r.output);
    `);

    expect(calls).toMatchObject([
      {
        toolName: "exec_command",
        input: { cmd: "pwd", workdir: "/repo" },
      },
    ]);
  });

  it("resolves a simple const string passed to apply_patch", () => {
    const calls = extractCodexCodeModeCalls(`
      const patch = "*** Begin Patch\\n*** End Patch";
      text(await tools.apply_patch(patch));
    `);

    expect(calls).toMatchObject([
      {
        toolName: "apply_patch",
        input: { _rawPatch: "*** Begin Patch\n*** End Patch" },
      },
    ]);
  });

  it("extracts multiple literal calls without interpreting Promise.all", () => {
    const calls = extractCodexCodeModeCalls(`
      const results = await Promise.all([
        tools.exec_command({"cmd":"pnpm lint"}),
        tools.exec_command({"cmd":"pnpm typecheck"})
      ]);
      text(results.length);
    `);

    expect(calls.map((call) => call.input)).toEqual([
      { cmd: "pnpm lint" },
      { cmd: "pnpm typecheck" },
    ]);
  });

  it("ignores calls in strings and comments", () => {
    const calls = extractCodexCodeModeCalls(`
      // tools.exec_command({"cmd":"comment"})
      const example = "tools.exec_command({\\"cmd\\":\\"string\\"})";
      text(example);
    `);

    expect(calls).toEqual([]);
  });

  it("fails closed for expressions and multi-argument calls", () => {
    const calls = extractCodexCodeModeCalls(`
      await tools.exec_command(makeOptions());
      await tools.exec_command({"cmd":"pwd"}, extra);
    `);

    expect(calls).toEqual([]);
  });

  it("extracts JS object literals with unquoted identifier keys", () => {
    const calls = extractCodexCodeModeCalls(
      'const r = await tools.exec_command({cmd:"pwd && ls",workdir:"/repo",yield_time_ms:10000,max_output_tokens:30000}); text(r.output);',
    );

    expect(calls).toMatchObject([
      {
        toolName: "exec_command",
        input: {
          cmd: "pwd && ls",
          workdir: "/repo",
          yield_time_ms: 10000,
          max_output_tokens: 30000,
        },
      },
    ]);
  });

  it("extracts mixed quoted and unquoted keys with spaces and trailing comma", () => {
    const calls = extractCodexCodeModeCalls(
      "await tools.write_stdin({session_id: 95061, \"chars\": '', yield_time_ms: 60000, });",
    );

    expect(calls).toMatchObject([
      {
        toolName: "write_stdin",
        input: { session_id: 95061, chars: "", yield_time_ms: 60000 },
      },
    ]);
  });

  it("decodes JS string escapes and template strings without interpolation", () => {
    const calls = extractCodexCodeModeCalls(
      "await tools.exec_command({cmd:`printf '\\\\n'\ngit status`,label:'it\\'s'});",
    );

    expect(calls).toMatchObject([
      {
        toolName: "exec_command",
        input: { cmd: "printf '\\n'\ngit status", label: "it's" },
      },
    ]);
  });

  it("keeps shell parameter expansion inside string literals", () => {
    const calls = extractCodexCodeModeCalls(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion in a plain string is the case under test
      'await tools.exec_command({cmd:"echo ${HOME:-nowhere}"});',
    );

    expect(calls).toMatchObject([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion in a plain string is the case under test
      { toolName: "exec_command", input: { cmd: "echo ${HOME:-nowhere}" } },
    ]);
  });

  it("fails closed on template interpolation and nonliteral values", () => {
    const calls = extractCodexCodeModeCalls(`
      await tools.exec_command({cmd:\`echo \${name}\`});
      await tools.exec_command({cmd: makeCommand()});
      await tools.exec_command({cmd: cmdVar});
    `);

    expect(calls).toEqual([]);
  });

  it("resolves const-bound literals with unquoted keys", () => {
    const calls = extractCodexCodeModeCalls(`
      const options = {cmd:"pnpm test", workdir:"/repo"};
      await tools.exec_command(options);
    `);

    expect(calls).toMatchObject([
      {
        toolName: "exec_command",
        input: { cmd: "pnpm test", workdir: "/repo" },
      },
    ]);
  });
});

describe("extractCodexCodeModeTextOutput", () => {
  it("joins text-only code-mode result blocks", () => {
    expect(
      extractCodexCodeModeTextOutput([
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: "hello\n" },
      ]),
    ).toBe("Script completed\nOutput:\nhello\n");
  });

  it("preserves mixed-media results for the generic normalizer", () => {
    expect(
      extractCodexCodeModeTextOutput([
        { type: "input_text", text: "image" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ]),
    ).toBeUndefined();
  });
});
