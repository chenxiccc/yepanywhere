import { type ReactNode, Suspense } from "react";
import { useI18n } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";

export function RouteModule({ children }: { children: ReactNode }) {
  const { t } = useI18n();

  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="loading" role="status">
            {t("loading")}
          </div>
        }
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

export function routeModule(element: ReactNode) {
  return <RouteModule>{element}</RouteModule>;
}
