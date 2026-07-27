import type {
  ClaudeSessionEntry,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { buildDag } from "../sessions/dag.js";
import type { ISessionReader } from "../sessions/types.js";

const CLAUDE_RESUME_API_ERROR_RECOVERY = "handoff-required";
const CLAUDE_RESUME_API_ERROR_MESSAGE =
  "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.";

export interface ClaudeResumeApiErrorBlocker {
  error: string;
  recovery: "handoff-required";
  messageId?: string;
  apiErrorStatus?: unknown;
  /**
   * Transcript UUID of the last assistant message before the API-error tail.
   * When present, the session is recoverable by resuming up to this message
   * (SDK `resumeSessionAt`) instead of requiring a handoff.
   */
  resumeAtMessageId?: string;
}

function getClaudeResumeApiErrorBlocker(
  messages: ClaudeSessionEntry[],
): ClaudeResumeApiErrorBlocker | null {
  const { activeBranch } = buildDag(messages);

  for (let i = activeBranch.length - 1; i >= 0; i--) {
    const raw = activeBranch[i]?.raw;
    if (raw?.type !== "assistant") {
      continue;
    }

    if (raw.isApiErrorMessage !== true) {
      return null;
    }

    const apiError = raw as ClaudeSessionEntry & {
      apiErrorStatus?: unknown;
    };
    // Walk further back past the API-error tail for the last good assistant
    // message; its transcript uuid is a safe prefix-resume point.
    let resumeAtMessageId: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const prior = activeBranch[j]?.raw;
      if (prior?.type !== "assistant") {
        continue;
      }
      if (prior.isApiErrorMessage === true) {
        continue;
      }
      resumeAtMessageId = prior.uuid;
      break;
    }
    return {
      error: CLAUDE_RESUME_API_ERROR_MESSAGE,
      recovery: CLAUDE_RESUME_API_ERROR_RECOVERY,
      messageId: raw.message.id,
      apiErrorStatus: apiError.apiErrorStatus,
      resumeAtMessageId,
    };
  }

  return null;
}

export async function getClaudeResumeBlockerFromReader(
  reader: ISessionReader,
  sessionId: string,
  projectId: UrlProjectId,
): Promise<ClaudeResumeApiErrorBlocker | null> {
  const session = await reader.getSession(sessionId, projectId);
  if (!session) {
    return null;
  }
  switch (session.data.provider) {
    case "claude":
    case "claude-gateway":
    case "claude-ollama":
      return getClaudeResumeApiErrorBlocker(session.data.session.messages);
    default:
      return null;
  }
}
