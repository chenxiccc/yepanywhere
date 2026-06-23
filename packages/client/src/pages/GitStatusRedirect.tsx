import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useProjects } from "../hooks/useProjects";

/**
 * 将旧的 /git-status?projectId=xxx 重定向到 /projects/:projectId/source
 * Redirect old /git-status?projectId=xxx to /projects/:projectId/source
 */
export function GitStatusRedirect() {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [searchParams] = useSearchParams();
  const { projects } = useProjects();

  useEffect(() => {
    const projectId = searchParams.get("projectId") || projects[0]?.id;
    if (projectId) {
      navigate(`${basePath}/projects/${projectId}/source`, { replace: true });
    } else {
      navigate(`${basePath}/projects`, { replace: true });
    }
  }, [navigate, basePath, searchParams, projects]);

  return null;
}