import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
} from "./SpeechProvider";

/** Explicit provider state when no advertised speech method can run. */
export class UnavailableSpeechProvider implements SpeechProvider {
  readonly id = "unavailable";
  readonly isSupported = false;
  private readonly state: SpeechProviderState = { ...INITIAL_SPEECH_STATE };

  getState(): SpeechProviderState {
    return this.state;
  }

  subscribe(_subscriber: SpeechProviderSubscriber): () => void {
    return () => {};
  }

  start(): void {}
  stop(): void {}
  dispose(): void {}
}
