import { Navigate, useLocation } from "react-router-dom";
import { getLegacyRelayRedirectTarget } from "../lib/remoteRoutePaths";

export function LegacyRelayRouteRedirect() {
  const location = useLocation();
  const target = getLegacyRelayRedirectTarget(location);
  return <Navigate to={target ?? "/projects"} replace />;
}
