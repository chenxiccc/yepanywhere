import { chmodSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const helperCandidates = [
  "packages/server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "packages/server/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
];

for (const candidate of helperCandidates) {
  const absolutePath = path.resolve(process.cwd(), candidate);
  if (!existsSync(absolutePath)) {
    continue;
  }

  const targetPath = realpathSync(absolutePath);
  chmodSync(targetPath, 0o755);
  console.log(`[fix-node-pty] chmod 755 ${targetPath}`);
}
