import type {
  UserMessageCompositionMetadata,
  UserMessageDeliveryIntent,
  UserMessageSpeechMetadata,
} from "@yep-anywhere/shared";

export interface MessageSubmissionMetadata {
  deliveryIntent: UserMessageDeliveryIntent;
  patienceSeconds?: number;
  steerNow?: boolean;
  composition: UserMessageCompositionMetadata;
  speech?: UserMessageSpeechMetadata;
}
