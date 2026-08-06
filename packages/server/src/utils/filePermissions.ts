import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";

export const OWNER_READ_WRITE_FILE_MODE = 0o600;
export const OWNER_READ_WRITE_DIRECTORY_MODE = 0o700;

export type OwnerOnlyPathKind = "file" | "directory";

export interface WindowsAclEntry {
  principal: string;
  access: "allow" | "deny";
  permissions: string[];
}

export interface WindowsAclVerification {
  valid: boolean;
  reason?: string;
}

export interface WindowsCurrentIdentity {
  principal: string;
  sid: string;
}

const execFileAsync = promisify(execFile);
const WINDOWS_OWNER_QUERY_PATH_ENV = "YEP_OWNER_ONLY_QUERY_PATH";
const WINDOWS_CURRENT_IDENTITY_COMMAND =
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent(); " +
  "[pscustomobject]@{ principal = $identity.Name; sid = $identity.User.Value } | ConvertTo-Json -Compress";
const WINDOWS_OBJECT_OWNER_SID_COMMAND =
  `$acl = Get-Acl -LiteralPath $env:${WINDOWS_OWNER_QUERY_PATH_ENV}; ` +
  "$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value";
let windowsCurrentIdentityPromise: Promise<WindowsCurrentIdentity> | undefined;

const WINDOWS_SHARED_PRINCIPALS_TO_REMOVE = [
  "*S-1-1-0", // Everyone
  "*S-1-5-11", // Authenticated Users
  "*S-1-5-32-545", // Builtin Users
  "*S-1-5-32-546", // Builtin Guests
];

/**
 * Build an `icacls` command that removes inherited shared access and grants
 * only the server user full control. Exported so non-Windows tests can verify
 * the Windows ACL shape without shelling out to platform-specific tooling.
 */
export function buildWindowsSetOwnerIcaclsArgs(
  targetPath: string,
  principal: string,
): string[] {
  return [targetPath, "/setowner", principal];
}

export function buildOwnerOnlyIcaclsArgs(
  targetPath: string,
  username = userInfo().username,
  kind: OwnerOnlyPathKind = "file",
  otherPrincipals: readonly string[] = WINDOWS_SHARED_PRINCIPALS_TO_REMOVE,
): string[] {
  const grant =
    kind === "directory" ? `${username}:(OI)(CI)F` : `${username}:F`;
  return [
    targetPath,
    "/inheritance:r",
    "/remove:d",
    username,
    "/grant:r",
    grant,
    ...(otherPrincipals.length > 0
      ? ["/remove:g", ...new Set(otherPrincipals)]
      : []),
  ];
}

export function parseWindowsIcaclsOutput(
  output: string,
  filePath: string,
): WindowsAclEntry[] {
  const entries: WindowsAclEntry[] = [];
  for (const [index, rawLine] of output
    .replaceAll("\r", "")
    .split("\n")
    .entries()) {
    let line = rawLine.trim();
    if (index === 0 && line.startsWith(filePath)) {
      line = line.slice(filePath.length).trim();
    }
    if (!line || /^Successfully processed /i.test(line)) continue;
    const match = /^(.*?):((?:\([^)]*\))+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const permissions = [...match[2].matchAll(/\(([^)]*)\)/g)].map(
      (permission) => permission[1] ?? "",
    );
    const denied = permissions.includes("DENY");
    entries.push({
      principal: match[1].trim(),
      access: denied ? "deny" : "allow",
      permissions: permissions.filter((permission) => permission !== "DENY"),
    });
  }
  return entries;
}

export function verifyWindowsOwnerOnlyAcl(
  output: string,
  filePath: string,
  owner: string,
): WindowsAclVerification {
  const entries = parseWindowsIcaclsOutput(output, filePath);
  if (entries.length === 0) {
    return { valid: false, reason: "ACL query returned no access entries" };
  }
  const normalizedOwner = owner.toLocaleLowerCase("en-US");
  const ownerEntries = entries.filter(
    (entry) => entry.principal.toLocaleLowerCase("en-US") === normalizedOwner,
  );
  if (ownerEntries.length === 0) {
    return { valid: false, reason: "ACL does not grant the current owner" };
  }
  if (ownerEntries.some((entry) => entry.access === "deny")) {
    return { valid: false, reason: "ACL retains an owner DENY entry" };
  }
  const inherited = entries.find((entry) => entry.permissions.includes("I"));
  if (inherited) {
    return {
      valid: false,
      reason: `ACL retains inherited access for ${inherited.principal}`,
    };
  }
  const other = entries.find(
    (entry) => entry.principal.toLocaleLowerCase("en-US") !== normalizedOwner,
  );
  if (other) {
    return {
      valid: false,
      reason: `ACL grants access to ${other.principal}`,
    };
  }
  if (
    !ownerEntries.some(
      (entry) => entry.access === "allow" && entry.permissions.includes("F"),
    )
  ) {
    return { valid: false, reason: "ACL does not grant owner full control" };
  }
  return { valid: true };
}

export function parseWindowsCurrentIdentityOutput(
  output: string,
): WindowsCurrentIdentity {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Unable to parse current Windows identity");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Current Windows identity is incomplete");
  }
  const { principal, sid } = value as Record<string, unknown>;
  if (
    typeof principal !== "string" ||
    !principal ||
    typeof sid !== "string" ||
    !sid
  ) {
    throw new Error("Current Windows identity is incomplete");
  }
  return { principal, sid };
}

export function verifyWindowsObjectOwner(
  currentSid: string,
  ownerSid: string,
): WindowsAclVerification {
  if (!ownerSid) {
    return { valid: false, reason: "Object-owner query returned no SID" };
  }
  if (
    currentSid.toLocaleLowerCase("en-US") !==
    ownerSid.toLocaleLowerCase("en-US")
  ) {
    return {
      valid: false,
      reason: `Object owner ${ownerSid} is not the current Windows identity`,
    };
  }
  return { valid: true };
}

/**
 * Enforce owner read/write file permissions for local secret files.
 */
export async function enforceOwnerReadWriteFilePermissions(
  filePath: string,
  logPrefix: string,
): Promise<void> {
  if (process.platform === "win32") {
    await enforceWindowsOwnerOnlyFilePermissions(filePath, logPrefix);
    return;
  }

  try {
    await fs.chmod(filePath, OWNER_READ_WRITE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.warn(
      `${logPrefix} Failed to enforce 0600 permissions on ${filePath}:`,
      error,
    );
  }
}

export async function enforceOwnerOnlyPathPermissionsStrict(
  targetPath: string,
  kind: OwnerOnlyPathKind,
): Promise<void> {
  if (process.platform === "win32") {
    await enforceWindowsOwnerOnlyPathPermissionsStrict(targetPath, kind);
    return;
  }

  const expectedMode =
    kind === "file"
      ? OWNER_READ_WRITE_FILE_MODE
      : OWNER_READ_WRITE_DIRECTORY_MODE;
  const before = await fs.lstat(targetPath);
  if (before.isSymbolicLink()) {
    throw new Error(
      `Owner-only ${kind} path is a symbolic link: ${targetPath}`,
    );
  }
  if (
    (kind === "file" && !before.isFile()) ||
    (kind === "directory" && !before.isDirectory())
  ) {
    throw new Error(`Owner-only path is not a ${kind}: ${targetPath}`);
  }
  await fs.chmod(targetPath, expectedMode);
  const after = await fs.lstat(targetPath);
  if ((after.mode & 0o777) !== expectedMode || (after.mode & 0o077) !== 0) {
    throw new Error(
      `Owner-only ${kind} permissions were not applied to ${targetPath}`,
    );
  }
  if (typeof process.getuid === "function" && after.uid !== process.getuid()) {
    throw new Error(`Owner-only ${kind} has the wrong owner: ${targetPath}`);
  }
}

async function getWindowsCurrentIdentity(): Promise<WindowsCurrentIdentity> {
  windowsCurrentIdentityPromise ??= execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_CURRENT_IDENTITY_COMMAND,
    ],
    { windowsHide: true },
  ).then(({ stdout }) => parseWindowsCurrentIdentityOutput(stdout));
  return windowsCurrentIdentityPromise;
}

async function getWindowsObjectOwnerSid(targetPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_OBJECT_OWNER_SID_COMMAND,
    ],
    {
      env: { ...process.env, [WINDOWS_OWNER_QUERY_PATH_ENV]: targetPath },
      windowsHide: true,
    },
  );
  return stdout.trim();
}

async function enforceWindowsOwnerOnlyPathPermissionsStrict(
  targetPath: string,
  kind: OwnerOnlyPathKind,
): Promise<void> {
  const stats = await fs.lstat(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Owner-only ${kind} path is a symbolic link: ${targetPath}`,
    );
  }
  if (
    (kind === "file" && !stats.isFile()) ||
    (kind === "directory" && !stats.isDirectory())
  ) {
    throw new Error(`Owner-only path is not a ${kind}: ${targetPath}`);
  }

  const identity = await getWindowsCurrentIdentity();
  const { stdout: beforeOutput } = await execFileAsync("icacls", [targetPath], {
    windowsHide: true,
  });
  const otherPrincipals = parseWindowsIcaclsOutput(beforeOutput, targetPath)
    .map((entry) => entry.principal)
    .filter(
      (principal) =>
        principal.toLocaleLowerCase("en-US") !==
        identity.principal.toLocaleLowerCase("en-US"),
    );
  await execFileAsync(
    "icacls",
    buildWindowsSetOwnerIcaclsArgs(targetPath, identity.principal),
    { windowsHide: true },
  );
  await execFileAsync(
    "icacls",
    buildOwnerOnlyIcaclsArgs(
      targetPath,
      identity.principal,
      kind,
      otherPrincipals,
    ),
    { windowsHide: true },
  );
  const ownerVerification = verifyWindowsObjectOwner(
    identity.sid,
    await getWindowsObjectOwnerSid(targetPath),
  );
  if (!ownerVerification.valid) {
    throw new Error(
      `Owner-only Windows object-owner verification failed for ${targetPath}: ${ownerVerification.reason}`,
    );
  }
  const { stdout: afterOutput } = await execFileAsync("icacls", [targetPath], {
    windowsHide: true,
  });
  const aclVerification = verifyWindowsOwnerOnlyAcl(
    afterOutput,
    targetPath,
    identity.principal,
  );
  if (!aclVerification.valid) {
    throw new Error(
      `Owner-only Windows ACL verification failed for ${targetPath}: ${aclVerification.reason}`,
    );
  }
}

async function enforceWindowsOwnerOnlyFilePermissions(
  filePath: string,
  logPrefix: string,
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    await execFileAsync("icacls", buildOwnerOnlyIcaclsArgs(filePath), {
      windowsHide: true,
    });
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to enforce owner-only ACL on ${filePath}:`,
      error,
    );
  }
}
