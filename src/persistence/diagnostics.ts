import { promises as fs } from "node:fs"
import path from "node:path"
import type { GoalState } from "../domain/types.js"
import {
  GoalSequenceIntegrityError,
  GoalSequenceStore,
  type GoalSequenceIntegrityKind,
} from "./sequence-store.js"
import { assertGoalStoragePathSafe, GoalStore, GoalStoreIntegrityError, type GoalStoreIntegrityKind } from "./store.js"

export type GoalStorageDiagnosticKind = GoalStoreIntegrityKind | GoalSequenceIntegrityKind

export interface GoalStorageDiagnosticIssue {
  scope: "live" | "archive" | "queue"
  kind: GoalStorageDiagnosticKind
  file: string
  detail: string
}

export interface GoalStorageDiagnosticReport {
  sessionID: string
  live: { state: "missing" } | { state: "valid"; goal: GoalState } | { state: "invalid"; issue: GoalStorageDiagnosticIssue }
  archives: { state: "valid"; count: number } | { state: "invalid"; issue: GoalStorageDiagnosticIssue }
  queue:
    | { state: "missing" }
    | { state: "valid"; count: number; generation: number }
    | { state: "invalid"; issue: GoalStorageDiagnosticIssue }
  issues: GoalStorageDiagnosticIssue[]
}

function relativeFile(directory: string, file: string): string {
  const value = path.relative(directory, file) || path.basename(file)
  return value.split(path.sep).join("/")
}

function diagnosticIssue(
  directory: string,
  scope: GoalStorageDiagnosticIssue["scope"],
  error: GoalStoreIntegrityError | GoalSequenceIntegrityError,
): GoalStorageDiagnosticIssue {
  const marker = ` at ${error.file}: `
  const index = error.message.indexOf(marker)
  const detail = index >= 0 ? error.message.slice(index + marker.length) : error.message
  return {
    scope,
    kind: error.kind,
    file: relativeFile(directory, error.file),
    detail,
  }
}

async function fileExistsSafe(directory: string, file: string): Promise<boolean> {
  await assertGoalStoragePathSafe(directory, file)
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function diagnoseGoalStorage(directory: string, sessionID: string): Promise<GoalStorageDiagnosticReport> {
  const store = new GoalStore(directory)
  const sequences = new GoalSequenceStore(directory)
  const issues: GoalStorageDiagnosticIssue[] = []

  let live: GoalStorageDiagnosticReport["live"]
  try {
    const goal = await store.load(sessionID)
    live = goal ? { state: "valid", goal } : { state: "missing" }
  } catch (error) {
    if (!(error instanceof GoalStoreIntegrityError)) throw error
    const issue = diagnosticIssue(directory, "live", error)
    issues.push(issue)
    live = { state: "invalid", issue }
  }

  let archives: GoalStorageDiagnosticReport["archives"]
  try {
    const records = await store.history(sessionID, Number.MAX_SAFE_INTEGER)
    archives = { state: "valid", count: records.length }
  } catch (error) {
    if (!(error instanceof GoalStoreIntegrityError)) throw error
    const issue = diagnosticIssue(directory, "archive", error)
    issues.push(issue)
    archives = { state: "invalid", issue }
  }

  let queue: GoalStorageDiagnosticReport["queue"]
  try {
    const file = sequences.fileFor(sessionID)
    if (!(await fileExistsSafe(directory, file))) {
      queue = { state: "missing" }
    } else {
      const sequence = await sequences.load(sessionID)
      queue = { state: "valid", count: sequence.items.length, generation: sequence.generation }
    }
  } catch (error) {
    if (!(error instanceof GoalStoreIntegrityError) && !(error instanceof GoalSequenceIntegrityError)) throw error
    const issue = diagnosticIssue(directory, "queue", error)
    issues.push(issue)
    queue = { state: "invalid", issue }
  }

  return { sessionID, live, archives, queue, issues }
}

export async function scanRecoverableGoalStates(directory: string): Promise<GoalState[]> {
  const store = new GoalStore(directory)
  let names: string[]
  try {
    await assertGoalStoragePathSafe(store.directory, store.root)
    names = await fs.readdir(store.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    if (error instanceof GoalStoreIntegrityError) return []
    throw error
  }

  const states: GoalState[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(store.root, name)
    let raw: string
    try {
      await assertGoalStoragePathSafe(store.directory, file)
      raw = await fs.readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (error instanceof GoalStoreIntegrityError) continue
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue
    const sessionID = (parsed as { sessionID?: unknown }).sessionID
    if (typeof sessionID !== "string" || !sessionID) continue
    if (path.resolve(store.fileFor(sessionID)) !== path.resolve(file)) continue

    try {
      const goal = await store.load(sessionID)
      if (goal) states.push(goal)
    } catch (error) {
      if (error instanceof GoalStoreIntegrityError) continue
      throw error
    }
  }
  return states
}
