interface BrowserDebugScriptBridge {
  started: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const BRIDGE_PREFIX = "__YA_BROWSER_DEBUG_EVAL__";
export const BROWSER_DEBUG_EVAL_LOCAL_TIMEOUT_MS = 50_000;
let bridgeSequence = 0;

function scriptSource(
  bridgeKey: string,
  code: string,
  mode: "expression" | "statements",
): string {
  const bridge = `globalThis[${JSON.stringify(bridgeKey)}]`;
  const evaluation =
    mode === "expression"
      ? `await (\n${code}\n)`
      : `await (async () => {\n${code}\n})()`;
  return `${bridge}.started = true;
void (async () => {
  try {
    ${bridge}.resolve(${evaluation});
  } catch (error) {
    ${bridge}.reject(error);
  }
})();
//# sourceURL=yep-browser-debug-${mode}.js`;
}

/**
 * Execute an explicitly granted browser-debug command without `eval` or
 * `Function`. YA's served-page CSP permits inline scripts while deliberately
 * denying runtime compilation, so a short-lived script element is the narrow
 * execution boundary that preserves that policy.
 */
export function executeBrowserDebugCode(
  code: string,
  timeoutMs = BROWSER_DEBUG_EVAL_LOCAL_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bridgeKey = `${BRIDGE_PREFIX}${Date.now()}_${bridgeSequence++}`;
    const debugGlobal = globalThis as unknown as Record<string, unknown>;
    let scriptError: unknown = null;
    let policyViolation = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
      window.removeEventListener("error", onScriptError);
      document.removeEventListener(
        "securitypolicyviolation",
        onPolicyViolation,
      );
      delete debugGlobal[bridgeKey];
    };
    const settle = (outcome: "resolve" | "reject", value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome === "resolve") resolve(value);
      else reject(value);
    };
    const bridge: BrowserDebugScriptBridge = {
      started: false,
      resolve: (value) => settle("resolve", value),
      reject: (error) => settle("reject", error),
    };
    const onScriptError = (event: ErrorEvent) => {
      if (bridge.started) return;
      scriptError = event.error ?? new SyntaxError(event.message);
    };
    const onPolicyViolation = (event: SecurityPolicyViolationEvent) => {
      if (event.violatedDirective !== "script-src-elem") return;
      policyViolation = true;
    };
    const run = (mode: "expression" | "statements") => {
      bridge.started = false;
      scriptError = null;
      const script = document.createElement("script");
      script.dataset.yaBrowserDebugEval = mode;
      script.textContent = scriptSource(bridgeKey, code, mode);
      document.documentElement.append(script);
      script.remove();
    };

    debugGlobal[bridgeKey] = bridge;
    window.addEventListener("error", onScriptError);
    document.addEventListener("securitypolicyviolation", onPolicyViolation);
    deadline = setTimeout(
      () =>
        settle(
          "reject",
          new Error(
            `Browser diagnostic evaluation exceeded its ${timeoutMs} ms local deadline`,
          ),
        ),
      timeoutMs,
    );

    run("expression");
    if (bridge.started) return;

    run("statements");
    if (bridge.started) return;

    settle(
      "reject",
      policyViolation
        ? new Error(
            "Browser diagnostic evaluation is unavailable under this page's Content Security Policy",
          )
        : (scriptError ??
            new SyntaxError(
              "Browser diagnostic JavaScript could not be parsed",
            )),
    );
  });
}
