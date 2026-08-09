import {
  PROMPT_SUGGESTION_MODES,
  type PromptSuggestionMode,
  clampRecapAfterSeconds,
} from "@yep-anywhere/shared";

export interface SessionMetadataPatch {
  title?: string;
  archived?: boolean;
  starred?: boolean;
  parentSessionId?: string | null;
  heartbeatTurnsEnabled?: boolean;
  wakeTurnsEnabled?: boolean | null;
  heartbeatTurnsAfterMinutes?: number | null;
  heartbeatTurnText?: string | null;
  heartbeatForceAfterMinutes?: number | null;
  promptSuggestionMode?: PromptSuggestionMode | null;
  recapAfterSeconds?: number | null;
}

interface SessionMetadataPatchBody {
  title?: string;
  archived?: boolean;
  starred?: boolean;
  parentSessionId?: string | null;
  heartbeatTurnsEnabled?: boolean;
  wakeTurnsEnabled?: unknown;
  heartbeatTurnsAfterMinutes?: number | null;
  heartbeatTurnText?: string | null;
  heartbeatForceAfterMinutes?: number | null;
  promptSuggestionMode?: unknown;
  recapAfterSeconds?: unknown;
}

type ParseSessionMetadataPatchResult =
  | {
      ok: true;
      patch: SessionMetadataPatch;
    }
  | {
      ok: false;
      status: 400;
      error: string;
    };

function metadataPatchBody(body: unknown): SessionMetadataPatchBody {
  return typeof body === "object" && body !== null
    ? (body as SessionMetadataPatchBody)
    : {};
}

function invalidPatch(error: string): ParseSessionMetadataPatchResult {
  return { ok: false, status: 400, error };
}

function parseHeartbeatMinutes(
  value: number | null | undefined,
  fieldName: "heartbeatForceAfterMinutes" | "heartbeatTurnsAfterMinutes",
): { value: number | null | undefined; error?: string } {
  if (value === undefined) {
    return { value: undefined };
  }
  if (value === null || value === 0) {
    return { value: null };
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 1440
  ) {
    return { value };
  }
  return {
    value: undefined,
    error: `${fieldName} must be null or an integer between 1 and 1440`,
  };
}

export function parseSessionMetadataPatch(
  rawBody: unknown,
): ParseSessionMetadataPatchResult {
  const body = metadataPatchBody(rawBody);

  // At least one field must be provided.
  if (
    body.title === undefined &&
    body.archived === undefined &&
    body.starred === undefined &&
    body.parentSessionId === undefined &&
    body.heartbeatTurnsEnabled === undefined &&
    body.wakeTurnsEnabled === undefined &&
    body.heartbeatTurnsAfterMinutes === undefined &&
    body.heartbeatTurnText === undefined &&
    body.heartbeatForceAfterMinutes === undefined &&
    body.promptSuggestionMode === undefined &&
    body.recapAfterSeconds === undefined
  ) {
    return invalidPatch("At least one session metadata field must be provided");
  }

  const parsedHeartbeatForceAfterMinutes = parseHeartbeatMinutes(
    body.heartbeatForceAfterMinutes,
    "heartbeatForceAfterMinutes",
  );

  if (
    body.wakeTurnsEnabled !== undefined &&
    body.wakeTurnsEnabled !== null &&
    typeof body.wakeTurnsEnabled !== "boolean"
  ) {
    return invalidPatch("wakeTurnsEnabled must be a boolean or null");
  }
  if (parsedHeartbeatForceAfterMinutes.error) {
    return invalidPatch(parsedHeartbeatForceAfterMinutes.error);
  }

  const parsedHeartbeatTurnsAfterMinutes = parseHeartbeatMinutes(
    body.heartbeatTurnsAfterMinutes,
    "heartbeatTurnsAfterMinutes",
  );
  if (parsedHeartbeatTurnsAfterMinutes.error) {
    return invalidPatch(parsedHeartbeatTurnsAfterMinutes.error);
  }

  const heartbeatTurnText =
    body.heartbeatTurnText === undefined
      ? undefined
      : body.heartbeatTurnText === null || body.heartbeatTurnText === ""
        ? null
        : typeof body.heartbeatTurnText === "string"
          ? body.heartbeatTurnText.slice(0, 200)
          : null;

  if (
    body.heartbeatTurnText !== undefined &&
    body.heartbeatTurnText !== null &&
    body.heartbeatTurnText !== "" &&
    typeof body.heartbeatTurnText !== "string"
  ) {
    return invalidPatch("heartbeatTurnText must be a string or null");
  }

  if (
    body.parentSessionId !== undefined &&
    body.parentSessionId !== null &&
    typeof body.parentSessionId !== "string"
  ) {
    return invalidPatch("parentSessionId must be a string or null");
  }

  const parentSessionId =
    body.parentSessionId === undefined
      ? undefined
      : typeof body.parentSessionId === "string"
        ? body.parentSessionId.trim() || null
        : null;

  // promptSuggestionMode: null/"" clears the preference (revert to default);
  // a valid enum value is stored; any other value is rejected.
  let promptSuggestionMode: PromptSuggestionMode | null | undefined;
  if (body.promptSuggestionMode !== undefined) {
    if (
      body.promptSuggestionMode === null ||
      body.promptSuggestionMode === ""
    ) {
      promptSuggestionMode = null;
    } else if (
      typeof body.promptSuggestionMode === "string" &&
      PROMPT_SUGGESTION_MODES.includes(
        body.promptSuggestionMode as PromptSuggestionMode,
      )
    ) {
      promptSuggestionMode = body.promptSuggestionMode as PromptSuggestionMode;
    } else {
      return invalidPatch("promptSuggestionMode must be one of: off, native");
    }
  }

  let recapAfterSeconds: number | null | undefined;
  if (body.recapAfterSeconds !== undefined) {
    if (body.recapAfterSeconds === null || body.recapAfterSeconds === "") {
      recapAfterSeconds = null;
    } else if (
      typeof body.recapAfterSeconds === "number" &&
      Number.isFinite(body.recapAfterSeconds)
    ) {
      recapAfterSeconds = clampRecapAfterSeconds(body.recapAfterSeconds);
    } else {
      return invalidPatch("recapAfterSeconds must be null or a finite number");
    }
  }

  return {
    ok: true,
    patch: {
      title: body.title,
      archived: body.archived,
      starred: body.starred,
      parentSessionId,
      heartbeatTurnsEnabled: body.heartbeatTurnsEnabled,
      wakeTurnsEnabled: body.wakeTurnsEnabled as boolean | null | undefined,
      heartbeatTurnsAfterMinutes: parsedHeartbeatTurnsAfterMinutes.value,
      heartbeatTurnText,
      heartbeatForceAfterMinutes: parsedHeartbeatForceAfterMinutes.value,
      promptSuggestionMode,
      recapAfterSeconds,
    },
  };
}
