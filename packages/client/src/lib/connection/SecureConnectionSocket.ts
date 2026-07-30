/**
 * The WebSocket surface required by SecureConnection.
 *
 * Native WebSocket and relay mux logical circuits both implement this narrow
 * boundary. Keeping it explicit avoids pretending a logical circuit is a full
 * browser WebSocket/EventTarget.
 */
export interface SecureConnectionSocket {
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  readonly readyState: number;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
}
