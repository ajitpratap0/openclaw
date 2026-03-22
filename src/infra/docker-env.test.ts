import { describe, expect, it } from "vitest";
import { isRunningInDocker } from "./docker-env.js";

describe("isRunningInDocker", () => {
  const noDockerEnv: NodeJS.ProcessEnv = {};
  const noDockerFile = (_path: string) => false;

  it("returns false when no Docker signals are present", () => {
    expect(isRunningInDocker({ env: noDockerEnv, fsExistsSync: noDockerFile })).toBe(false);
  });

  it("returns true when DOCKER_CONTAINER=true is set", () => {
    expect(
      isRunningInDocker({
        env: { DOCKER_CONTAINER: "true" },
        fsExistsSync: noDockerFile,
      }),
    ).toBe(true);
  });

  it("returns false when DOCKER_CONTAINER is set to a non-true value", () => {
    expect(
      isRunningInDocker({
        env: { DOCKER_CONTAINER: "1" },
        fsExistsSync: noDockerFile,
      }),
    ).toBe(false);
  });

  it("returns true when container=docker is set", () => {
    expect(
      isRunningInDocker({
        env: { container: "docker" },
        fsExistsSync: noDockerFile,
      }),
    ).toBe(true);
  });

  it("returns false when container env var is a different value", () => {
    expect(
      isRunningInDocker({
        env: { container: "podman" },
        fsExistsSync: noDockerFile,
      }),
    ).toBe(false);
  });

  it("returns true when /.dockerenv file exists", () => {
    expect(
      isRunningInDocker({
        env: noDockerEnv,
        fsExistsSync: (p: string) => p === "/.dockerenv",
      }),
    ).toBe(true);
  });

  it("returns false when /.dockerenv does not exist", () => {
    expect(
      isRunningInDocker({
        env: noDockerEnv,
        fsExistsSync: (p: string) => p !== "/.dockerenv",
      }),
    ).toBe(false);
  });

  it("returns false when fsExistsSync throws", () => {
    expect(
      isRunningInDocker({
        env: noDockerEnv,
        fsExistsSync: () => {
          throw new Error("permission denied");
        },
      }),
    ).toBe(false);
  });

  it("DOCKER_CONTAINER=true takes priority over other signals", () => {
    // Even if /.dockerenv is absent, the env var wins
    expect(
      isRunningInDocker({
        env: { DOCKER_CONTAINER: "true", container: "podman" },
        fsExistsSync: noDockerFile,
      }),
    ).toBe(true);
  });
});
