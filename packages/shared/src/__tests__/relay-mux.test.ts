import { describe, expect, it } from "vitest";
import {
  RELAY_MUX_HEADER_BYTES,
  RelayMuxFrameError,
  decodeRelayMuxDataFrame,
  encodeRelayMuxDataFrame,
  isRelayMuxClose,
  isRelayMuxOpen,
} from "../relay-mux.js";

describe("relay mux framing", () => {
  it("round-trips text and binary payload metadata", () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const encoded = encodeRelayMuxDataFrame(0x1020_3040, payload, true);
    const decoded = decodeRelayMuxDataFrame(encoded);

    expect(encoded).toHaveLength(RELAY_MUX_HEADER_BYTES + payload.byteLength);
    expect(decoded).toEqual({
      circuitId: 0x1020_3040,
      isBinary: true,
      payload,
    });
  });

  it("rejects malformed versions, flags, and circuit ids", () => {
    const frame = encodeRelayMuxDataFrame(
      1,
      new TextEncoder().encode("hello"),
      false,
    );

    const wrongVersion = frame.slice();
    wrongVersion[0] = 2;
    expect(() => decodeRelayMuxDataFrame(wrongVersion)).toThrow(
      RelayMuxFrameError,
    );

    const wrongFlags = frame.slice();
    wrongFlags[1] = 2;
    expect(() => decodeRelayMuxDataFrame(wrongFlags)).toThrow(
      RelayMuxFrameError,
    );

    const zeroCircuit = frame.slice();
    zeroCircuit.fill(0, 2, 6);
    expect(() => decodeRelayMuxDataFrame(zeroCircuit)).toThrow(
      RelayMuxFrameError,
    );
  });

  it("validates circuit controls strictly", () => {
    expect(
      isRelayMuxOpen({
        type: "mux_open",
        circuitId: 1,
        username: "alice",
        channel: "app",
      }),
    ).toBe(true);
    expect(
      isRelayMuxOpen({
        type: "mux_open",
        circuitId: 0,
        username: "alice",
        channel: "app",
      }),
    ).toBe(false);
    expect(isRelayMuxClose({ type: "mux_close", circuitId: 1 })).toBe(true);
  });
});
