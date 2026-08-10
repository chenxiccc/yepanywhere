import { Navigate } from "react-router-dom";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";

export function ProjectSessionsRedirect() {
  const basePath = useRemoteBasePath();
  return <Navigate to={`${basePath}/sessions`} replace />;
}
