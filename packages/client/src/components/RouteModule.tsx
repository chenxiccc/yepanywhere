import { type ReactNode, Suspense } from "react";
import { useI18n } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { StartupShell } from "./StartupShell";

export function RouteModule({ children }: { children: ReactNode }) {
  const { t } = useI18n();

  return (
    <ErrorBoundary>
      <Suspense
        fallback={<StartupShell phase="module">{t("loading")}</StartupShell>}
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

export function routeModule(element: ReactNode) {
  return <RouteModule>{element}</RouteModule>;
}
