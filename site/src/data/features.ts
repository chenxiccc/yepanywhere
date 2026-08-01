import type { ProviderId } from "./providers";

export type FeatureStatus = "stable" | "experimental";
export type FeatureCategoryId =
  | "supervise"
  | "coordinate"
  | "providers"
  | "review"
  | "connect";

export interface FeatureCategory {
  id: FeatureCategoryId;
  title: string;
  eyebrow: string;
  description: string;
}

export interface PublicFeature {
  id: string;
  title: string;
  summary: string;
  category: FeatureCategoryId;
  status: FeatureStatus;
  docsPath: `/docs/${string}`;
  providers?: readonly ProviderId[];
  availability?: string;
  image?: { src: string; alt: string };
  featured?: boolean;
  sourceRefs: string[];
}

export const featureCategories: FeatureCategory[] = [
  {
    id: "supervise",
    title: "Supervise from any screen",
    eyebrow: "Stay in the loop",
    description: "Keep agents moving from another computer, a tablet, or a phone without moving the work off the host.",
  },
  {
    id: "coordinate",
    title: "Run many agents without losing track",
    eyebrow: "Stay oriented",
    description: "See attention, activity, and queued work across projects in one place.",
  },
  {
    id: "providers",
    title: "Use the agents you already trust",
    eyebrow: "One interface",
    description: "Work across first-class providers and clearly labeled experimental integrations.",
  },
  {
    id: "review",
    title: "Review and ship from the same surface",
    eyebrow: "Close the loop",
    description: "Inspect files, diffs, Git state, shares, and running mobile builds remotely.",
  },
  {
    id: "connect",
    title: "Connect without giving up control",
    eyebrow: "Local by design",
    description: "Choose direct access or an end-to-end encrypted relay while sessions stay local.",
  },
];

export const features = [
  {
    id: "cross-device-control",
    title: "Any browser, any host",
    summary: "Use a desktop, laptop, Chromebook, tablet, or phone to supervise sessions running on another computer.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/remote-access",
    featured: true,
    sourceRefs: ["README.md", "site/src/content/docs/remote-access.md"],
  },
  {
    id: "mobile-approvals",
    title: "Mobile approvals",
    summary: "Review tool requests, answer questions, and unblock an agent from a touch-friendly session view.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    providers: ["claude", "codex"],
    image: { src: "/screenshots/mobile-approve-edit.png", alt: "A file edit approval shown on a phone" },
    featured: true,
    sourceRefs: ["README.md", "packages/client/src/components/ApprovalPrompt.tsx"],
  },
  {
    id: "full-fidelity-transcripts",
    title: "Full-fidelity transcripts",
    summary: "See the complete conversation, every tool call, and available thinking—or condense routine activity when you want a quieter view.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    featured: true,
    sourceRefs: ["packages/client/src/components/MessageList.tsx", "packages/client/src/i18n/en.json"],
  },
  {
    id: "persistent-sessions",
    title: "Sessions survive disconnects",
    summary: "Agent processes belong to the server, so closing a tab or changing devices does not interrupt active work.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    sourceRefs: ["CLAUDE.md", "topics/session-reactivation.md"],
  },
  {
    id: "push-notifications",
    title: "Push notifications",
    summary: "Get notified when a session needs approval or attention, then return directly to the work.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/notifications-and-voice",
    availability: "Browser Web Push; native Android delivery is still in development.",
    sourceRefs: ["topics/notifications.md"],
  },
  {
    id: "uploads",
    title: "Files and photos from your phone",
    summary: "Attach screenshots, images, PDFs, and code files without moving them through a desktop first.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    sourceRefs: ["README.md", "topics/draft-attachment-staging.md"],
  },
  {
    id: "voice-input",
    title: "Voice input",
    summary: "Use browser speech, hosted transcription, or local speech models from the microphone menu.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/notifications-and-voice",
    sourceRefs: ["README.md", "topics/pluggable-speech-recognition.md"],
  },
  {
    id: "localized-client",
    title: "Six-language interface",
    summary: "Use the client in English, Chinese, Spanish, French, German, or Japanese.",
    category: "supervise",
    status: "stable",
    docsPath: "/docs/getting-started",
    sourceRefs: ["site/src/pages/spring-2026.astro", "packages/client/src/i18n"],
  },
  {
    id: "multi-session-inbox",
    title: "Multi-session inbox",
    summary: "See which sessions need attention, which are active, and which changed while you were away.",
    category: "coordinate",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    image: { src: "/screenshots/navigation.png", alt: "The session navigation and attention inbox" },
    featured: true,
    sourceRefs: ["README.md", "topics/inbox.md"],
  },
  {
    id: "search-and-recaps",
    title: "Search and recaps",
    summary: "Find an older session quickly and get a bounded recap when you return to work that continued without you.",
    category: "coordinate",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    sourceRefs: ["site/src/pages/spring-2026.astro", "topics/recaps.md"],
  },
  {
    id: "steer-and-queue",
    title: "Steer now or queue next",
    summary: "Redirect compatible agents mid-turn or line up verbatim follow-ups for the next safe delivery boundary.",
    category: "coordinate",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    providers: ["claude", "codex"],
    featured: true,
    sourceRefs: ["topics/message-control-steer-queue-btw-later-interrupt.md", "topics/steer-queue-provider-differences.md"],
  },
  {
    id: "project-queue",
    title: "Project Queue",
    summary: "Schedule durable project-level follow-ups that start only after the entire project becomes quiet.",
    category: "coordinate",
    status: "stable",
    docsPath: "/docs/project-queue",
    availability: "Optional: entry controls are opt-in and capability-gated for hosted clients.",
    sourceRefs: ["topics/project-queue.md"],
  },
  {
    id: "global-activity",
    title: "Global activity view",
    summary: "Watch active agents and file-changing work across sessions instead of cycling through terminal windows.",
    category: "coordinate",
    status: "stable",
    docsPath: "/docs/sessions-and-approvals",
    sourceRefs: ["README.md", "docs/project/differentiators.md"],
  },
  {
    id: "session-forks",
    title: "Fork and clone conversations",
    summary: "Branch from a useful point or copy a completed conversation so experiments do not disturb the source session.",
    category: "coordinate",
    status: "experimental",
    docsPath: "/docs/sessions-and-approvals",
    providers: ["claude", "codex"],
    sourceRefs: ["README.md", "topics/fork-from-turn.md", "topics/provider-fork-support.md"],
  },
  {
    id: "provider-interop",
    title: "Claude Code and Codex together",
    summary: "Start, stream, approve, and review sessions from both primary providers through the same workflow.",
    category: "providers",
    status: "stable",
    docsPath: "/docs/providers",
    providers: ["claude", "codex"],
    featured: true,
    sourceRefs: ["README.md", "site/src/pages/spring-2026.astro"],
  },
  {
    id: "session-interop",
    title: "Pick up sessions from other tools",
    summary: "Read and resume compatible sessions started in the CLI, VS Code, or first-party desktop applications.",
    category: "providers",
    status: "stable",
    docsPath: "/docs/providers",
    providers: ["claude", "codex"],
    sourceRefs: ["README.md", "docs/project/differentiators.md"],
  },
  {
    id: "model-controls",
    title: "Model and effort controls",
    summary: "Change models and thinking effort from the session UI when the provider supports it.",
    category: "providers",
    status: "stable",
    docsPath: "/docs/providers",
    providers: ["claude", "codex"],
    sourceRefs: ["site/src/pages/spring-2026.astro", "topics/permission-mode.md"],
  },
  {
    id: "experimental-providers",
    title: "Experimental provider integrations",
    summary: "Explore OpenCode, Grok Build, Claude + Ollama, and Gemini with capability differences shown up front.",
    category: "providers",
    status: "experimental",
    docsPath: "/docs/providers",
    providers: ["opencode", "grok", "ollama", "gemini"],
    sourceRefs: ["topics/opencode-backend.md", "topics/grok.md", "packages/server/src/sdk/providers/claude-ollama.ts", "packages/server/src/sdk/providers/gemini.ts"],
  },
  {
    id: "diffs",
    title: "Readable diffs",
    summary: "Review edits with syntax-aware diffs on a phone or a wide desktop layout.",
    category: "review",
    status: "stable",
    docsPath: "/docs/files-and-source-control",
    image: { src: "/screenshots/mobile-diff.png", alt: "A code diff rendered on a phone" },
    sourceRefs: ["README.md", "packages/client/RENDERING_PERFORMANCE.md"],
  },
  {
    id: "file-viewer",
    title: "Scoped file viewer",
    summary: "Open linked source and media with explicit server-side folder permissions for remote reads.",
    category: "review",
    status: "stable",
    docsPath: "/docs/files-and-source-control",
    sourceRefs: ["site/src/pages/spring-2026.astro", "packages/server/src/middleware/file-access.ts"],
  },
  {
    id: "source-control",
    title: "Guarded source control",
    summary: "Inspect working-tree changes and recent commits, then explicitly check, fast-forward pull, or push.",
    category: "review",
    status: "experimental",
    docsPath: "/docs/files-and-source-control",
    featured: true,
    sourceRefs: ["topics/source-control.md", "site/src/pages/spring-2026.astro"],
  },
  {
    id: "session-sharing",
    title: "Read-only session sharing",
    summary: "Publish a deliberate read-only session link with live viewer state and explicit owner controls.",
    category: "review",
    status: "experimental",
    docsPath: "/docs/security-and-privacy",
    availability: "Opt-in: link holders and the current relay operator can read shared content.",
    sourceRefs: ["site/src/pages/spring-2026.astro", "topics/relay-origin-and-share-gating.md"],
  },
  {
    id: "device-control",
    title: "Remote device control",
    summary: "Stream and control Android devices, Android emulators, and iOS Simulators from the browser.",
    category: "review",
    status: "experimental",
    docsPath: "/docs/files-and-source-control",
    image: { src: "/screenshots/device-stream.png", alt: "An Android emulator controlled from a phone" },
    sourceRefs: ["site/src/pages/remote-device-control.astro"],
  },
  {
    id: "encrypted-relay",
    title: "End-to-end encrypted public relay",
    summary: "Reach an authenticated server without a VPN while the relay sees encrypted application traffic, not session contents.",
    category: "connect",
    status: "stable",
    docsPath: "/docs/remote-access",
    featured: true,
    sourceRefs: ["docs/project/relay-design.md", "topics/relay-origin-and-share-gating.md"],
  },
  {
    id: "direct-access",
    title: "Direct LAN or private-network access",
    summary: "Connect straight to your own server over a trusted LAN or private network such as Tailscale.",
    category: "connect",
    status: "stable",
    docsPath: "/docs/remote-access",
    sourceRefs: ["README.md", "docs/project/remote-access.md"],
  },
  {
    id: "self-hosted-relay",
    title: "Self-hosted relay option",
    summary: "Run the relay infrastructure yourself when you want ownership of every network component.",
    category: "connect",
    status: "stable",
    docsPath: "/docs/remote-access",
    sourceRefs: ["docs/project/relay-design.md", "README.md"],
  },
  {
    id: "local-data",
    title: "Local data and open source",
    summary: "Sessions and server state stay on machines you control, and the complete project is MIT licensed.",
    category: "connect",
    status: "stable",
    docsPath: "/docs/security-and-privacy",
    sourceRefs: ["README.md", "site/src/pages/privacy.astro"],
  },
] as const satisfies readonly PublicFeature[];
