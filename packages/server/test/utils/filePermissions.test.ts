import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOwnerOnlyIcaclsArgs,
  buildWindowsSetOwnerIcaclsArgs,
  enforceOwnerOnlyPathPermissionsStrict,
  parseWindowsCurrentIdentityOutput,
  parseWindowsIcaclsOutput,
  verifyWindowsObjectOwner,
  verifyWindowsOwnerOnlyAcl,
} from "../../src/utils/filePermissions.js";

let testDir: string | null = null;

afterEach(async () => {
  if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  testDir = null;
});

describe("buildOwnerOnlyIcaclsArgs", () => {
  it("builds a non-inherited owner-only ACL command", () => {
    expect(
      buildOwnerOnlyIcaclsArgs("C:\\Users\\dev\\.yep\\auth.json", "dev"),
    ).toEqual([
      "C:\\Users\\dev\\.yep\\auth.json",
      "/inheritance:r",
      "/remove:d",
      "dev",
      "/grant:r",
      "dev:F",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
      "*S-1-5-32-546",
    ]);
  });

  it("builds a separate object-owner command", () => {
    expect(
      buildWindowsSetOwnerIcaclsArgs(
        "C:\\Users\\dev\\.yep\\auth.json",
        "WORKSTATION\\dev",
      ),
    ).toEqual([
      "C:\\Users\\dev\\.yep\\auth.json",
      "/setowner",
      "WORKSTATION\\dev",
    ]);
  });

  it("removes owner denies before granting a directory ACL", () => {
    expect(
      buildOwnerOnlyIcaclsArgs(
        "C:\\Users\\dev\\.yep\\public-shares",
        "WORKSTATION\\dev",
        "directory",
        ["BUILTIN\\Users"],
      ),
    ).toEqual([
      "C:\\Users\\dev\\.yep\\public-shares",
      "/inheritance:r",
      "/remove:d",
      "WORKSTATION\\dev",
      "/grant:r",
      "WORKSTATION\\dev:(OI)(CI)F",
      "/remove:g",
      "BUILTIN\\Users",
    ]);
  });
});

describe("Windows owner-only ACL verification", () => {
  const filePath = "C:\\Users\\dev\\.yep\\auth.json";
  const owner = "WORKSTATION\\dev";

  it("parses icacls entries independently of the queried path", () => {
    expect(
      parseWindowsIcaclsOutput(
        `${filePath} ${owner}:(F)\r\n  BUILTIN\\Users:(I)(RX)\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`,
        filePath,
      ),
    ).toEqual([
      { principal: owner, access: "allow", permissions: ["F"] },
      {
        principal: "BUILTIN\\Users",
        access: "allow",
        permissions: ["I", "RX"],
      },
    ]);
  });

  it("accepts one explicit full-control owner grant", () => {
    expect(
      verifyWindowsOwnerOnlyAcl(
        `${filePath} ${owner}:(F)\r\n`,
        filePath,
        owner,
      ),
    ).toEqual({ valid: true });
  });

  it("parses and rejects an owner DENY entry beside an allow grant", () => {
    const output = `${filePath} ${owner}:(DENY)(W)\r\n  ${owner}:(F)\r\n`;
    expect(parseWindowsIcaclsOutput(output, filePath)).toEqual([
      { principal: owner, access: "deny", permissions: ["W"] },
      { principal: owner, access: "allow", permissions: ["F"] },
    ]);
    expect(verifyWindowsOwnerOnlyAcl(output, filePath, owner)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("DENY"),
    });
  });

  it("rejects inherited, shared, incomplete, and unparseable ACLs", () => {
    expect(
      verifyWindowsOwnerOnlyAcl(
        `${filePath} ${owner}:(I)(F)\r\n`,
        filePath,
        owner,
      ),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("inherited"),
    });
    expect(
      verifyWindowsOwnerOnlyAcl(
        `${filePath} ${owner}:(F)\r\n  BUILTIN\\Users:(RX)\r\n`,
        filePath,
        owner,
      ),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("BUILTIN"),
    });
    expect(
      verifyWindowsOwnerOnlyAcl(
        `${filePath} ${owner}:(R)\r\n`,
        filePath,
        owner,
      ),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("full control"),
    });
    expect(
      verifyWindowsOwnerOnlyAcl("nonsense", filePath, owner),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("no access entries"),
    });
  });
});

describe("Windows object-owner verification", () => {
  const currentSid = "S-1-5-21-1000-1000-1000-1001";

  it("parses the current Windows principal and SID", () => {
    expect(
      parseWindowsCurrentIdentityOutput(
        JSON.stringify({
          principal: "WORKSTATION\\dev",
          sid: currentSid,
        }),
      ),
    ).toEqual({
      principal: "WORKSTATION\\dev",
      sid: currentSid,
    });
    expect(() => parseWindowsCurrentIdentityOutput("not json")).toThrow(
      /parse current Windows identity/,
    );
    expect(() =>
      parseWindowsCurrentIdentityOutput(
        JSON.stringify({ principal: "WORKSTATION\\dev" }),
      ),
    ).toThrow(/identity is incomplete/);
  });

  it("requires the queried object-owner SID to match the process identity", () => {
    expect(
      verifyWindowsObjectOwner(currentSid, currentSid.toLowerCase()),
    ).toEqual({ valid: true });
    expect(
      verifyWindowsObjectOwner(currentSid, "S-1-5-21-2000-2000-2000-2002"),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("not the current Windows identity"),
    });
    expect(verifyWindowsObjectOwner(currentSid, "")).toMatchObject({
      valid: false,
      reason: expect.stringContaining("no SID"),
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "strict POSIX owner-only permissions",
  () => {
    it("repairs and verifies regular files and directories", async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), "permissions-test-"));
      const directory = path.join(testDir, "private");
      const file = path.join(directory, "control.json");
      await fs.mkdir(directory, { mode: 0o777 });
      await fs.writeFile(file, "{}", { mode: 0o666 });
      await fs.chmod(directory, 0o777);
      await fs.chmod(file, 0o666);

      await enforceOwnerOnlyPathPermissionsStrict(directory, "directory");
      await enforceOwnerOnlyPathPermissionsStrict(file, "file");

      expect((await fs.lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
      if (typeof process.getuid === "function") {
        expect((await fs.lstat(file)).uid).toBe(process.getuid());
      }
    });

    it("rejects symlinks and paths of the wrong kind", async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), "permissions-test-"));
      const file = path.join(testDir, "file");
      const link = path.join(testDir, "link");
      await fs.writeFile(file, "x");
      await fs.symlink(file, link);

      await expect(
        enforceOwnerOnlyPathPermissionsStrict(link, "file"),
      ).rejects.toThrow(/symbolic link/);
      await expect(
        enforceOwnerOnlyPathPermissionsStrict(file, "directory"),
      ).rejects.toThrow(/not a directory/);
    });
  },
);
