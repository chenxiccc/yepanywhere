export const PUSH_INTENTS = [
  "approval_required",
  "input_required",
  "session_completed",
  "session_failed",
] as const;

export type PushIntent = (typeof PUSH_INTENTS)[number];

export const PUSH_TARGET_KINDS = ["fid", "registration_token"] as const;

export type PushTargetKind = (typeof PUSH_TARGET_KINDS)[number];

export interface PushTarget {
  provider: "fcm";
  kind: PushTargetKind;
  value: string;
}

export interface PushMessage {
  title: string;
  body: string;
  intent: PushIntent;
  subscriptionId: string;
}

export interface PushDelivery {
  target: PushTarget;
  message: PushMessage;
}

export type PushDeliveryResult =
  | { status: "accepted"; providerMessageId?: string }
  | { status: "invalid_target" }
  | { status: "retryable_failure" }
  | { status: "rejected" };

export interface PushProvider {
  readonly name: string;
  send(delivery: PushDelivery): Promise<PushDeliveryResult>;
  close?(): Promise<void>;
}
