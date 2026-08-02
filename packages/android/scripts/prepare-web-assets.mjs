import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../client/dist-remote");
const destination = resolve(packageRoot, "app/build/generated/webAssets");

const remoteHtml = await readFile(resolve(source, "remote.html"), "utf8");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(resolve(destination, "index.html"), remoteHtml);
await rm(resolve(destination, "remote.html"));
