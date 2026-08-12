import { createHash } from "node:crypto";

const ACCEPT_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const MAX_TURN_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_SUBMISSION_RECORDS = 10_000;
const MAX_SUBMISSION_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_SUBMISSIONS = 1_000;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorOutcome(error, fallback) {
  return error && typeof error === "object" && typeof error.outcome === "string"
    ? error.outcome
    : fallback;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function submissionFingerprint(request) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalValue({
          target: request.target,
          message: request.message,
          launch: request.launch,
        }),
      ),
    )
    .digest("hex");
}

function isTerminalRecord(record) {
  return record.type === "terminal" || record.type === "error";
}

export class ProviderRuntimeTurnLedger {
  constructor({
    resolveRuntime,
    writeReceipts = () => {},
    initialReceipts = [],
    onTerminal = () => {},
  }) {
    this.resolveRuntime = resolveRuntime;
    this.writeReceipts = writeReceipts;
    this.onTerminal = onTerminal;
    this.submissions = new Map();
    this.receipts = new Map(
      initialReceipts.map((receipt) => [receipt.submissionId, receipt]),
    );
  }

  requireSubmissionId(request) {
    const value = request.submissionId ?? request.id;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Missing submissionId");
    }
    if (value.length > 200) throw new Error("submissionId is too long");
    return value;
  }

  async open(request, socket) {
    this.prune(MAX_RETAINED_SUBMISSIONS - 1);
    const submissionId = this.requireSubmissionId(request);
    const fingerprint = submissionFingerprint(request);
    const existing = this.submissions.get(submissionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.writeDirectError(
          socket,
          request.id,
          "submission-id-conflict",
          "submissionId was already used for a different request",
        );
        return;
      }
      this.attach(existing, socket, request.id);
      return;
    }
    if (this.receipts.has(submissionId)) {
      this.writeDirectError(
        socket,
        request.id,
        "submission-id-conflict",
        "submissionId already has a retained receipt; inspect status instead",
      );
      return;
    }
    if (this.submissions.size >= MAX_RETAINED_SUBMISSIONS) {
      this.writeDirectError(
        socket,
        request.id,
        "busy",
        "Provider host session-turn ledger is at capacity",
      );
      return;
    }

    const timeoutMs = Math.min(
      Math.max(Number(request.timeoutMs) || DEFAULT_TURN_TIMEOUT_MS, 1_000),
      MAX_TURN_TIMEOUT_MS,
    );
    const submission = {
      submissionId,
      fingerprint,
      request,
      runtime: null,
      state: "pending",
      records: [],
      recordBytes: 0,
      listeners: new Set(),
      acceptedAt: undefined,
      terminalAt: undefined,
      lastProviderEventSequence: undefined,
      acceptTimer: null,
      timeout: setTimeout(() => this.timeout(submissionId), timeoutMs),
    };
    submission.timeout.unref?.();
    this.submissions.set(submissionId, submission);
    this.attach(submission, socket, request.id);

    try {
      const runtime = await this.resolveRuntime(request);
      if (submission.state !== "pending") return;
      if (!runtime) {
        this.failBeforeAcceptance(
          submission,
          "unavailable",
          "No incumbent provider runtime matches the requested target",
        );
        return;
      }
      if (runtime.activeSubmissionId) {
        this.failBeforeAcceptance(
          submission,
          "busy",
          `Provider runtime already owns submission ${runtime.activeSubmissionId}`,
        );
        return;
      }
      if (!runtime.child.connected) {
        this.failBeforeAcceptance(
          submission,
          "unavailable",
          "Provider worker control channel is unavailable",
        );
        return;
      }
      submission.runtime = runtime;
      runtime.activeSubmissionId = submissionId;
      submission.acceptTimer = setTimeout(
        () =>
          this.failBeforeAcceptance(
            submission,
            "timed-out-before-acceptance",
            "Provider worker did not accept the submission in time",
          ),
        ACCEPT_TIMEOUT_MS,
      );
      submission.acceptTimer.unref?.();
      runtime.child.send({
        type: "sessionTurn",
        submissionId,
        message: request.message,
      });
    } catch (error) {
      this.failBeforeAcceptance(
        submission,
        errorOutcome(error, "rejected"),
        errorMessage(error),
      );
    }
  }

  handleWorkerMessage(runtime, message) {
    const submissionId =
      typeof message?.submissionId === "string" ? message.submissionId : "";
    if (!submissionId) return false;
    const submission = this.submissions.get(submissionId);
    if (!submission || submission.runtime !== runtime) return false;

    switch (message.type) {
      case "sessionTurnAccepted":
        if (submission.state !== "pending") return true;
        if (submission.acceptTimer) clearTimeout(submission.acceptTimer);
        submission.acceptTimer = null;
        submission.state = "accepted";
        submission.acceptedAt = new Date().toISOString();
        try {
          this.persistReceipt(submission);
        } catch (error) {
          this.failReceiptPersistence(submission, error);
          return true;
        }
        this.append(submission, {
          type: "accepted",
          submissionId,
          runtimeId: runtime.runtimeId,
          harness: runtime.harness,
          providerSessionId: runtime.providerSessionId,
          yaSessionId: runtime.yaSessionId,
          acceptedAt: submission.acceptedAt,
        });
        return true;
      case "sessionTurnStarted":
        return true;
      case "sessionTurnEvent":
        if (submission.state !== "accepted") return true;
        submission.lastProviderEventSequence = Number(message.sequence);
        this.append(submission, {
          type: "providerEvent",
          submissionId,
          sequence: submission.lastProviderEventSequence,
          message: message.message,
        });
        return true;
      case "sessionTurnApproval":
        if (submission.state !== "accepted") return true;
        this.append(submission, {
          type: "approvalRequired",
          submissionId,
          requestId: message.requestId,
          toolName: message.toolName,
          controlledBy: message.controlledBy,
        });
        return true;
      case "sessionTurnTerminal":
        this.finish(submission, String(message.outcome ?? "provider-failed"), {
          error: message.error,
          providerSessionId:
            message.providerSessionId ?? runtime.providerSessionId,
          lastProviderEventSequence:
            message.lastProviderEventSequence ??
            submission.lastProviderEventSequence,
        });
        return true;
      case "sessionTurnRejected":
        this.failBeforeAcceptance(
          submission,
          String(message.outcome ?? "busy"),
          String(message.error ?? "Provider worker rejected the submission"),
        );
        return true;
      default:
        return false;
    }
  }

  status(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (submission) return this.publicStatus(submission);
    return this.receipts.get(submissionId) ?? null;
  }

  interrupt(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission || isTerminalRecord(submission.records.at(-1) ?? {})) {
      return { requested: false, status: this.status(submissionId) };
    }
    if (!submission.runtime?.child.connected) {
      return { requested: false, status: this.publicStatus(submission) };
    }
    submission.runtime.child.send({
      type: "interruptSessionTurn",
      submissionId,
    });
    return { requested: true, status: this.publicStatus(submission) };
  }

  runtimeEnded(runtime, outcome = "provider-failed") {
    const submissionId = runtime.activeSubmissionId;
    if (!submissionId) return;
    const submission = this.submissions.get(submissionId);
    if (submission) {
      if (submission.state === "accepted") {
        this.finish(submission, outcome, {
          error: "Provider runtime ended before a terminal result",
        });
      } else {
        this.failBeforeAcceptance(
          submission,
          "unavailable",
          "Provider runtime ended before accepting the submission",
        );
      }
    }
  }

  shutdown(outcome = "interrupted") {
    for (const submission of this.submissions.values()) {
      if (submission.state === "accepted") {
        this.finish(submission, outcome, {
          error: "Provider host shut down during the submission",
        });
      } else if (submission.state === "pending") {
        this.failBeforeAcceptance(
          submission,
          "unavailable",
          "Provider host shut down before accepting the submission",
        );
      }
    }
  }

  attach(submission, socket, requestId) {
    const listener = { socket, requestId, cursor: 0, blocked: false };
    submission.listeners.add(listener);
    const remove = () => submission.listeners.delete(listener);
    socket.once("close", remove);
    socket.once("error", remove);
    socket.on("drain", () => {
      listener.blocked = false;
      this.pump(submission, listener);
    });
    this.pump(submission, listener);
  }

  pump(submission, listener) {
    if (listener.blocked || listener.socket.destroyed) return;
    while (listener.cursor < submission.records.length) {
      const record = submission.records[listener.cursor++];
      const writable = listener.socket.write(
        `${JSON.stringify({ id: listener.requestId, ...record })}\n`,
      );
      if (!writable) {
        listener.blocked = true;
        return;
      }
    }
    if (isTerminalRecord(submission.records.at(-1) ?? {})) {
      listener.socket.end();
    }
  }

  append(submission, record) {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (
      record.type === "providerEvent" &&
      (submission.records.length >= MAX_SUBMISSION_RECORDS ||
        submission.recordBytes + bytes > MAX_SUBMISSION_BYTES)
    ) {
      if (submission.runtime?.child.connected) {
        submission.runtime.child.send({
          type: "interruptSessionTurn",
          submissionId: submission.submissionId,
        });
      }
      this.finish(submission, "uncertain-after-acceptance", {
        error: "Provider output exceeded the session-turn replay bound",
      });
      return;
    }
    submission.records.push(record);
    submission.recordBytes += bytes;
    for (const listener of submission.listeners) {
      this.pump(submission, listener);
    }
  }

  failBeforeAcceptance(submission, outcome, error) {
    if (submission.state !== "pending") return;
    submission.state = "terminal";
    submission.terminalAt = new Date().toISOString();
    this.clearTimers(submission);
    const runtime = submission.runtime;
    this.releaseRuntime(submission);
    this.append(submission, {
      type: "error",
      submissionId: submission.submissionId,
      outcome,
      accepted: false,
      error,
      terminalAt: submission.terminalAt,
    });
    this.onTerminal(runtime, outcome);
  }

  finish(submission, outcome, fields = {}) {
    if (submission.state === "terminal") return;
    const accepted = submission.state === "accepted";
    submission.state = "terminal";
    submission.terminalAt = new Date().toISOString();
    this.clearTimers(submission);
    const runtime = submission.runtime;
    this.releaseRuntime(submission);
    if (!accepted) {
      this.append(submission, {
        type: "error",
        submissionId: submission.submissionId,
        outcome,
        accepted: false,
        error: fields.error,
        terminalAt: submission.terminalAt,
      });
      this.onTerminal(runtime, outcome);
      return;
    }
    const receipt = {
      providerSessionId: fields.providerSessionId,
      lastProviderEventSequence: fields.lastProviderEventSequence,
      acceptedAt: submission.acceptedAt,
      terminalAt: submission.terminalAt,
    };
    try {
      this.persistReceipt(submission, outcome, receipt);
    } catch (error) {
      this.append(submission, {
        type: "error",
        submissionId: submission.submissionId,
        outcome: "uncertain-after-acceptance",
        accepted: true,
        error: `Could not persist the terminal receipt: ${errorMessage(error)}`,
        terminalAt: submission.terminalAt,
      });
      this.onTerminal(runtime, "uncertain-after-acceptance");
      return;
    }
    this.append(submission, {
      type: "terminal",
      submissionId: submission.submissionId,
      outcome,
      ...(fields.error ? { error: fields.error } : {}),
      receipt,
    });
    this.onTerminal(runtime, outcome);
  }

  failReceiptPersistence(submission, error) {
    submission.state = "terminal";
    submission.terminalAt = new Date().toISOString();
    this.clearTimers(submission);
    const runtime = submission.runtime;
    if (runtime?.child.connected) {
      runtime.child.send({
        type: "interruptSessionTurn",
        submissionId: submission.submissionId,
      });
    }
    this.releaseRuntime(submission);
    this.append(submission, {
      type: "error",
      submissionId: submission.submissionId,
      outcome: "uncertain-after-acceptance",
      accepted: true,
      error: `Could not persist the acceptance receipt: ${errorMessage(error)}`,
      terminalAt: submission.terminalAt,
    });
    this.onTerminal(runtime, "uncertain-after-acceptance");
  }

  timeout(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission || submission.state === "terminal") return;
    if (submission.state === "pending") {
      this.failBeforeAcceptance(
        submission,
        "timed-out-before-acceptance",
        "Session turn timed out before provider acceptance",
      );
      return;
    }
    if (submission.runtime?.child.connected) {
      submission.runtime.child.send({
        type: "interruptSessionTurn",
        submissionId,
      });
    }
    this.finish(submission, "uncertain-after-acceptance", {
      error: "Session turn timed out after provider acceptance",
    });
  }

  clearTimers(submission) {
    if (submission.acceptTimer) clearTimeout(submission.acceptTimer);
    clearTimeout(submission.timeout);
    submission.acceptTimer = null;
  }

  releaseRuntime(submission) {
    if (submission.runtime?.activeSubmissionId === submission.submissionId) {
      submission.runtime.activeSubmissionId = undefined;
    }
  }

  publicStatus(submission) {
    const terminal = submission.records.findLast(isTerminalRecord);
    return {
      submissionId: submission.submissionId,
      state: submission.state,
      accepted: Boolean(submission.acceptedAt),
      acceptedAt: submission.acceptedAt,
      terminalAt: submission.terminalAt,
      outcome: terminal?.outcome,
      receipt: terminal?.receipt,
      recordCount: submission.records.length,
    };
  }

  persistReceipt(submission, outcome, receipt) {
    const previousReceipts = new Map(this.receipts);
    this.receipts.set(submission.submissionId, {
      submissionId: submission.submissionId,
      state: submission.state,
      accepted: Boolean(submission.acceptedAt),
      acceptedAt: submission.acceptedAt,
      terminalAt: submission.terminalAt,
      outcome,
      receipt,
    });
    this.pruneReceipts();
    try {
      this.writeReceipts([...this.receipts.values()]);
    } catch (error) {
      this.receipts = previousReceipts;
      throw error;
    }
  }

  prune(maxSubmissions = MAX_RETAINED_SUBMISSIONS) {
    const terminal = [...this.submissions.values()]
      .filter((submission) => submission.state === "terminal")
      .sort((left, right) =>
        String(left.terminalAt).localeCompare(String(right.terminalAt)),
      );
    while (this.submissions.size > maxSubmissions && terminal.length) {
      const submission = terminal.shift();
      this.submissions.delete(submission.submissionId);
    }
    this.pruneReceipts();
  }

  pruneReceipts() {
    const cutoff = Date.now() - RECEIPT_TTL_MS;
    for (const [submissionId, receipt] of this.receipts) {
      const timestamp = Date.parse(
        receipt.terminalAt ?? receipt.acceptedAt ?? "",
      );
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        this.receipts.delete(submissionId);
      }
    }
    const ordered = [...this.receipts.values()].sort((left, right) =>
      String(left.terminalAt ?? left.acceptedAt).localeCompare(
        String(right.terminalAt ?? right.acceptedAt),
      ),
    );
    while (ordered.length > MAX_RETAINED_SUBMISSIONS) {
      const receipt = ordered.shift();
      this.receipts.delete(receipt.submissionId);
    }
  }

  writeDirectError(socket, id, outcome, error) {
    socket.end(
      `${JSON.stringify({
        id,
        type: "error",
        outcome,
        accepted: false,
        error,
      })}\n`,
    );
  }
}
