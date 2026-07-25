import {
  BANG_COMMANDS_CAPABILITY,
  serverHasCapability,
  type ClientDefaults,
} from "@yep-anywhere/shared";

interface BangCommandAvailabilitySource {
  capabilities?: readonly string[];
  clientDefaults?: ClientDefaults;
}

/**
 * Whether `!!` execution, completions, and per-session bang routes exist on
 * this server. Execution is always-on where supported (vanilla-defaults.md
 * § Known Exceptions); only the history view below has a setting.
 */
export function serverSupportsBangCommands(
  source: BangCommandAvailabilitySource | null | undefined,
): boolean {
  return serverHasCapability(source, BANG_COMMANDS_CAPABILITY);
}

/**
 * Whether the discoverable "!! Commands" surface (sidebar entry + top-level
 * history view) is enabled — the sole default-off part of bang commands.
 */
export function bangHistoryViewEnabled(
  source: BangCommandAvailabilitySource | null | undefined,
  clientDefaults = source?.clientDefaults,
): boolean {
  return (
    serverSupportsBangCommands(source) &&
    clientDefaults?.bangCommandsEnabled === true
  );
}
