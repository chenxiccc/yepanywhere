import type { Message } from "firebase-admin/messaging";
import { describe, expect, it } from "vitest";
import {
  type FirebaseMessagingClient,
  FirebasePushProvider,
} from "../src/providers/firebase.js";
import type { PushDelivery } from "../src/types.js";

function makeDelivery(
  kind: "fid" | "registration_token",
): PushDelivery {
  return {
    target: {
      provider: "fcm",
      kind,
      value: `${kind}-value`,
    },
    message: {
      title: "Yep Anywhere",
      body: "Open Yep Anywhere for an update.",
      intent: "approval_required",
      subscriptionId: "subscription-id",
    },
  };
}

class MessagingClient implements FirebaseMessagingClient {
  readonly messages: Message[] = [];
  result: string | Error = "projects/test/messages/1";

  async send(message: Message): Promise<string> {
    this.messages.push(message);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class FirebaseCodeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

describe("FirebasePushProvider", () => {
  it("maps FIDs without exposing the target in data", async () => {
    const client = new MessagingClient();
    const provider = new FirebasePushProvider(client);

    await expect(provider.send(makeDelivery("fid"))).resolves.toEqual({
      status: "accepted",
      providerMessageId: "projects/test/messages/1",
    });
    expect(client.messages[0]).toEqual({
      fid: "fid-value",
      notification: {
        title: "Yep Anywhere",
        body: "Open Yep Anywhere for an update.",
      },
      data: {
        intent: "approval_required",
        subscriptionId: "subscription-id",
      },
    });
  });

  it("maps legacy registration-token targets", async () => {
    const client = new MessagingClient();
    const provider = new FirebasePushProvider(client);

    await provider.send(makeDelivery("registration_token"));

    expect(client.messages[0]).toMatchObject({
      token: "registration_token-value",
    });
  });

  it("classifies only known target and retryable failures", async () => {
    const client = new MessagingClient();
    const provider = new FirebasePushProvider(client);

    client.result = new FirebaseCodeError(
      "messaging/registration-token-not-registered",
    );
    await expect(provider.send(makeDelivery("fid"))).resolves.toEqual({
      status: "invalid_target",
    });

    client.result = new FirebaseCodeError("messaging/server-unavailable");
    await expect(provider.send(makeDelivery("fid"))).resolves.toEqual({
      status: "retryable_failure",
    });

    client.result = new FirebaseCodeError("messaging/invalid-argument");
    await expect(provider.send(makeDelivery("fid"))).resolves.toEqual({
      status: "rejected",
    });
  });

  it("closes an owned provider resource", async () => {
    const client = new MessagingClient();
    let closed = false;
    const provider = new FirebasePushProvider(client, async () => {
      closed = true;
    });

    await provider.close();

    expect(closed).toBe(true);
  });
});
