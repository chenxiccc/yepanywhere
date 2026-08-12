export interface DocsNavItem {
  path: `/docs/${string}`;
  title: string;
  description: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export const docsNavigation: DocsNavSection[] = [
  {
    title: "Start here",
    items: [
      {
        path: "/docs/getting-started",
        title: "Getting started",
        description:
          "Choose an install, launch Yep Anywhere, and open your first session.",
      },
      {
        path: "/docs/desktop-apps",
        title: "Desktop apps",
        description: "Install the beta macOS or Windows desktop release.",
      },
      {
        path: "/docs/install-npm",
        title: "Install from npm",
        description: "Install the server and web client from the command line.",
      },
      {
        path: "/docs/updating",
        title: "Updating",
        description: "Keep npm, source, and desktop installations current.",
      },
    ],
  },
  {
    title: "Connect",
    items: [
      {
        path: "/docs/remote-access",
        title: "Remote access",
        description:
          "Control any host from anything with a modern web browser.",
      },
      {
        path: "/docs/security-and-privacy",
        title: "Security and privacy",
        description:
          "Understand local data, relay encryption, shares, and analytics.",
      },
    ],
  },
  {
    title: "Use Yep Anywhere",
    items: [
      {
        path: "/docs/providers",
        title: "Providers",
        description: "See stable and experimental agent integrations.",
      },
      {
        path: "/docs/provider-host-control",
        title: "Headless provider control",
        description:
          "Use the experimental Linux provider layer without the web UI.",
      },
      {
        path: "/docs/sessions-and-approvals",
        title: "Sessions and approvals",
        description:
          "Start, resume, steer, queue, and supervise agent sessions.",
      },
      {
        path: "/docs/project-queue",
        title: "Project Queue",
        description:
          "Schedule durable follow-up work after an entire project is quiet.",
      },
      {
        path: "/docs/notifications-and-voice",
        title: "Notifications and voice",
        description: "Stay responsive and talk to agents from a phone.",
      },
      {
        path: "/docs/files-and-source-control",
        title: "Files and source control",
        description: "Open files, review diffs, and use guarded Git actions.",
      },
    ],
  },
  {
    title: "Get help",
    items: [
      {
        path: "/docs/troubleshooting",
        title: "Troubleshooting",
        description:
          "Diagnose startup, provider, connection, and notification problems.",
      },
    ],
  },
];

export const docsItems = docsNavigation.flatMap((section) => section.items);
export const publishedDocPaths = new Set(docsItems.map((item) => item.path));
