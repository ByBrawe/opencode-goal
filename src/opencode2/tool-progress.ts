import { isClearlyReadOnlyShellCommand } from "../runtime/cadence.js"
import { collectMutationFingerprints, type MutationFingerprint } from "../runtime/mutation-progress.js"
import { shellActivityFingerprint, shellGitWorkspaceMarker } from "../opencode/shell-progress.js"

export interface OpenCode2ShellProgressPending {
  sessionID: string
  callID: string
  goalID: string
  revision: number
  command: string
  gitMarker?: string
}

export interface OpenCode2ToolProgressRuntime {
  shellPending: Map<string, OpenCode2ShellProgressPending>
}

const MAX_PENDING_SHELL_CALLS = 512

function key(sessionID: string, callID: string): string {
  return sessionID + "\\u0000" + callID
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function createOpenCode2ToolProgressRuntime(): OpenCode2ToolProgressRuntime {
  return { shellPending: new Map() }
}

export async function rememberOpenCode2ShellBefore(
  runtime: OpenCode2ToolProgressRuntime,
  input: {
    sessionID: string
    callID: string
    tool: string
    args?: any
    directory: string
    goalID: string
    revision: number
  },
): Promise<void> {
  if (input.tool !== "shell" && input.tool !== "bash") return
  const command = text(input.args?.command)
  if (!command) return
  const gitMarker = await shellGitWorkspaceMarker(input.directory)
  runtime.shellPending.set(key(input.sessionID, input.callID), {
    sessionID: input.sessionID,
    callID: input.callID,
    goalID: input.goalID,
    revision: input.revision,
    command,
    ...(gitMarker === undefined ? {} : { gitMarker }),
  })
  while (runtime.shellPending.size > MAX_PENDING_SHELL_CALLS) {
    const oldest = runtime.shellPending.keys().next().value
    if (typeof oldest !== "string") break
    runtime.shellPending.delete(oldest)
  }
}

export async function collectOpenCode2SuccessfulToolProgress(
  runtime: OpenCode2ToolProgressRuntime,
  input: {
    sessionID: string
    callID: string
    tool: string
    args?: any
    metadata?: any
    directory: string
    goalID: string
    revision: number
  },
): Promise<MutationFingerprint[]> {
  if (input.tool === "write" || input.tool === "edit" || input.tool === "apply_patch") {
    return await collectMutationFingerprints({
      root: input.directory,
      tool: input.tool,
      args: input.args,
      metadata: input.metadata,
    })
  }

  if (input.tool !== "shell" && input.tool !== "bash") return []

  const pendingKey = key(input.sessionID, input.callID)
  const pending = runtime.shellPending.get(pendingKey)
  runtime.shellPending.delete(pendingKey)
  if (
    !pending
    || pending.goalID !== input.goalID
    || pending.revision !== input.revision
  ) return []

  const afterGitMarker = await shellGitWorkspaceMarker(input.directory)
  if (pending.gitMarker !== undefined && afterGitMarker !== undefined) {
    if (pending.gitMarker === afterGitMarker) return []
    return [{
      fingerprint: "shell-worktree:" + afterGitMarker,
      summary: "Goal-owned shell command changed the project worktree.",
    }]
  }

  if (isClearlyReadOnlyShellCommand(pending.command)) return []
  const fingerprint = shellActivityFingerprint({ command: pending.command })
  return fingerprint ? [{
    fingerprint,
    summary: "Goal-owned shell command completed outside a detectable Git worktree.",
  }] : []
}

export function forgetOpenCode2ToolProgressCall(
  runtime: OpenCode2ToolProgressRuntime,
  sessionID: string,
  callID: string,
): void {
  runtime.shellPending.delete(key(sessionID, callID))
}

export function forgetOpenCode2ToolProgressSession(
  runtime: OpenCode2ToolProgressRuntime,
  sessionID: string,
): void {
  const prefix = sessionID + "\\u0000"
  for (const callID of runtime.shellPending.keys()) {
    if (callID.startsWith(prefix)) runtime.shellPending.delete(callID)
  }
}
