import { z } from "zod";

export const SECURITY_CLIENT_AUDIT_CAPABILITY = "security-client-audit-v1";
export const NATIVE_PUSH_SUBSCRIPTIONS_CAPABILITY =
  "native-push-subscriptions-v1";

export const SECURITY_CLIENT_DESCRIPTOR_VERSION = 1;
export const SECURITY_CLIENT_KEY_PROTOCOL = "client-key-p256-v1";
export const SECURITY_CLIENT_PROOF_DOMAIN = "yep-security-client-key-v1";
export const SECURITY_CLIENT_MAX_BODY_BYTES = 8 * 1024;
export const SECURITY_CLIENT_MAX_OBSERVATIONS = 256;
export const SECURITY_EVENT_MAX_ENTRIES = 512;
export const SECURITY_EVENT_MAX_FAILURE_ENTRIES = 128;
export const SECURITY_EVENT_ANCHOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SECURITY_EVENT_ALERT_SUPPRESSION_MS = 15 * 60 * 1000;

export const SECURITY_CLIENT_REGISTER_ROUTE =
  "/api/security/clients/register";
export const SECURITY_CLIENT_EVENTS_ROUTE = "/api/security/events";

export function securityClientCheckInRoute(clientId: string): string {
  return `/api/security/clients/${clientId}/check-in`;
}

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => boundedText(max).optional();
const base64Url = (max: number) =>
  z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const sha256Digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const dateTime = z.iso.datetime({ offset: true });

export const SecurityClientKindSchema = z.enum([
  "android-native",
  "web",
  "desktop-macos",
  "desktop-windows",
  "desktop-linux",
  "ios-native",
]);
export type SecurityClientKind = z.infer<typeof SecurityClientKindSchema>;

export const SecurityClientDeviceClassSchema = z.enum([
  "phone",
  "tablet",
  "foldable",
  "desktop",
  "laptop",
  "browser",
  "tv",
  "wearable",
  "automotive",
  "virtual",
  "unknown",
]);
export type SecurityClientDeviceClass = z.infer<
  typeof SecurityClientDeviceClassSchema
>;

export const SecurityClientSupportedProofSchema = z.enum([
  "continuity-key",
  "android-key-attestation",
  "play-integrity",
  "webauthn",
  "platform-keystore",
]);
export type SecurityClientSupportedProof = z.infer<
  typeof SecurityClientSupportedProofSchema
>;

const commonDescriptorFields = {
  installationId: boundedText(128),
  deviceClass: SecurityClientDeviceClassSchema,
  deviceName: optionalText(160),
  appName: boundedText(128),
  appVersion: boundedText(128),
  appBuild: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  buildChannel: optionalText(128),
  locale: optionalText(64),
  languages: z.array(boundedText(64)).max(16).optional(),
  timeZone: optionalText(128),
  supportedProofs: z.array(SecurityClientSupportedProofSchema).max(8),
} as const;

export const AndroidSecurityClientDescriptorSchema = z
  .object({
    ...commonDescriptorFields,
    manufacturer: optionalText(128),
    brand: optionalText(128),
    model: optionalText(160),
    product: optionalText(160),
    androidIdDigest: sha256Digest.optional(),
    osName: z.literal("Android"),
    osVersion: boundedText(128),
    osApiLevel: z.number().int().min(1).max(10_000),
    osBuildFingerprint: optionalText(1024),
    securityPatch: optionalText(64),
    packageName: boundedText(256),
    installerSource: optionalText(256),
    signingCertificateDigest: sha256Digest.optional(),
    firstInstallAt: dateTime.optional(),
    lastUpdateAt: dateTime.optional(),
  })
  .strict();

const BrowserBrandSchema = z
  .object({
    brand: boundedText(128),
    version: boundedText(64),
  })
  .strict();

export const WebSecurityClientDescriptorSchema = z
  .object({
    ...commonDescriptorFields,
    origin: z.url().max(2048),
    userAgent: boundedText(1024),
    browserBrands: z.array(BrowserBrandSchema).max(16).optional(),
    platform: optionalText(256),
    platformVersion: optionalText(128),
    architecture: optionalText(64),
    bitness: optionalText(32),
    mobile: z.boolean().optional(),
    screenWidth: z.number().int().min(1).max(100_000).optional(),
    screenHeight: z.number().int().min(1).max(100_000).optional(),
    devicePixelRatio: z.number().positive().max(100).optional(),
    maxTouchPoints: z.number().int().min(0).max(100).optional(),
    hardwareConcurrency: z.number().int().min(1).max(4096).optional(),
    deviceMemoryGiB: z.number().positive().max(4096).optional(),
  })
  .strict();

export const DesktopSecurityClientDescriptorSchema = z
  .object({
    ...commonDescriptorFields,
    osName: boundedText(64),
    osVersion: boundedText(128),
    osArchitecture: optionalText(64),
    packageName: optionalText(256),
    signingCertificateDigest: sha256Digest.optional(),
  })
  .strict();

export const IosSecurityClientDescriptorSchema = z
  .object({
    ...commonDescriptorFields,
    manufacturer: z.literal("Apple"),
    model: optionalText(160),
    systemName: z.enum(["iOS", "iPadOS"]),
    osVersion: boundedText(128),
    packageName: boundedText(256),
    signingCertificateDigest: sha256Digest.optional(),
  })
  .strict();

export const SecurityClientDescriptorSchema = z.union([
  AndroidSecurityClientDescriptorSchema,
  WebSecurityClientDescriptorSchema,
  DesktopSecurityClientDescriptorSchema,
  IosSecurityClientDescriptorSchema,
]);
export type SecurityClientDescriptor = z.infer<
  typeof SecurityClientDescriptorSchema
>;

export const SecurityClientKeyRegistrationSchema = z
  .object({
    protocol: z.literal(SECURITY_CLIENT_KEY_PROTOCOL),
    publicKeySpki: base64Url(1024),
    signature: base64Url(512),
    reportedStorage: z.enum([
      "android-keystore",
      "webcrypto-indexeddb",
      "tauri-webcrypto",
      "ios-keychain",
      "platform-keystore",
    ]),
  })
  .strict();

const registerFields = {
  requestId: z.uuid(),
  label: boundedText(160),
  descriptorVersion: z.literal(SECURITY_CLIENT_DESCRIPTOR_VERSION),
  key: SecurityClientKeyRegistrationSchema,
} as const;

export const RegisterSecurityClientRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        ...registerFields,
        kind: z.literal("android-native"),
        descriptor: AndroidSecurityClientDescriptorSchema,
      })
      .strict(),
    z
      .object({
        ...registerFields,
        kind: z.literal("web"),
        descriptor: WebSecurityClientDescriptorSchema,
      })
      .strict(),
    z
      .object({
        ...registerFields,
        kind: z.literal("desktop-macos"),
        descriptor: DesktopSecurityClientDescriptorSchema,
      })
      .strict(),
    z
      .object({
        ...registerFields,
        kind: z.literal("desktop-windows"),
        descriptor: DesktopSecurityClientDescriptorSchema,
      })
      .strict(),
    z
      .object({
        ...registerFields,
        kind: z.literal("desktop-linux"),
        descriptor: DesktopSecurityClientDescriptorSchema,
      })
      .strict(),
    z
      .object({
        ...registerFields,
        kind: z.literal("ios-native"),
        descriptor: IosSecurityClientDescriptorSchema,
      })
      .strict(),
  ],
);
export type RegisterSecurityClientRequest = z.infer<
  typeof RegisterSecurityClientRequestSchema
>;

export const CheckInSecurityClientRequestSchema = z
  .object({
    descriptorVersion: z.literal(SECURITY_CLIENT_DESCRIPTOR_VERSION),
    descriptor: SecurityClientDescriptorSchema,
    signature: base64Url(512),
  })
  .strict();
export type CheckInSecurityClientRequest = z.infer<
  typeof CheckInSecurityClientRequestSchema
>;

export const PatchSecurityClientRequestSchema = z
  .object({ ownerLabel: boundedText(160).nullable() })
  .strict();
export type PatchSecurityClientRequest = z.infer<
  typeof PatchSecurityClientRequestSchema
>;

export const SecurityClientAssuranceSchema = z.enum([
  "authenticated-session",
  "client-key-verified",
  "hardware-attested",
  "platform-attested",
]);
export type SecurityClientAssurance = z.infer<
  typeof SecurityClientAssuranceSchema
>;

export type SecurityClientAuthenticationMethod =
  | "srp-full"
  | "srp-resume"
  | "cookie"
  | "desktop";

export type SecurityClientTransport = "direct" | "relay" | "http";

export interface SecurityClientSessionSummary {
  sessionId: string;
  createdAt: string;
  lastUsed: string;
  lastConnectedAt?: string;
}

export interface SecurityClientPublicPushState {
  enabled: boolean;
  privacyMode?: "generic";
  brokerUrl?: string;
  subscriptionId?: string;
  updatedAt?: string;
  lastTestAt?: string;
  lastDeliveryAt?: string;
  lastFailureAt?: string;
}

export type SecurityClientProofType =
  | "continuity-key"
  | "android-key-attestation"
  | "play-integrity"
  | "webauthn"
  | "platform-keystore";

export interface SecurityClientProofSummary {
  proofId: string;
  type: SecurityClientProofType;
  protocol: string;
  status: "active" | "retired" | "revoked";
  assurance: SecurityClientAssurance;
  keyFingerprint?: string;
  reportedStorage?: string;
  addedAt: string;
  lastVerifiedAt?: string;
}

export interface SecurityClientSummary {
  clientId: string;
  kind: SecurityClientKind | "legacy-web";
  reportedLabel: string;
  ownerLabel?: string;
  displayLabel: string;
  descriptorVersion: number;
  descriptor: SecurityClientDescriptor;
  assurance: SecurityClientAssurance;
  proofs: SecurityClientProofSummary[];
  createdAt: string;
  lastSeenAt: string;
  descriptorUpdatedAt: string;
  revokedAt?: string;
  lastAuthenticationMethod?: SecurityClientAuthenticationMethod;
  lastTransport?: SecurityClientTransport;
  lastPeerAddress?: string;
  activeConnectionCount: number;
  sessions: SecurityClientSessionSummary[];
  push: SecurityClientPublicPushState;
  legacyBrowserProfileId?: string;
}

export type SecurityClientAuditEventType =
  | "registered"
  | "checked-in"
  | "descriptor-changed"
  | "owner-label-changed"
  | "continuity-proof-failed"
  | "push-enabled"
  | "push-disabled"
  | "push-tested"
  | "push-delivered"
  | "push-failed"
  | "resume-session-evicted"
  | "revoked";

export interface SecurityClientAuditEvent {
  eventId: string;
  type: SecurityClientAuditEventType;
  timestamp: string;
  firstOccurredAt?: string;
  count?: number;
  authenticationMethod?: SecurityClientAuthenticationMethod;
  transport?: SecurityClientTransport;
  peerAddress?: string;
  sessionId?: string;
  descriptorDigest?: string;
}

export type SecurityEventType =
  | "client-registered"
  | "client-owner-label-changed"
  | "client-revoked"
  | "client-pruned"
  | "srp-full-succeeded"
  | "srp-full-failed"
  | "continuity-proof-failed"
  | "resume-session-evicted";

export interface SecurityEventClientSnapshot {
  kind: SecurityClientKind | "legacy-web";
  reportedLabel: string;
  ownerLabel?: string;
  deviceClass: SecurityClientDeviceClass;
  manufacturer?: string;
  model?: string;
  appName: string;
  appVersion: string;
  origin?: string;
  keyFingerprint?: string;
}

export interface SecurityEvent {
  eventId: string;
  type: SecurityEventType;
  timestamp: string;
  firstOccurredAt?: string;
  count?: number;
  clientId?: string;
  clientSnapshot?: SecurityEventClientSnapshot;
  authenticationMethod?: SecurityClientAuthenticationMethod;
  transport?: SecurityClientTransport;
  peerAddress?: string;
  sessionId?: string;
}

export interface SecurityClientsResponse {
  clients: SecurityClientSummary[];
}

export interface SecurityClientResponse {
  client: SecurityClientSummary;
}

export interface SecurityClientEventsResponse {
  clientId: string;
  events: SecurityClientAuditEvent[];
}

export interface SecurityEventsResponse {
  events: SecurityEvent[];
}

export type SecurityClientErrorCode =
  | "security_client_unknown"
  | "security_client_revoked"
  | "security_client_request_conflict"
  | "security_client_audit_capacity"
  | "security_client_proof_invalid"
  | "security_client_transport_required"
  | "security_client_connection_bound";

export interface NativePushVersionInfo {
  protocolVersion: 1;
  brokerUrl: string;
  privacyModes: ["generic"];
}

export const PutNativePushSubscriptionRequestSchema = z
  .object({
    subscriptionId: boundedText(256),
    sendSecret: boundedText(512),
    privacyMode: z.literal("generic"),
  })
  .strict();
export type PutNativePushSubscriptionRequest = z.infer<
  typeof PutNativePushSubscriptionRequestSchema
>;

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

export function canonicalizeSecurityClientProofBody(value: unknown): string {
  return canonicalizeValue(value);
}

export function securityClientRegisterProofBody(
  request: RegisterSecurityClientRequest,
): unknown {
  return {
    descriptor: request.descriptor,
    descriptorVersion: request.descriptorVersion,
    key: {
      protocol: request.key.protocol,
      publicKeySpki: request.key.publicKeySpki,
      reportedStorage: request.key.reportedStorage,
    },
    kind: request.kind,
    label: request.label,
    requestId: request.requestId,
  };
}

export function securityClientCheckInProofBody(
  request: CheckInSecurityClientRequest,
): unknown {
  return {
    descriptor: request.descriptor,
    descriptorVersion: request.descriptorVersion,
  };
}

function encodeLengthPrefixed(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 4 + part.length, 0);
  const result = new Uint8Array(total);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export type SecurityClientProofOperation =
  | "register"
  | "check-in"
  | "rotate-key"
  | "upgrade-attestation";

export interface SecurityClientProofTranscriptInput {
  operation: SecurityClientProofOperation;
  route: string;
  sessionId: string;
  transportNonce: string;
  subjectId: string;
  bodyDigest: Uint8Array;
}

export function buildSecurityClientProofTranscript(
  input: SecurityClientProofTranscriptInput,
): Uint8Array {
  if (input.bodyDigest.length !== 32) {
    throw new Error("Security-client proof body digest must be 32 bytes");
  }
  const encode = (value: string) => new TextEncoder().encode(value);
  return encodeLengthPrefixed([
    encode(SECURITY_CLIENT_PROOF_DOMAIN),
    encode(input.operation),
    encode(input.route),
    encode(input.sessionId),
    encode(input.transportNonce),
    encode(input.subjectId),
    input.bodyDigest,
  ]);
}

function encodeDerInteger(coordinate: Uint8Array): Uint8Array {
  let firstNonZero = 0;
  while (
    firstNonZero < coordinate.length - 1 &&
    coordinate[firstNonZero] === 0
  ) {
    firstNonZero += 1;
  }
  const value = coordinate.subarray(firstNonZero);
  const needsSignPadding = (value[0]! & 0x80) !== 0;
  const result = new Uint8Array(2 + value.length + (needsSignPadding ? 1 : 0));
  result[0] = 0x02;
  result[1] = value.length + (needsSignPadding ? 1 : 0);
  result.set(value, needsSignPadding ? 3 : 2);
  return result;
}

/** Convert WebCrypto's fixed-width P-256 r||s signature to strict DER. */
export function p256P1363SignatureToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new Error("P-256 P1363 signature must be exactly 64 bytes");
  }
  const r = encodeDerInteger(signature.subarray(0, 32));
  const s = encodeDerInteger(signature.subarray(32));
  const result = new Uint8Array(2 + r.length + s.length);
  result[0] = 0x30;
  result[1] = r.length + s.length;
  result.set(r, 2);
  result.set(s, 2 + r.length);
  return result;
}
