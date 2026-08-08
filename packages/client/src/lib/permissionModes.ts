import type { ModelInfo, PermissionMode } from "@yep-anywhere/shared";

export const BASE_PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

export const AUTO_PERMISSION_MODE: PermissionMode = "auto";

export type PersistentEditApprovalResponse = "approve" | "approve_accept_edits";

export function getPersistentEditApprovalResponse(
  mode: PermissionMode,
): PersistentEditApprovalResponse {
  return mode === "bypassPermissions" ? "approve" : "approve_accept_edits";
}

export function modelSupportsAutoPermissionMode(
  model?: ModelInfo | null,
): boolean {
  return model?.supportsAutoMode === true;
}

export function getPermissionModeOptions(params?: {
  model?: ModelInfo | null;
  currentMode?: PermissionMode | null;
}): PermissionMode[] {
  const modes = [...BASE_PERMISSION_MODE_ORDER];
  if (modelSupportsAutoPermissionMode(params?.model)) {
    modes.push(AUTO_PERMISSION_MODE);
  }
  const currentMode = params?.currentMode;
  if (currentMode && !modes.includes(currentMode)) {
    modes.push(currentMode);
  }
  return modes;
}
