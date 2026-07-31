import type {
  PushDelivery,
  PushDeliveryResult,
  PushProvider,
} from "../types.js";

export class FakePushProvider implements PushProvider {
  readonly name = "fake";
  readonly deliveries: PushDelivery[] = [];
  private readonly results: PushDeliveryResult[] = [];

  enqueueResult(result: PushDeliveryResult): void {
    this.results.push(result);
  }

  async send(delivery: PushDelivery): Promise<PushDeliveryResult> {
    this.deliveries.push(structuredClone(delivery));
    return this.results.shift() ?? { status: "accepted" };
  }
}
