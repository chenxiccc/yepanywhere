/**
 * Wrapper script to serve the built remote client with Vite preview.
 * Writes the resolved port to a file for the test harness to read.
 * This is more reliable than parsing stdout.
 *
 * Environment variables:
 * - VITE_PORT_FILE: Path to write the resolved port (required)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT_FILE = process.env.VITE_PORT_FILE;
if (!PORT_FILE) {
  console.error("VITE_PORT_FILE environment variable is required");
  process.exit(1);
}

async function main() {
  const clientRoot = join(__dirname, "..");

  const server = await preview({
    configFile: join(clientRoot, "vite.config.remote.ts"),
    preview: {
      port: 0,
      strictPort: false,
      host: true,
    },
  });

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    console.error("Failed to get server address");
    process.exit(1);
  }

  const port = address.port;
  writeFileSync(PORT_FILE, String(port));
  console.log(`[Vite Remote Preview] Server listening on port ${port}`);

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start Vite preview:", err);
  process.exit(1);
});
