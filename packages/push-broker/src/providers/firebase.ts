import {
  applicationDefault,
  deleteApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import {
  type Message,
  type Messaging,
  getMessaging,
} from "firebase-admin/messaging";
import type {
  PushDelivery,
  PushDeliveryResult,
  PushProvider,
} from "../types.js";

const FIREBASE_APP_NAME = "yep-push-broker";

export interface FirebaseMessagingClient {
  send(message: Message): Promise<string>;
}

export class FirebasePushProvider implements PushProvider {
  readonly name = "fcm";

  constructor(
    private readonly messaging: FirebaseMessagingClient,
    private readonly closeProvider?: () => Promise<void>,
  ) {}

  async send(delivery: PushDelivery): Promise<PushDeliveryResult> {
    if (delivery.target.provider !== "fcm") {
      return { status: "rejected" };
    }

    try {
      const providerMessageId = await this.messaging.send(
        buildFirebaseMessage(delivery),
      );
      return { status: "accepted", providerMessageId };
    } catch (error) {
      return classifyFirebaseError(error);
    }
  }

  async close(): Promise<void> {
    await this.closeProvider?.();
  }
}

export function createFirebasePushProvider(
  projectId: string,
): FirebasePushProvider {
  const existingApp = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  const app =
    existingApp ??
    initializeApp(
      {
        credential: applicationDefault(),
        projectId,
      },
      FIREBASE_APP_NAME,
    );
  const messaging: Messaging = getMessaging(app);

  return new FirebasePushProvider(
    messaging,
    existingApp ? undefined : () => deleteApp(app),
  );
}

function buildFirebaseMessage(delivery: PushDelivery): Message {
  const common = {
    notification: {
      title: delivery.message.title,
      body: delivery.message.body,
    },
    data: {
      intent: delivery.message.intent,
      subscriptionId: delivery.message.subscriptionId,
    },
  };

  if (delivery.target.kind === "fid") {
    return {
      ...common,
      fid: delivery.target.value,
    };
  }

  return {
    ...common,
    token: delivery.target.value,
  };
}

function classifyFirebaseError(error: unknown): PushDeliveryResult {
  const code = readFirebaseErrorCode(error);
  if (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  ) {
    return { status: "invalid_target" };
  }
  if (
    code === "messaging/server-unavailable" ||
    code === "messaging/internal-error" ||
    code === "messaging/unknown-error" ||
    code === "messaging/quota-exceeded"
  ) {
    return { status: "retryable_failure" };
  }
  return { status: "rejected" };
}

function readFirebaseErrorCode(error: unknown): string | undefined {
  if (
    error === null ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  return error.code;
}
