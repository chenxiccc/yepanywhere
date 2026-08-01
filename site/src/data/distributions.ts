export type DistributionStatus = "available" | "experimental" | "development";

export interface PublicDistribution {
  id: string;
  name: string;
  platform: string;
  status: DistributionStatus;
  summary: string;
  docsPath: `/docs/${string}`;
  downloadUrl?: string;
  actionLabel?: string;
  sourceRefs: string[];
}

export const distributions = [
  {
    id: "desktop-macos",
    name: "Desktop for macOS",
    platform: "Apple Silicon and Intel",
    status: "experimental",
    summary: "A signed and notarized desktop app with Yep Anywhere bundled inside.",
    docsPath: "/docs/desktop-apps",
    downloadUrl: "https://github.com/kzahel/yepanywhere/releases",
    actionLabel: "View macOS downloads",
    sourceRefs: ["packages/desktop/README.md", ".github/workflows/desktop-ci.yml"],
  },
  {
    id: "desktop-windows",
    name: "Desktop for Windows",
    platform: "Windows x64",
    status: "experimental",
    summary: "A signed installer with the server, client, and private runtime bundled.",
    docsPath: "/docs/desktop-apps",
    downloadUrl: "https://github.com/kzahel/yepanywhere/releases",
    actionLabel: "View Windows downloads",
    sourceRefs: ["packages/desktop/README.md", ".github/workflows/desktop-ci.yml"],
  },
  {
    id: "npm",
    name: "npm server install",
    platform: "macOS, Windows, and Linux",
    status: "available",
    summary: "The established command-line installation with full configuration access.",
    docsPath: "/docs/install-npm",
    downloadUrl: "https://www.npmjs.com/package/yepanywhere",
    actionLabel: "Install from npm",
    sourceRefs: ["README.md", "package.json"],
  },
  {
    id: "mobile-web",
    name: "Mobile browser",
    platform: "Phones and tablets",
    status: "available",
    summary: "Use the responsive web client from a browser; no native phone app is required.",
    docsPath: "/docs/remote-access",
    actionLabel: "Connect from a phone",
    sourceRefs: ["README.md", "packages/client/src/remote-main.tsx"],
  },
  {
    id: "android",
    name: "Android app",
    platform: "Android",
    status: "development",
    summary: "In development and not published. Use the mobile browser client today.",
    docsPath: "/docs/getting-started",
    sourceRefs: ["packages/mobile/package.json", "topics/android-fcm-push.md"],
  },
] as const satisfies readonly PublicDistribution[];

export type DistributionId = (typeof distributions)[number]["id"];
