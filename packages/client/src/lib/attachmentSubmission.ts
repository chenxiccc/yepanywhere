import {
  ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
  type ServerCapabilitySource,
  serverHasCapability,
} from "@yep-anywhere/shared";

export function requiresAttachmentOnlyServerUpdate({
  version,
  text,
  attachmentCount,
}: {
  version: ServerCapabilitySource | null | undefined;
  text: string;
  attachmentCount: number;
}): boolean {
  return (
    attachmentCount > 0 &&
    !text.trim() &&
    !serverHasCapability(
      version ?? undefined,
      ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
    )
  );
}
