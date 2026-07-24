import {
  BANG_COMMANDS_CAPABILITY,
  serverHasCapability,
  type ClientDefaults,
} from "@yep-anywhere/shared";

interface BangCommandAvailabilitySource {
  capabilities?: readonly string[];
  clientDefaults?: ClientDefaults;
}

export function serverSupportsBangCommands(
  source: BangCommandAvailabilitySource | null | undefined,
): boolean {
  return serverHasCapability(source, BANG_COMMANDS_CAPABILITY);
}

export function bangCommandsAreEnabled(
  source: BangCommandAvailabilitySource | null | undefined,
  clientDefaults = source?.clientDefaults,
): boolean {
  return (
    serverSupportsBangCommands(source) &&
    clientDefaults?.bangCommandsEnabled === true
  );
}
