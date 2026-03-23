import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toEqual([]);
  });

  it("returns empty contextFiles when isSubsequentTurn is true (skip re-injection)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-subsequent-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents content", "utf8");

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      isSubsequentTurn: true,
    });

    // bootstrapFiles should still be populated for stats/analysis
    expect(result.bootstrapFiles.some((f) => f.name === "AGENTS.md")).toBe(true);
    // contextFiles must be empty — no re-injection on subsequent turns
    expect(result.contextFiles).toEqual([]);
  });

  it("returns contextFiles normally when isSubsequentTurn is false (first turn)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-first-turn-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents content", "utf8");

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      isSubsequentTurn: false,
    });

    expect(result.contextFiles.some((f) => f.path.endsWith("AGENTS.md"))).toBe(true);
  });
});

describe("resolveBootstrapFilesForRun — agentDir", () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-agentdir-"));
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes agentDir AGENTS.md when it differs from workspaceDir", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-1");
    const agentDir = path.join(tempRoot, "agent-1");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent-specific rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir, agentDir });

    const agentFile = files.find(
      (f) => f.name === "AGENTS.md" && f.path === path.join(agentDir, "AGENTS.md"),
    );
    expect(agentFile).toBeDefined();
    expect(agentFile?.content).toBe("agent-specific rules");
    expect(agentFile?.missing).toBe(false);
  });

  it("agentDir AGENTS.md takes priority over workspaceDir AGENTS.md on name collision", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-2");
    const agentDir = path.join(tempRoot, "agent-2");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace rules", "utf8");
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent rules override", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir, agentDir });

    const agentsMd = files.filter((f) => f.name === "AGENTS.md" && !f.missing);
    // Only one AGENTS.md should appear (agentDir version wins)
    expect(agentsMd).toHaveLength(1);
    expect(agentsMd[0]?.content).toBe("agent rules override");
    expect(agentsMd[0]?.path).toBe(path.join(agentDir, "AGENTS.md"));
  });

  it("skips agentDir lookup when agentDir equals workspaceDir", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-same");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "same dir content", "utf8");

    const filesWithSameDir = await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir: workspaceDir,
    });
    const filesWithoutAgentDir = await resolveBootstrapFilesForRun({ workspaceDir });

    // Same result when agentDir === workspaceDir
    expect(filesWithSameDir.filter((f) => f.name === "AGENTS.md" && !f.missing)).toHaveLength(
      filesWithoutAgentDir.filter((f) => f.name === "AGENTS.md" && !f.missing).length,
    );
  });
});
