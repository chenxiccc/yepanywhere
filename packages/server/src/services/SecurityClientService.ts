import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AndroidSecurityClientDescriptorSchema,
  DesktopSecurityClientDescriptorSchema,
  IosSecurityClientDescriptorSchema,
  SECURITY_CLIENT_KEY_PROTOCOL,
  SECURITY_CLIENT_MAX_OBSERVATIONS,
  SECURITY_CLIENT_REGISTER_ROUTE,
  SECURITY_EVENT_ANCHOR_RETENTION_MS,
  SECURITY_EVENT_MAX_ENTRIES,
  SECURITY_EVENT_MAX_FAILURE_ENTRIES,
  SecurityClientDescriptorSchema,
  SecurityClientKindSchema,
  WebSecurityClientDescriptorSchema,
  buildSecurityClientProofTranscript,
  canonicalizeSecurityClientProofBody,
  securityClientCheckInProofBody,
  securityClientCheckInRoute,
  securityClientRegisterProofBody,
  type CheckInSecurityClientRequest,
  type LegacyWebSecurityClientDescriptor,
  type PatchSecurityClientRequest,
  type RegisterSecurityClientRequest,
  type SecurityClientAuditEvent,
  type SecurityClientDescriptor,
  type SecurityClientKind,
  type SecurityClientProofSummary,
  type SecurityClientResponse,
  type SecurityClientSummary,
  type SecurityEvent,
  type SecurityEventClientSnapshot,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import type { AuthenticatedSrpTransportContext } from "../middleware/authenticated-transport.js";
import type {
  RemoteSessionEvictionListener,
  RemoteSessionService,
} from "../remote-access/RemoteSessionService.js";
import type { PushService } from "../push/PushService.js";
import type { BrowserProfileService } from "./BrowserProfileService.js";
import type { ConnectedBrowsersService } from "./ConnectedBrowsersService.js";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";

const CURRENT_VERSION = 1;
const MAX_CLIENT_RECORDS = 200;
const FAILURE_COALESCE_MS = 15 * 60 * 1000;
const LEGACY_WEB_CLIENT_PREFIX = "legacy-web:";

type SecurityClientServiceErrorCode =
  | "security_client_unknown"
  | "security_client_revoked"
  | "security_client_request_conflict"
  | "security_client_audit_capacity"
  | "security_client_proof_invalid"
  | "security_client_transport_required"
  | "security_client_connection_bound";

export class SecurityClientServiceError extends Error {
  constructor(
    readonly code: SecurityClientServiceErrorCode,
    readonly status: 400 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
    this.name = "SecurityClientServiceError";
  }
}

interface StoredContinuityProof extends SecurityClientProofSummary {
  type: "continuity-key";
  protocol: typeof SECURITY_CLIENT_KEY_PROTOCOL;
  publicKeySpki: string;
}

interface StoredSecurityClient {
  clientId: string;
  username: string;
  kind: SecurityClientKind;
  reportedLabel: string;
  ownerLabel?: string;
  descriptorVersion: number;
  descriptor: SecurityClientDescriptor;
  descriptorDigest: string;
  proofs: StoredContinuityProof[];
  createdAt: string;
  lastSeenAt: string;
  descriptorUpdatedAt: string;
  revokedAt?: string;
  lastAuthenticationMethod?: "srp-full" | "srp-resume";
  lastTransport?: "direct" | "relay";
  lastPeerAddress?: string;
  events: SecurityClientAuditEvent[];
}

interface RegistrationIndexEntry {
  clientId: string;
  keyFingerprint: string;
  bodyDigest: string;
}

interface PersistedSecurityClientState {
  version: number;
  clients: Record<string, StoredSecurityClient>;
  registrationRequests: Record<string, RegistrationIndexEntry>;
  legacyOwnerLabels: Record<string, string>;
  revokedLegacyBrowserProfiles: Record<string, string>;
  securityEvents: SecurityEvent[];
}

interface ActiveConnectionBinding {
  clientId: string;
  operation: "register" | "check-in";
  bodyDigest: string;
  closeConnection: () => void;
}

export interface SecurityClientServiceOptions {
  dataDir: string;
  remoteSessionService: RemoteSessionService;
  browserProfileService?: BrowserProfileService;
  connectedBrowsers?: ConnectedBrowsersService;
  pushService?: PushService;
  now?: () => Date;
}

export interface RegisterSecurityClientResult extends SecurityClientResponse {
  created: boolean;
}

export interface PreparedSecurityClientRevocation
  extends SecurityClientResponse {
  alreadyRevoked: boolean;
  cascade: () => Promise<void>;
}

export interface SrpAuditFacts {
  username: string;
  sessionId?: string;
  transport: "direct" | "relay";
  peerAddress?: string;
}

function emptyState(): PersistedSecurityClientState {
  return {
    version: CURRENT_VERSION,
    clients: {},
    registrationRequests: {},
    legacyOwnerLabels: {},
    revokedLegacyBrowserProfiles: {},
    securityEvents: [],
  };
}

function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStoredProof(value: unknown): value is StoredContinuityProof {
  if (!isRecord(value)) return false;
  if (
    typeof value.proofId !== "string" ||
    value.type !== "continuity-key" ||
    value.protocol !== SECURITY_CLIENT_KEY_PROTOCOL ||
    !["active", "retired", "revoked"].includes(String(value.status)) ||
    ![
      "authenticated-session",
      "client-key-verified",
      "hardware-attested",
      "platform-attested",
    ].includes(String(value.assurance)) ||
    typeof value.publicKeySpki !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(value.keyFingerprint)) ||
    !isIsoTimestamp(value.addedAt) ||
    (value.lastVerifiedAt !== undefined &&
      !isIsoTimestamp(value.lastVerifiedAt))
  ) {
    return false;
  }
  try {
    return (
      importP256PublicKey(value.publicKeySpki).fingerprint ===
      value.keyFingerprint
    );
  } catch {
    return false;
  }
}

function isClientAuditEvent(value: unknown): value is SecurityClientAuditEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.eventId === "string" &&
    [
      "registered",
      "checked-in",
      "descriptor-changed",
      "owner-label-changed",
      "continuity-proof-failed",
      "push-enabled",
      "push-disabled",
      "push-tested",
      "push-delivered",
      "push-failed",
      "resume-session-evicted",
      "revoked",
    ].includes(String(value.type)) &&
    isIsoTimestamp(value.timestamp)
  );
}

function isSecurityEvent(value: unknown): value is SecurityEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.eventId === "string" &&
    [
      "client-registered",
      "client-owner-label-changed",
      "client-revoked",
      "client-pruned",
      "srp-full-succeeded",
      "srp-full-failed",
      "continuity-proof-failed",
      "resume-session-evicted",
    ].includes(String(value.type)) &&
    isIsoTimestamp(value.timestamp)
  );
}

function isStoredClient(value: unknown): value is StoredSecurityClient {
  if (!isRecord(value)) return false;
  const kind = SecurityClientKindSchema.safeParse(value.kind);
  const descriptor = SecurityClientDescriptorSchema.safeParse(value.descriptor);
  return (
    typeof value.clientId === "string" &&
    typeof value.username === "string" &&
    kind.success &&
    typeof value.reportedLabel === "string" &&
    value.descriptorVersion === 1 &&
    descriptor.success &&
    descriptorMatchesKind(kind.data, descriptor.data) &&
    typeof value.descriptorDigest === "string" &&
    Array.isArray(value.proofs) &&
    value.proofs.length > 0 &&
    value.proofs.every(isStoredProof) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.lastSeenAt) &&
    isIsoTimestamp(value.descriptorUpdatedAt) &&
    (value.revokedAt === undefined || isIsoTimestamp(value.revokedAt)) &&
    Array.isArray(value.events) &&
    value.events.length <= SECURITY_CLIENT_MAX_OBSERVATIONS &&
    value.events.every(isClientAuditEvent)
  );
}

function parseState(value: unknown): PersistedSecurityClientState | null {
  if (!isRecord(value) || value.version !== CURRENT_VERSION) return null;
  if (
    !isRecord(value.clients) ||
    !isRecord(value.registrationRequests) ||
    !isRecord(value.legacyOwnerLabels) ||
    !isRecord(value.revokedLegacyBrowserProfiles) ||
    !Array.isArray(value.securityEvents)
  ) {
    return null;
  }
  if (!Object.values(value.clients).every(isStoredClient)) return null;
  if (Object.keys(value.clients).length > MAX_CLIENT_RECORDS) return null;
  if (
    !Object.values(value.registrationRequests).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.clientId === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(String(entry.keyFingerprint)) &&
        /^[A-Za-z0-9_-]{43}$/.test(String(entry.bodyDigest)),
    )
  ) {
    return null;
  }
  if (Object.keys(value.registrationRequests).length > MAX_CLIENT_RECORDS) {
    return null;
  }
  if (
    !Object.values(value.legacyOwnerLabels).every(
      (ownerLabel) => typeof ownerLabel === "string",
    ) ||
    !Object.values(value.revokedLegacyBrowserProfiles).every(
      (revokedAt) =>
        typeof revokedAt === "string" && !Number.isNaN(Date.parse(revokedAt)),
    )
  ) {
    return null;
  }
  if (
    Object.keys(value.legacyOwnerLabels).length > MAX_CLIENT_RECORDS ||
    Object.keys(value.revokedLegacyBrowserProfiles).length >
      MAX_CLIENT_RECORDS ||
    value.securityEvents.length > SECURITY_EVENT_MAX_ENTRIES ||
    !value.securityEvents.every(isSecurityEvent) ||
    value.securityEvents.filter(securityEventIsFailure).length >
      SECURITY_EVENT_MAX_FAILURE_ENTRIES
  ) {
    return null;
  }
  const registrationRequests = value.registrationRequests as Record<
    string,
    RegistrationIndexEntry
  >;
  const clients = value.clients as Record<string, StoredSecurityClient>;
  for (const entry of Object.values(registrationRequests)) {
    const client = clients[entry.clientId];
    if (
      !client?.proofs.some(
        (proof) => proof.keyFingerprint === entry.keyFingerprint,
      )
    ) {
      return null;
    }
  }
  return value as unknown as PersistedSecurityClientState;
}

function descriptorMatchesKind(
  kind: SecurityClientKind,
  descriptor: SecurityClientDescriptor,
): boolean {
  switch (kind) {
    case "android-native":
      return AndroidSecurityClientDescriptorSchema.safeParse(descriptor)
        .success;
    case "web":
      return WebSecurityClientDescriptorSchema.safeParse(descriptor).success;
    case "desktop-macos":
    case "desktop-windows":
    case "desktop-linux":
      return DesktopSecurityClientDescriptorSchema.safeParse(descriptor)
        .success;
    case "ios-native":
      return IosSecurityClientDescriptorSchema.safeParse(descriptor).success;
  }
}

function importP256PublicKey(publicKeySpki: string): {
  key: KeyObject;
  fingerprint: string;
} {
  try {
    const der = Buffer.from(publicKeySpki, "base64url");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("Expected a P-256 public key");
    }
    const normalized = key.export({ format: "der", type: "spki" });
    return {
      key,
      fingerprint: sha256Base64Url(normalized),
    };
  } catch {
    throw new SecurityClientServiceError(
      "security_client_proof_invalid",
      400,
      "Invalid P-256 public key",
    );
  }
}

function verifyProof(params: {
  key: KeyObject;
  signature: string;
  operation: "register" | "check-in";
  route: string;
  subjectId: string;
  bodyDigest: Uint8Array;
  transport: AuthenticatedSrpTransportContext;
}): boolean {
  try {
    const transcript = buildSecurityClientProofTranscript({
      operation: params.operation,
      route: params.route,
      sessionId: params.transport.sessionId,
      transportNonce: params.transport.transportNonce,
      subjectId: params.subjectId,
      bodyDigest: params.bodyDigest,
    });
    return verifySignature(
      "sha256",
      transcript,
      { key: params.key, dsaEncoding: "der" },
      Buffer.from(params.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function securityEventIsFailure(event: SecurityEvent): boolean {
  return (
    event.type === "srp-full-failed" || event.type === "continuity-proof-failed"
  );
}

function securityEventIsProtectedAnchor(event: SecurityEvent): boolean {
  return event.type === "client-registered" || event.type === "client-revoked";
}

export class SecurityClientService {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly remoteSessionService: RemoteSessionService;
  private readonly browserProfileService?: BrowserProfileService;
  private readonly connectedBrowsers?: ConnectedBrowsersService;
  private readonly pushService?: PushService;
  private readonly now: () => Date;
  private state = emptyState();
  private initialized = false;
  private readonly saver = createCoalescingSaver(() => this.doSave());
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly activeConnections = new Map<
    string,
    ActiveConnectionBinding
  >();

  readonly remoteSessionEvictionListener: RemoteSessionEvictionListener =
    async (session) => {
      if (!session.securityClientId) return;
      await this.recordSessionEviction(
        session.securityClientId,
        session.sessionId,
      );
    };

  constructor(options: SecurityClientServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "security-clients.json");
    this.remoteSessionService = options.remoteSessionService;
    this.browserProfileService = options.browserProfileService;
    this.connectedBrowsers = options.connectedBrowsers;
    this.pushService = options.pushService;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[SecurityClientService]",
      );
      const parsed = parseState(
        JSON.parse(await fs.readFile(this.filePath, "utf-8")),
      );
      if (!parsed) {
        throw new Error("Unsupported or malformed security-client state");
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[SecurityClientService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = emptyState();
    }
    this.initialized = true;
    this.remoteSessionService.setEvictionListener(
      this.remoteSessionEvictionListener,
    );
  }

  async shutdown(): Promise<void> {
    this.remoteSessionService.setEvictionListener(null);
    this.activeConnections.clear();
    await this.saver.idle();
  }

  async register(
    request: RegisterSecurityClientRequest,
    transport: AuthenticatedSrpTransportContext,
  ): Promise<RegisterSecurityClientResult> {
    this.ensureInitialized();
    const proofBody = securityClientRegisterProofBody(request);
    const bodyDigestBytes = createHash("sha256")
      .update(canonicalizeSecurityClientProofBody(proofBody))
      .digest();
    const bodyDigest = bodyDigestBytes.toString("base64url");
    const importedKey = importP256PublicKey(request.key.publicKeySpki);
    if (
      !verifyProof({
        key: importedKey.key,
        signature: request.key.signature,
        operation: "register",
        route: SECURITY_CLIENT_REGISTER_ROUTE,
        subjectId: request.requestId,
        bodyDigest: bodyDigestBytes,
        transport,
      })
    ) {
      await this.recordContinuityFailure(null, transport);
      throw new SecurityClientServiceError(
        "security_client_proof_invalid",
        400,
        "Continuity proof failed",
      );
    }

    return this.mutate(async () => {
      const index = this.state.registrationRequests[request.requestId];
      if (index) {
        const client = this.state.clients[index.clientId];
        if (
          !client ||
          index.keyFingerprint !== importedKey.fingerprint ||
          index.bodyDigest !== bodyDigest
        ) {
          await this.recordContinuityFailureInMutation(
            client ?? null,
            transport,
          );
          throw new SecurityClientServiceError(
            "security_client_request_conflict",
            409,
            "Registration request id conflicts with existing state",
          );
        }
        this.assertClientActive(client);
        const repeat = await this.assertConnectionAvailable(
          transport,
          client.clientId,
          "register",
          bodyDigest,
          client,
        );
        if (!repeat) {
          await this.attachSession(client, transport);
          client.lastSeenAt = this.nowIso();
          client.lastAuthenticationMethod = transport.authenticationMethod;
          client.lastTransport = transport.transport;
          client.lastPeerAddress = transport.peerAddress;
          this.appendClientEvent(client, {
            eventId: randomUUID(),
            type: "checked-in",
            timestamp: client.lastSeenAt,
            authenticationMethod: transport.authenticationMethod,
            transport: transport.transport,
            peerAddress: transport.peerAddress,
            sessionId: transport.sessionId,
            descriptorDigest: client.descriptorDigest,
          });
          await this.saver.save();
          this.bindConnection(
            transport,
            client.clientId,
            "register",
            bodyDigest,
          );
        }
        return { client: this.toSummary(client), created: false };
      }

      if (Object.keys(this.state.clients).length >= MAX_CLIENT_RECORDS) {
        throw new SecurityClientServiceError(
          "security_client_audit_capacity",
          409,
          "Security-client audit capacity is full",
        );
      }
      await this.assertConnectionAvailable(
        transport,
        "pending-registration",
        "register",
        bodyDigest,
      );
      this.assertSessionAttachable(transport);

      const now = this.nowIso();
      const clientId = randomUUID();
      const proofId = randomUUID();
      const descriptorDigest = this.descriptorDigest(request.descriptor);
      const client: StoredSecurityClient = {
        clientId,
        username: transport.username,
        kind: request.kind,
        reportedLabel: request.label,
        descriptorVersion: request.descriptorVersion,
        descriptor: request.descriptor,
        descriptorDigest,
        proofs: [
          {
            proofId,
            type: "continuity-key",
            protocol: SECURITY_CLIENT_KEY_PROTOCOL,
            status: "active",
            assurance: "client-key-verified",
            publicKeySpki: request.key.publicKeySpki,
            keyFingerprint: importedKey.fingerprint,
            reportedStorage: request.key.reportedStorage,
            addedAt: now,
            lastVerifiedAt: now,
          },
        ],
        createdAt: now,
        lastSeenAt: now,
        descriptorUpdatedAt: now,
        lastAuthenticationMethod: transport.authenticationMethod,
        lastTransport: transport.transport,
        lastPeerAddress: transport.peerAddress,
        events: [],
      };
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: "registered",
        timestamp: now,
        authenticationMethod: transport.authenticationMethod,
        transport: transport.transport,
        peerAddress: transport.peerAddress,
        sessionId: transport.sessionId,
        descriptorDigest,
      });
      if (
        !this.appendSecurityEvent(
          {
            eventId: randomUUID(),
            type: "client-registered",
            timestamp: now,
            clientId,
            clientSnapshot: this.clientSnapshot(client),
            authenticationMethod: transport.authenticationMethod,
            transport: transport.transport,
            peerAddress: transport.peerAddress,
            sessionId: transport.sessionId,
          },
          true,
        )
      ) {
        throw new SecurityClientServiceError(
          "security_client_audit_capacity",
          409,
          "Protected security audit capacity is full",
        );
      }

      this.state.clients[clientId] = client;
      this.state.registrationRequests[request.requestId] = {
        clientId,
        keyFingerprint: importedKey.fingerprint,
        bodyDigest,
      };
      await this.attachSession(client, transport);
      await this.saver.save();
      this.bindConnection(transport, clientId, "register", bodyDigest);
      return { client: this.toSummary(client), created: true };
    });
  }

  async checkIn(
    clientId: string,
    request: CheckInSecurityClientRequest,
    transport: AuthenticatedSrpTransportContext,
  ): Promise<SecurityClientResponse> {
    this.ensureInitialized();
    const proofBody = securityClientCheckInProofBody(request);
    const bodyDigestBytes = createHash("sha256")
      .update(canonicalizeSecurityClientProofBody(proofBody))
      .digest();
    const bodyDigest = bodyDigestBytes.toString("base64url");

    return this.mutate(async () => {
      const client = this.requireClient(clientId);
      this.assertClientActive(client);
      if (client.username !== transport.username) {
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Continuity proof failed",
        );
      }
      if (!descriptorMatchesKind(client.kind, request.descriptor)) {
        await this.recordContinuityFailureInMutation(client, transport);
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Descriptor kind does not match the registered client",
        );
      }
      const activeProof = client.proofs.find(
        (proof) => proof.type === "continuity-key" && proof.status === "active",
      );
      if (!activeProof) {
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "No active continuity key",
        );
      }
      const key = importP256PublicKey(activeProof.publicKeySpki).key;
      if (
        !verifyProof({
          key,
          signature: request.signature,
          operation: "check-in",
          route: securityClientCheckInRoute(clientId),
          subjectId: clientId,
          bodyDigest: bodyDigestBytes,
          transport,
        })
      ) {
        await this.recordContinuityFailureInMutation(client, transport);
        throw new SecurityClientServiceError(
          "security_client_proof_invalid",
          400,
          "Continuity proof failed",
        );
      }

      const repeat = await this.assertConnectionAvailable(
        transport,
        clientId,
        "check-in",
        bodyDigest,
        client,
      );
      if (repeat) {
        return { client: this.toSummary(client) };
      }

      await this.attachSession(client, transport);
      const now = this.nowIso();
      const nextDescriptorDigest = this.descriptorDigest(request.descriptor);
      const descriptorChanged =
        nextDescriptorDigest !== client.descriptorDigest;
      client.descriptor = request.descriptor;
      client.descriptorVersion = request.descriptorVersion;
      client.descriptorDigest = nextDescriptorDigest;
      client.lastSeenAt = now;
      client.lastAuthenticationMethod = transport.authenticationMethod;
      client.lastTransport = transport.transport;
      client.lastPeerAddress = transport.peerAddress;
      if (descriptorChanged) {
        client.descriptorUpdatedAt = now;
      }
      activeProof.lastVerifiedAt = now;
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: descriptorChanged ? "descriptor-changed" : "checked-in",
        timestamp: now,
        authenticationMethod: transport.authenticationMethod,
        transport: transport.transport,
        peerAddress: transport.peerAddress,
        sessionId: transport.sessionId,
        descriptorDigest: nextDescriptorDigest,
      });
      await this.saver.save();
      this.bindConnection(transport, clientId, "check-in", bodyDigest);
      return { client: this.toSummary(client) };
    });
  }

  list(): SecurityClientSummary[] {
    this.ensureInitialized();
    return [
      ...Object.values(this.state.clients).map((client) =>
        this.toSummary(client),
      ),
      ...this.legacyWebClients(),
    ].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  get(clientId: string): SecurityClientSummary {
    this.ensureInitialized();
    const client = this.state.clients[clientId];
    if (client) return this.toSummary(client);
    const legacy = this.legacyWebClients().find(
      (candidate) => candidate.clientId === clientId,
    );
    if (legacy) return legacy;
    return this.toSummary(this.requireClient(clientId));
  }

  events(clientId: string): SecurityClientAuditEvent[] {
    this.ensureInitialized();
    const client = this.state.clients[clientId];
    if (client) return [...client.events].reverse();
    if (
      this.legacyWebClients().some(
        (candidate) => candidate.clientId === clientId,
      )
    ) {
      return [];
    }
    return [...this.requireClient(clientId).events].reverse();
  }

  securityEvents(): SecurityEvent[] {
    this.ensureInitialized();
    return [...this.state.securityEvents].reverse();
  }

  async patch(
    clientId: string,
    request: PatchSecurityClientRequest,
  ): Promise<SecurityClientResponse> {
    this.ensureInitialized();
    return this.mutate(async () => {
      const ownerLabel = request.ownerLabel ?? undefined;
      const client = this.state.clients[clientId];
      if (!client) {
        const legacy = this.legacyWebClients().find(
          (candidate) => candidate.clientId === clientId,
        );
        if (!legacy?.legacyBrowserProfileId) {
          this.requireClient(clientId);
          throw new Error("unreachable");
        }
        const browserProfileId = legacy.legacyBrowserProfileId;
        if (legacy.ownerLabel === ownerLabel) {
          return { client: legacy };
        }
        if (ownerLabel) {
          this.state.legacyOwnerLabels[browserProfileId] = ownerLabel;
        } else {
          delete this.state.legacyOwnerLabels[browserProfileId];
        }
        const now = this.nowIso();
        const updated = {
          ...legacy,
          ownerLabel,
          displayLabel: ownerLabel ?? legacy.reportedLabel,
        };
        this.appendSecurityEvent({
          eventId: randomUUID(),
          type: "client-owner-label-changed",
          timestamp: now,
          clientId,
          clientSnapshot: this.legacyClientSnapshot(updated),
        });
        await this.saver.save();
        return { client: updated };
      }
      if (client.ownerLabel === ownerLabel) {
        return { client: this.toSummary(client) };
      }
      client.ownerLabel = ownerLabel;
      const now = this.nowIso();
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: "owner-label-changed",
        timestamp: now,
      });
      this.appendSecurityEvent({
        eventId: randomUUID(),
        type: "client-owner-label-changed",
        timestamp: now,
        clientId,
        clientSnapshot: this.clientSnapshot(client),
      });
      await this.saver.save();
      return { client: this.toSummary(client) };
    });
  }

  async prepareRevocation(
    clientId: string,
  ): Promise<PreparedSecurityClientRevocation> {
    this.ensureInitialized();
    return this.mutate(async () => {
      const client = this.state.clients[clientId];
      if (!client) {
        const legacy = this.legacyWebClients().find(
          (candidate) => candidate.clientId === clientId,
        );
        if (!legacy?.legacyBrowserProfileId) {
          this.requireClient(clientId);
          throw new Error("unreachable");
        }
        const now = this.nowIso();
        const browserProfileId = legacy.legacyBrowserProfileId;
        if (
          Object.keys(this.state.revokedLegacyBrowserProfiles).length >=
          MAX_CLIENT_RECORDS
        ) {
          throw new SecurityClientServiceError(
            "security_client_audit_capacity",
            409,
            "Legacy security-client tombstone capacity is full",
          );
        }
        if (
          !this.appendSecurityEvent(
            {
              eventId: randomUUID(),
              type: "client-revoked",
              timestamp: now,
              clientId,
              clientSnapshot: this.legacyClientSnapshot(legacy),
            },
            true,
          )
        ) {
          throw new SecurityClientServiceError(
            "security_client_audit_capacity",
            409,
            "Protected security audit capacity is full",
          );
        }
        this.state.revokedLegacyBrowserProfiles[browserProfileId] = now;
        delete this.state.legacyOwnerLabels[browserProfileId];
        await this.saver.save();
        return {
          client: { ...legacy, revokedAt: now },
          alreadyRevoked: false,
          cascade: async () => {
            await Promise.all([
              this.remoteSessionService.invalidateBrowserProfileSessions(
                browserProfileId,
              ),
              this.browserProfileService?.deleteProfile(browserProfileId),
              this.pushService?.unsubscribe(browserProfileId),
            ]);
            this.connectedBrowsers?.disconnectBrowserProfile(browserProfileId);
          },
        };
      }
      if (client.revokedAt) {
        return {
          client: this.toSummary(client),
          alreadyRevoked: true,
          cascade: async () => {},
        };
      }
      const now = this.nowIso();
      if (
        !this.appendSecurityEvent(
          {
            eventId: randomUUID(),
            type: "client-revoked",
            timestamp: now,
            clientId,
            clientSnapshot: this.clientSnapshot(client),
          },
          true,
        )
      ) {
        throw new SecurityClientServiceError(
          "security_client_audit_capacity",
          409,
          "Protected security audit capacity is full",
        );
      }
      client.revokedAt = now;
      for (const proof of client.proofs) proof.status = "revoked";
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: "revoked",
        timestamp: now,
      });
      await this.saver.save();

      const connections = [...this.activeConnections.entries()].filter(
        ([, binding]) => binding.clientId === clientId,
      );
      return {
        client: this.toSummary(client),
        alreadyRevoked: false,
        cascade: async () => {
          await this.remoteSessionService.invalidateSecurityClientSessions(
            clientId,
          );
          for (const [connectionId, binding] of connections) {
            this.activeConnections.delete(connectionId);
            binding.closeConnection();
          }
        },
      };
    });
  }

  disconnect(connectionId: string): void {
    this.activeConnections.delete(connectionId);
  }

  async recordSrpFullSucceeded(facts: SrpAuditFacts): Promise<void> {
    this.ensureInitialized();
    await this.mutate(async () => {
      this.appendSecurityEvent({
        eventId: randomUUID(),
        type: "srp-full-succeeded",
        timestamp: this.nowIso(),
        authenticationMethod: "srp-full",
        transport: facts.transport,
        peerAddress: facts.peerAddress,
        sessionId: facts.sessionId,
      });
      await this.saver.save();
    });
  }

  async recordSrpFullFailed(facts: SrpAuditFacts): Promise<void> {
    this.ensureInitialized();
    await this.mutate(async () => {
      this.appendSecurityEvent({
        eventId: randomUUID(),
        type: "srp-full-failed",
        timestamp: this.nowIso(),
        authenticationMethod: "srp-full",
        transport: facts.transport,
        peerAddress: facts.peerAddress,
      });
      await this.saver.save();
    });
  }

  private async recordSessionEviction(
    clientId: string,
    sessionId: string,
  ): Promise<void> {
    if (!this.initialized) return;
    await this.mutate(async () => {
      const client = this.state.clients[clientId];
      if (!client) return;
      const now = this.nowIso();
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: "resume-session-evicted",
        timestamp: now,
        sessionId,
      });
      this.appendSecurityEvent({
        eventId: randomUUID(),
        type: "resume-session-evicted",
        timestamp: now,
        clientId,
        clientSnapshot: this.clientSnapshot(client),
        sessionId,
      });
      await this.saver.save();
    });
  }

  private async recordContinuityFailure(
    client: StoredSecurityClient | null,
    transport: AuthenticatedSrpTransportContext,
  ): Promise<void> {
    await this.mutate(() =>
      this.recordContinuityFailureInMutation(client, transport),
    );
  }

  private async recordContinuityFailureInMutation(
    client: StoredSecurityClient | null,
    transport: AuthenticatedSrpTransportContext,
  ): Promise<void> {
    const now = this.nowIso();
    if (client) {
      this.appendClientEvent(client, {
        eventId: randomUUID(),
        type: "continuity-proof-failed",
        timestamp: now,
        authenticationMethod: transport.authenticationMethod,
        transport: transport.transport,
        peerAddress: transport.peerAddress,
        sessionId: transport.sessionId,
      });
    }
    this.appendSecurityEvent({
      eventId: randomUUID(),
      type: "continuity-proof-failed",
      timestamp: now,
      clientId: client?.clientId,
      clientSnapshot: client ? this.clientSnapshot(client) : undefined,
      authenticationMethod: transport.authenticationMethod,
      transport: transport.transport,
      peerAddress: transport.peerAddress,
      sessionId: transport.sessionId,
    });
    await this.saver.save();
  }

  private async assertConnectionAvailable(
    transport: AuthenticatedSrpTransportContext,
    clientId: string,
    operation: "register" | "check-in",
    bodyDigest: string,
    auditClient: StoredSecurityClient | null = null,
  ): Promise<boolean> {
    const existing = this.activeConnections.get(transport.connectionId);
    if (!existing) return false;
    if (
      existing.clientId === clientId &&
      existing.operation === operation &&
      existing.bodyDigest === bodyDigest
    ) {
      return true;
    }
    await this.recordContinuityFailureInMutation(auditClient, transport);
    throw new SecurityClientServiceError(
      "security_client_connection_bound",
      409,
      "This connection is already bound to a security client",
    );
  }

  private bindConnection(
    transport: AuthenticatedSrpTransportContext,
    clientId: string,
    operation: "register" | "check-in",
    bodyDigest: string,
  ): void {
    this.activeConnections.set(transport.connectionId, {
      clientId,
      operation,
      bodyDigest,
      closeConnection: transport.closeConnection,
    });
  }

  private async attachSession(
    client: StoredSecurityClient,
    transport: AuthenticatedSrpTransportContext,
  ): Promise<void> {
    this.assertSessionAttachable(transport, client.clientId);
    const attached = await this.remoteSessionService.attachSecurityClient(
      transport.sessionId,
      transport.username,
      client.clientId,
    );
    if (!attached) {
      throw new SecurityClientServiceError(
        "security_client_connection_bound",
        409,
        "Could not bind the authentication session",
      );
    }
  }

  private assertSessionAttachable(
    transport: AuthenticatedSrpTransportContext,
    clientId?: string,
  ): void {
    const session = this.remoteSessionService.getSession(transport.sessionId);
    if (
      !session ||
      session.username !== transport.username ||
      (session.securityClientId && session.securityClientId !== clientId)
    ) {
      throw new SecurityClientServiceError(
        "security_client_connection_bound",
        409,
        "Authentication session belongs to another security client",
      );
    }
  }

  private requireClient(clientId: string): StoredSecurityClient {
    const client = this.state.clients[clientId];
    if (!client) {
      throw new SecurityClientServiceError(
        "security_client_unknown",
        404,
        "Security client not found",
      );
    }
    return client;
  }

  private assertClientActive(client: StoredSecurityClient): void {
    if (client.revokedAt) {
      throw new SecurityClientServiceError(
        "security_client_revoked",
        410,
        "Security client was revoked",
      );
    }
  }

  private descriptorDigest(descriptor: SecurityClientDescriptor): string {
    return sha256Base64Url(canonicalizeSecurityClientProofBody(descriptor));
  }

  private appendClientEvent(
    client: StoredSecurityClient,
    event: SecurityClientAuditEvent,
  ): void {
    if (event.type === "continuity-proof-failed") {
      const previous = client.events.at(-1);
      if (
        previous?.type === event.type &&
        previous.transport === event.transport &&
        previous.peerAddress === event.peerAddress &&
        Date.parse(event.timestamp) - Date.parse(previous.timestamp) <=
          FAILURE_COALESCE_MS
      ) {
        previous.firstOccurredAt ??= previous.timestamp;
        previous.timestamp = event.timestamp;
        previous.count = (previous.count ?? 1) + 1;
        return;
      }
    }
    client.events.push(event);
    if (client.events.length > SECURITY_CLIENT_MAX_OBSERVATIONS) {
      client.events.splice(
        0,
        client.events.length - SECURITY_CLIENT_MAX_OBSERVATIONS,
      );
    }
  }

  private appendSecurityEvent(
    event: SecurityEvent,
    requiredAnchor = false,
  ): boolean {
    if (securityEventIsFailure(event)) {
      const existing = [...this.state.securityEvents]
        .reverse()
        .find(
          (candidate) =>
            candidate.type === event.type &&
            candidate.clientId === event.clientId &&
            candidate.transport === event.transport &&
            candidate.peerAddress === event.peerAddress &&
            Date.parse(event.timestamp) - Date.parse(candidate.timestamp) <=
              FAILURE_COALESCE_MS,
        );
      if (existing) {
        existing.firstOccurredAt ??= existing.timestamp;
        existing.timestamp = event.timestamp;
        existing.count = (existing.count ?? 1) + 1;
        return true;
      }
      const failures = this.state.securityEvents.filter(securityEventIsFailure);
      if (failures.length >= SECURITY_EVENT_MAX_FAILURE_ENTRIES) {
        const oldestFailure = this.state.securityEvents.findIndex(
          securityEventIsFailure,
        );
        if (oldestFailure >= 0)
          this.state.securityEvents.splice(oldestFailure, 1);
      }
    }

    while (this.state.securityEvents.length >= SECURITY_EVENT_MAX_ENTRIES) {
      const cutoff = this.now().getTime() - SECURITY_EVENT_ANCHOR_RETENTION_MS;
      const evictable = this.state.securityEvents.findIndex(
        (candidate) =>
          !securityEventIsProtectedAnchor(candidate) ||
          Date.parse(candidate.timestamp) < cutoff,
      );
      if (evictable < 0) return !requiredAnchor;
      this.state.securityEvents.splice(evictable, 1);
    }
    this.state.securityEvents.push(event);
    return true;
  }

  private clientSnapshot(
    client: StoredSecurityClient,
  ): SecurityEventClientSnapshot {
    const descriptor = client.descriptor;
    const continuityProof =
      client.proofs.find(
        (proof) => proof.type === "continuity-key" && proof.status === "active",
      ) ?? client.proofs.find((proof) => proof.type === "continuity-key");
    return {
      kind: client.kind,
      reportedLabel: client.reportedLabel,
      ownerLabel: client.ownerLabel,
      deviceClass: descriptor.deviceClass,
      manufacturer:
        "manufacturer" in descriptor ? descriptor.manufacturer : undefined,
      model: "model" in descriptor ? descriptor.model : undefined,
      appName: descriptor.appName,
      appVersion: descriptor.appVersion,
      origin: "origin" in descriptor ? descriptor.origin : undefined,
      keyFingerprint: continuityProof?.keyFingerprint,
    };
  }

  private toSummary(client: StoredSecurityClient): SecurityClientSummary {
    const sessions = this.remoteSessionService
      .listSecurityClientSessions(client.clientId)
      .map(({ sessionId, createdAt, lastUsed, lastConnectedAt }) => ({
        sessionId,
        createdAt,
        lastUsed,
        lastConnectedAt,
      }));
    let activeConnectionCount = 0;
    for (const binding of this.activeConnections.values()) {
      if (binding.clientId === client.clientId) activeConnectionCount += 1;
    }
    return {
      clientId: client.clientId,
      kind: client.kind,
      reportedLabel: client.reportedLabel,
      ownerLabel: client.ownerLabel,
      displayLabel: client.ownerLabel ?? client.reportedLabel,
      descriptorVersion: client.descriptorVersion,
      descriptor: client.descriptor,
      assurance: "client-key-verified",
      proofs: client.proofs.map(({ publicKeySpki: _, ...proof }) => proof),
      createdAt: client.createdAt,
      lastSeenAt: client.lastSeenAt,
      descriptorUpdatedAt: client.descriptorUpdatedAt,
      revokedAt: client.revokedAt,
      lastAuthenticationMethod: client.lastAuthenticationMethod,
      lastTransport: client.lastTransport,
      lastPeerAddress: client.lastPeerAddress,
      activeConnectionCount,
      sessions,
      push: { enabled: false },
    };
  }

  private legacyWebClients(): SecurityClientSummary[] {
    if (
      !this.browserProfileService &&
      !this.connectedBrowsers &&
      !this.pushService
    ) {
      return [];
    }
    const profiles = this.browserProfileService?.getProfiles() ?? [];
    const sessions = this.remoteSessionService
      .listSessions()
      .filter((session) => session.browserProfileId);
    const subscriptions = this.pushService?.getSubscriptions() ?? {};
    const connectedIds =
      this.connectedBrowsers?.getConnectedBrowserProfileIds() ?? [];
    const ids = new Set<string>([
      ...profiles.map((profile) => profile.browserProfileId),
      ...sessions.flatMap((session) =>
        session.browserProfileId ? [session.browserProfileId] : [],
      ),
      ...Object.keys(subscriptions),
      ...connectedIds,
    ]);

    return [...ids]
      .filter(
        (browserProfileId) =>
          !this.state.revokedLegacyBrowserProfiles[browserProfileId],
      )
      .map((browserProfileId) => {
        const profile = profiles.find(
          (candidate) => candidate.browserProfileId === browserProfileId,
        );
        const profileSessions = sessions.filter(
          (session) => session.browserProfileId === browserProfileId,
        );
        const subscription = subscriptions[browserProfileId];
        const ownerLabel = this.state.legacyOwnerLabels[browserProfileId];
        const latestOrigin = profile?.origins
          .slice()
          .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
        const latestSession = profileSessions
          .slice()
          .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))[0];
        const descriptor: LegacyWebSecurityClientDescriptor = {
          installationId: browserProfileId,
          deviceClass: "browser",
          appName: "Yep Anywhere Web",
          supportedProofs: [],
          ...((latestOrigin?.origin ?? latestSession?.origin)
            ? { origin: latestOrigin?.origin ?? latestSession?.origin }
            : {}),
          ...((latestOrigin?.userAgent ??
          latestSession?.userAgent ??
          subscription?.userAgent)
            ? {
                userAgent:
                  latestOrigin?.userAgent ??
                  latestSession?.userAgent ??
                  subscription?.userAgent,
              }
            : {}),
        };
        const createdAt = this.earliestTimestamp([
          profile?.createdAt,
          subscription?.createdAt,
          ...profileSessions.map((session) => session.createdAt),
        ]);
        const lastSeenAt = this.latestTimestamp([
          profile?.lastActiveAt,
          subscription?.createdAt,
          ...profileSessions.flatMap((session) => [
            session.lastUsed,
            session.lastConnectedAt,
          ]),
        ]);
        return {
          clientId: this.legacyWebClientId(browserProfileId),
          kind: "legacy-web",
          reportedLabel: subscription?.deviceName ?? "Web browser",
          ownerLabel,
          displayLabel: ownerLabel ?? subscription?.deviceName ?? "Web browser",
          descriptorVersion: 0,
          descriptor,
          assurance: "authenticated-session",
          proofs: [],
          createdAt,
          lastSeenAt,
          descriptorUpdatedAt: lastSeenAt,
          activeConnectionCount:
            this.connectedBrowsers?.getTabCount(browserProfileId) ?? 0,
          sessions: profileSessions.map(
            ({
              sessionId,
              createdAt: sessionCreatedAt,
              lastUsed,
              lastConnectedAt,
            }) => ({
              sessionId,
              createdAt: sessionCreatedAt,
              lastUsed,
              lastConnectedAt,
            }),
          ),
          push: {
            enabled: !!subscription,
            ...(subscription ? { updatedAt: subscription.createdAt } : {}),
          },
          legacyBrowserProfileId: browserProfileId,
        };
      });
  }

  private legacyWebClientId(browserProfileId: string): string {
    return `${LEGACY_WEB_CLIENT_PREFIX}${Buffer.from(browserProfileId).toString("base64url")}`;
  }

  private legacyClientSnapshot(
    client: SecurityClientSummary,
  ): SecurityEventClientSnapshot {
    const descriptor = client.descriptor;
    return {
      kind: "legacy-web",
      reportedLabel: client.reportedLabel,
      ownerLabel: client.ownerLabel,
      deviceClass: descriptor.deviceClass,
      manufacturer:
        "manufacturer" in descriptor ? descriptor.manufacturer : undefined,
      model: "model" in descriptor ? descriptor.model : undefined,
      appName: descriptor.appName,
      appVersion: descriptor.appVersion ?? "unknown",
      origin: "origin" in descriptor ? descriptor.origin : undefined,
    };
  }

  private earliestTimestamp(values: Array<string | undefined>): string {
    return this.extremeTimestamp(values, "earliest");
  }

  private latestTimestamp(values: Array<string | undefined>): string {
    return this.extremeTimestamp(values, "latest");
  }

  private extremeTimestamp(
    values: Array<string | undefined>,
    direction: "earliest" | "latest",
  ): string {
    const valid = values.filter(
      (value): value is string => !!value && !Number.isNaN(Date.parse(value)),
    );
    if (valid.length === 0) return this.nowIso();
    return valid.sort((a, b) =>
      direction === "earliest" ? a.localeCompare(b) : b.localeCompare(a),
    )[0]!;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "SecurityClientService not initialized. Call initialize() first.",
      );
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doSave(): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    const content = JSON.stringify(this.state, null, 2);
    await fs.writeFile(temporaryPath, content, {
      encoding: "utf-8",
      mode: OWNER_READ_WRITE_FILE_MODE,
    });
    await fs.rename(temporaryPath, this.filePath);
    await enforceOwnerReadWriteFilePermissions(
      this.filePath,
      "[SecurityClientService]",
    );
  }
}
