type ViewerPresenceListener = (hasViewers: boolean) => void;

/**
 * Viewer presence for one provider process.
 *
 * Mounted live-session streams retain their own idle provider process. The
 * registry publishes first-viewer and last-viewer transitions so that Process
 * can suspend or restart its idle grace without tracking individual tabs.
 */
export class SessionViewerPresence {
  private viewerCount = 0;
  private readonly listeners = new Set<ViewerPresenceListener>();

  hasViewers(): boolean {
    return this.viewerCount > 0;
  }

  getViewerCount(): number {
    return this.viewerCount;
  }

  registerViewer(): () => void {
    this.viewerCount += 1;
    if (this.viewerCount === 1) {
      this.publish(true);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.viewerCount = Math.max(0, this.viewerCount - 1);
      if (this.viewerCount === 0) {
        this.publish(false);
      }
    };
  }

  subscribe(listener: ViewerPresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(hasViewers: boolean): void {
    for (const listener of this.listeners) {
      listener(hasViewers);
    }
  }
}
