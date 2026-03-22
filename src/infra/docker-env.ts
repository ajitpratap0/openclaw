import fs from "node:fs";

/**
 * Detects whether the current process is running inside a Docker container.
 *
 * Checks several signals in priority order:
 *   1. `DOCKER_CONTAINER=true` environment variable (explicit override, useful in tests)
 *   2. `/.dockerenv` file — created by the Docker runtime in every container
 *   3. `container=docker` env var — set by some container runtimes (e.g. podman with Docker compat)
 */
export function isRunningInDocker(opts?: {
  env?: NodeJS.ProcessEnv;
  fsExistsSync?: (path: string) => boolean;
}): boolean {
  const env = opts?.env ?? process.env;
  const existsSync = opts?.fsExistsSync ?? ((p: string) => fs.existsSync(p));

  if (env.DOCKER_CONTAINER === "true") {
    return true;
  }

  if (env.container === "docker") {
    return true;
  }

  try {
    if (existsSync("/.dockerenv")) {
      return true;
    }
  } catch {
    // Ignore access errors; treat as not in Docker
  }

  return false;
}
