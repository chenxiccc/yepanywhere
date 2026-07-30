import { lazy, Suspense } from "react";
import { LauncherView } from "./main/LauncherView";

const ServerOutputView = lazy(() =>
  import("./main/ServerOutputView").then((module) => ({
    default: module.ServerOutputView,
  })),
);

function getRequestedView() {
  return new URLSearchParams(window.location.search).get("view");
}

export function App() {
  const requestedView = getRequestedView();

  if (requestedView === "server-output") {
    return (
      <Suspense fallback={<div className="desktop-loading">Loading output…</div>}>
        <ServerOutputView />
      </Suspense>
    );
  }

  return <LauncherView />;
}
