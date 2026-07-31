import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  console.log(
    "Push broker tests skipped: Windows is not a supported deployment target.",
  );
} else {
  const result = spawnSync("vitest", ["run"], {
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    console.error(`Push broker tests terminated by ${result.signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
