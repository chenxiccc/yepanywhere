import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLinuxProcessMemory,
  sampleChromiumProcessMemory,
} from "./browser-memory.mjs";

test("parses Linux resident, proportional, and private memory", () => {
  assert.deepEqual(
    parseLinuxProcessMemory(
      "Name:\tchrome\nVmRSS:\t   1234 kB\n",
      [
        "Pss:                900 kB",
        "Private_Clean:      100 kB",
        "Private_Dirty:      350 kB",
      ].join("\n"),
    ),
    {
      rssBytes: 1234 * 1024,
      pssBytes: 900 * 1024,
      privateBytes: 450 * 1024,
    },
  );
});

test("groups Chromium process memory without hiding incomplete coverage", async () => {
  const browserCdp = {
    send: async (method) => {
      assert.equal(method, "SystemInfo.getProcessInfo");
      return {
        processInfo: [
          { type: "browser", id: 10, cpuTime: 1.5 },
          { type: "renderer", id: 20, cpuTime: 2.5 },
          { type: "renderer", id: 21, cpuTime: 0.5 },
        ],
      };
    },
  };
  const files = new Map([
    ["/proc/10/status", "VmRSS: 100 kB\n"],
    [
      "/proc/10/smaps_rollup",
      "Pss: 80 kB\nPrivate_Clean: 10 kB\nPrivate_Dirty: 30 kB\n",
    ],
    ["/proc/20/status", "VmRSS: 200 kB\n"],
    [
      "/proc/20/smaps_rollup",
      "Pss: 150 kB\nPrivate_Clean: 20 kB\nPrivate_Dirty: 70 kB\n",
    ],
    ["/proc/21/status", "VmRSS: 50 kB\n"],
  ]);
  const sample = await sampleChromiumProcessMemory(browserCdp, {
    platform: "linux",
    readFileImpl: async (file) => {
      const value = files.get(file);
      if (value === undefined) throw new Error("gone");
      return value;
    },
  });

  assert.equal(sample.source, "cdp-system-info+linux-proc");
  assert.deepEqual(sample.totals, {
    processCount: 3,
    rssBytes: 350 * 1024,
    pssBytes: null,
    privateBytes: null,
  });
  assert.deepEqual(sample.byType.browser, {
    processCount: 1,
    rssBytes: 100 * 1024,
    pssBytes: 80 * 1024,
    privateBytes: 40 * 1024,
  });
  assert.deepEqual(sample.byType.renderer, {
    processCount: 2,
    rssBytes: 250 * 1024,
    pssBytes: null,
    privateBytes: null,
  });
});

test("keeps the process inventory when native bytes are unavailable", async () => {
  const sample = await sampleChromiumProcessMemory(
    {
      send: async () => ({
        processInfo: [{ type: "browser", id: 10, cpuTime: 1.5 }],
      }),
    },
    { platform: "darwin" },
  );

  assert.equal(sample.source, "cdp-system-info");
  assert.deepEqual(sample.totals, {
    processCount: 1,
    rssBytes: null,
    pssBytes: null,
    privateBytes: null,
  });
  assert.deepEqual(sample.processes, [
    {
      cpuTimeSeconds: 1.5,
      pid: 10,
      type: "browser",
      rssBytes: null,
      pssBytes: null,
      privateBytes: null,
    },
  ]);
});
