import { useEffect, useState } from "react";
import {
  getDataDir,
  getServerOutputBuffer,
  getServerError,
  getServerStatus,
  isDevMode,
  openDashboardWindow,
  openServerOutputWindow,
  quitApp,
  startServer,
} from "../tauri";

export function LauncherView() {
  const [status, setStatus] = useState("checking");
  const [dataDir, setDataDir] = useState("");
  const [devDir, setDevDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recentOutput, setRecentOutput] = useState("");

  const refresh = () => {
    getServerStatus()
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus !== "running") {
          void getServerError().then(setError);
          void getServerOutputBuffer().then((chunks) => {
            setRecentOutput(
              chunks
                .map((chunk) => chunk.data)
                .join("")
                .slice(-8000),
            );
          });
        }
      })
      .catch((value) => {
        setStatus("error");
        setError(String(value));
      });
  };

  useEffect(() => {
    refresh();
    void getDataDir().then(setDataDir);
    void isDevMode().then(setDevDir);
    const interval = window.setInterval(refresh, 3000);
    return () => window.clearInterval(interval);
  }, []);

  const openDashboard = async () => {
    setBusy(true);
    setError(null);
    try {
      if ((await getServerStatus()) !== "running") {
        await startServer();
      }
      await openDashboardWindow();
      refresh();
    } catch (value) {
      setError(String(value));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="launcher-view">
      <div className="desktop-titlebar" data-tauri-drag-region />
      <main className="launcher-content">
        <h1>Yep Anywhere</h1>
        <p className={`desktop-runtime-status is-${status}`}>
          Bundled server: {status}
        </p>
        {error && <p className="desktop-runtime-error">{error}</p>}
        {(error || status === "error" || status === "stopped") &&
          recentOutput && (
            <pre className="desktop-runtime-output">{recentOutput}</pre>
          )}
        <div className="launcher-actions">
          <button
            className="btn-primary"
            onClick={openDashboard}
            disabled={busy}
          >
            {busy ? "Starting..." : error ? "Retry" : "Open Dashboard"}
          </button>
          <button className="btn-secondary" onClick={openServerOutputWindow}>
            Server Output
          </button>
          <button className="btn-secondary" onClick={quitApp}>
            Quit
          </button>
        </div>
        <dl className="desktop-runtime-details">
          <dt>Data</dt>
          <dd>{dataDir || "Loading..."}</dd>
          <dt>Runtime</dt>
          <dd>{devDir ? `Development checkout: ${devDir}` : "Stable bundle"}</dd>
        </dl>
      </main>
    </div>
  );
}
