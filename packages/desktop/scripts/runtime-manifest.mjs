export function selectBundledYaVersion(gitDescribe, packageVersion) {
  const described = gitDescribe?.trim();
  if (described && described !== "unknown") {
    return described;
  }

  const fallback = packageVersion?.trim();
  return fallback || "unknown";
}
