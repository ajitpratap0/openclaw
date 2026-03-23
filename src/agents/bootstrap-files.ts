import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    sanitized.push({ ...file, path: pathValue });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  const runKind = params.runKind ?? "default";
  if (contextMode !== "lightweight") {
    return params.files;
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === "HEARTBEAT.md");
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

/**
 * Merge bootstrap files from workspaceDir and agentDir.
 * agentDir files take priority over workspaceDir files when both have the same name.
 * Files are deduplicated by name, keeping only one entry per name.
 */
async function mergeBootstrapFilesFromAgentDir(
  workspaceFiles: WorkspaceBootstrapFile[],
  agentDir: string,
): Promise<WorkspaceBootstrapFile[]> {
  const agentFiles = await loadWorkspaceBootstrapFiles(agentDir);
  // Build merged list: agentDir takes priority, then workspaceDir for names not in agentDir
  const merged: WorkspaceBootstrapFile[] = [];
  const seenNames = new Set<string>();
  // Add agentDir non-missing files first (they override workspaceDir files with same name)
  for (const file of agentFiles) {
    if (!file.missing) {
      merged.push(file);
      seenNames.add(file.name);
    }
  }
  // Fill in workspaceDir files for names not already contributed by agentDir
  for (const file of workspaceFiles) {
    if (!seenNames.has(file.name)) {
      merged.push(file);
    }
  }
  return merged;
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  /** Optional agent-specific directory. Files here take priority over workspaceDir files. */
  agentDir?: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);

  // Merge agentDir files when it differs from workspaceDir, so per-agent AGENTS.md
  // and other bootstrap files take effect (issue #29387).
  const resolvedAgentDir = params.agentDir ? resolveUserPath(params.agentDir) : undefined;
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const mergedRawFiles =
    resolvedAgentDir && resolvedAgentDir !== resolvedWorkspaceDir
      ? await mergeBootstrapFilesFromAgentDir(rawFiles, resolvedAgentDir)
      : rawFiles;

  const bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(mergedRawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  /** Optional agent-specific directory. Files here take priority over workspaceDir files. */
  agentDir?: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  /**
   * When true, skip workspace file injection into contextFiles (the session already has them
   * from the first turn). bootstrapFiles are still returned for budget analysis. This avoids
   * re-injecting the same workspace files on every message turn (issue #9157).
   */
  isSubsequentTurn?: boolean;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  // On subsequent turns the session already contains the workspace files in history,
  // so injecting them again wastes tokens without adding information.
  if (params.isSubsequentTurn) {
    return { bootstrapFiles, contextFiles: [] };
  }
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
