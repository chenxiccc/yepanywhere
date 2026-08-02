import { describe, expect, it } from "vitest";
import {
  RegisterSecurityClientRequestSchema,
  SECURITY_CLIENT_KEY_PROTOCOL,
  SECURITY_CLIENT_REGISTER_ROUTE,
  buildSecurityClientProofTranscript,
  canonicalizeSecurityClientProofBody,
  p256P1363SignatureToDer,
  securityClientRegisterProofBody,
  type RegisterSecurityClientRequest,
} from "../src/security-clients.js";

const digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function androidRegistration(): RegisterSecurityClientRequest {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    kind: "android-native",
    label: "Pixel",
    descriptorVersion: 1,
    descriptor: {
      installationId: "android-installation",
      deviceClass: "phone",
      manufacturer: "Google",
      brand: "google",
      model: "Pixel 7a",
      product: "lynx",
      androidIdDigest: digest,
      osName: "Android",
      osVersion: "17",
      osApiLevel: 37,
      osBuildFingerprint: "google/lynx/lynx:test/release-keys",
      securityPatch: "2026-07-05",
      appName: "Yep Anywhere",
      appVersion: "0.7.1",
      appBuild: 71,
      packageName: "com.yepanywhere.android",
      buildChannel: "debug",
      signingCertificateDigest: digest,
      locale: "en-US",
      languages: ["en-US", "de-DE"],
      timeZone: "Europe/Berlin",
      supportedProofs: ["continuity-key"],
    },
    key: {
      protocol: SECURITY_CLIENT_KEY_PROTOCOL,
      publicKeySpki: "AQID",
      signature: "BAUG",
      reportedStorage: "android-keystore",
    },
  };
}

function decodeLengthPrefixed(value: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let offset = 0;
  while (offset < value.length) {
    const length = view.getUint32(offset, false);
    offset += 4;
    parts.push(value.slice(offset, offset + length));
    offset += length;
  }
  return parts;
}

describe("security-client schemas", () => {
  it("accepts a strict Android registration", () => {
    expect(
      RegisterSecurityClientRequestSchema.parse(androidRegistration()),
    ).toEqual(androidRegistration());
  });

  it("rejects descriptor fields from another client kind", () => {
    const request = androidRegistration();
    const descriptor = {
      ...request.descriptor,
      origin: "https://example.test",
    };

    expect(
      RegisterSecurityClientRequestSchema.safeParse({
        ...request,
        descriptor,
      }).success,
    ).toBe(false);
  });

  it("rejects an Android descriptor paired with a web kind", () => {
    const request = androidRegistration();
    expect(
      RegisterSecurityClientRequestSchema.safeParse({
        ...request,
        kind: "web",
      }).success,
    ).toBe(false);
  });
});

describe("security-client proof transcript", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(
      canonicalizeSecurityClientProofBody({
        z: [3, { b: true, a: "value" }],
        a: 1,
      }),
    ).toBe('{"a":1,"z":[3,{"a":"value","b":true}]}');
  });

  it("excludes only the registration signature from the signed body", () => {
    const request = androidRegistration();
    const body = securityClientRegisterProofBody(request);
    expect(canonicalizeSecurityClientProofBody(body)).toContain(
      `"publicKeySpki":"${request.key.publicKeySpki}"`,
    );
    expect(canonicalizeSecurityClientProofBody(body)).not.toContain(
      request.key.signature,
    );
  });

  it("uses fixed-order length-prefixed transcript fields", () => {
    const bodyDigest = new Uint8Array(32).fill(0x42);
    const transcript = buildSecurityClientProofTranscript({
      operation: "register",
      route: SECURITY_CLIENT_REGISTER_ROUTE,
      sessionId: "session-id",
      transportNonce: "transport-nonce",
      subjectId: "request-id",
      bodyDigest,
    });
    const decoder = new TextDecoder();
    const parts = decodeLengthPrefixed(transcript);

    expect(parts.slice(0, 6).map((part) => decoder.decode(part))).toEqual([
      "yep-security-client-key-v1",
      "register",
      SECURITY_CLIENT_REGISTER_ROUTE,
      "session-id",
      "transport-nonce",
      "request-id",
    ]);
    expect(parts[6]).toEqual(bodyDigest);
  });

  it("requires a SHA-256-sized body digest", () => {
    expect(() =>
      buildSecurityClientProofTranscript({
        operation: "check-in",
        route: "/route",
        sessionId: "session-id",
        transportNonce: "transport-nonce",
        subjectId: "client-id",
        bodyDigest: new Uint8Array(31),
      }),
    ).toThrow("must be 32 bytes");
  });
});

describe("P-256 WebCrypto signature conversion", () => {
  it("removes redundant zeros from short positive coordinates", () => {
    const signature = new Uint8Array(64);
    signature[31] = 0x01;
    signature[63] = 0x7f;

    expect(Buffer.from(p256P1363SignatureToDer(signature)).toString("hex")).toBe(
      "300602010102017f",
    );
  });

  it("adds DER sign padding when a coordinate starts with a high bit", () => {
    const signature = new Uint8Array(64);
    signature[32] = 0x80;
    const der = p256P1363SignatureToDer(signature);

    expect(Buffer.from(der.slice(0, 8)).toString("hex")).toBe(
      "3026020100022100",
    );
    expect(der[8]).toBe(0x80);
    expect(der).toHaveLength(40);
  });

  it("rejects non-P-256 P1363 lengths", () => {
    expect(() => p256P1363SignatureToDer(new Uint8Array(63))).toThrow(
      "exactly 64 bytes",
    );
  });
});
