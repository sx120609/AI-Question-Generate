import path from "node:path";

export function artifactRootForResult(resultPath) {
  const resolved = path.resolve(resultPath);
  const extension = path.extname(resolved);
  const base = extension ? resolved.slice(0, -extension.length) : resolved;
  return `${base}.artifacts`;
}
