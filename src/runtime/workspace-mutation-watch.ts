import { createHash } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"

const MAX_TOUCHED_PATHS = 4_096
const WATCH_SETTLE_MS = 10
const FULL_HASH_BYTES = 64 * 1024
const SAMPLE_BYTES = 4 * 1024

const IGNORED_TOP_LEVEL = new Set([".git", "node_modules"])
const IGNORED_OPENCODE_DIRS = new Set(["goals", "goal-locks", "goal-sequences"])

export interface WorkspaceMutationWatchResult {
  fingerprint?: string
  touchedPaths: number
  overflow: boolean
}

export interface WorkspaceMutationWatch {
  finish(): Promise<WorkspaceMutationWatchResult>
  dispose(): void
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalizeRelative(root: string, filename: string | Buffer | null): string | null {
  if (!filename) return null
  const text = typeof filename === "string" ? filename : filename.toString("utf8")
  if (!text) return null
  const resolved = path.resolve(root, text)
  const relative = path.relative(root, resolved)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

function ignored(relative: string): boolean {
  const [first, second] = relative.split("/")
  if (!first) return true
  if (IGNORED_TOP_LEVEL.has(first)) return true
  if (first !== ".opencode") return false
  if (!second) return true
  return IGNORED_OPENCODE_DIRS.has(second)
}

async function safeExistingAncestor(root: string, realRoot: string, candidate: string): Promise<boolean> {
  let current = path.dirname(candidate)
  while (inside(root, current)) {
    try {
      const real = await fs.realpath(current)
      return inside(realRoot, real)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
    }
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

async function sampledFileState(file: string, size: number): Promise<string> {
  if (size <= FULL_HASH_BYTES) {
    const bytes = await fs.readFile(file)
    return `file:full:${size}:${createHash("sha256").update(bytes).digest("hex")}`
  }

  const length = Math.min(SAMPLE_BYTES, size)
  const positions = [...new Set([
    0,
    Math.max(0, Math.floor((size - length) / 2)),
    Math.max(0, size - length),
  ])]
  const handle = await fs.open(file, "r")
  try {
    const digest = createHash("sha256")
    for (const position of positions) {
      const buffer = Buffer.alloc(length)
      const read = await handle.read(buffer, 0, buffer.length, position)
      digest.update(String(position)).update("\0")
      digest.update(buffer.subarray(0, read.bytesRead)).update("\0")
    }
    return `file:sample:${size}:${digest.digest("hex")}`
  } finally {
    await handle.close()
  }
}

async function pathState(root: string, realRoot: string, relative: string): Promise<string | null> {
  const candidate = path.resolve(root, ...relative.split("/"))
  if (!inside(root, candidate)) return null

  let stat
  try {
    stat = await fs.lstat(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null
    if (!(await safeExistingAncestor(root, realRoot, candidate))) return null
    return `deleted:${relative}`
  }

  // Recursive fs.watch may surface an event for a project symlink when only its
  // external target changed. Do not use symlink events as shell progress at all;
  // this keeps external filesystem activity outside the project trust boundary.
  if (stat.isSymbolicLink()) return null

  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch {
    return null
  }
  if (!inside(realRoot, real)) return null

  if (stat.isDirectory()) return `directory:${relative}`
  if (!stat.isFile()) return `other:${relative}:${stat.mode}:${stat.size}`

  try {
    return `${relative}:${await sampledFileState(real, stat.size)}`
  } catch {
    return null
  }
}

/**
 * Watch project-local filesystem mutations while a shell tool is running.
 *
 * This is advisory stall/progress telemetry only. It deliberately ignores Goal
 * persistence internals, git metadata, and node_modules; never follows a project
 * symlink outside the project; and never lets watcher failures break the shell.
 * Small files are fully hashed. Large files use deterministic first/middle/last
 * content samples plus size so identical rewrites deduplicate without hashing
 * multi-gigabyte capture/build artifacts.
 */
export async function beginWorkspaceMutationWatch(rootInput: string): Promise<WorkspaceMutationWatch | null> {
  const root = path.resolve(rootInput)
  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch {
    return null
  }

  const touched = new Set<string>()
  let overflow = false
  let failed = false
  let closed = false
  let watcher: FSWatcher

  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
      const relative = normalizeRelative(root, filename)
      if (!relative || ignored(relative)) return
      if (touched.has(relative)) return
      if (touched.size >= MAX_TOUCHED_PATHS) {
        overflow = true
        return
      }
      touched.add(relative)
    })
  } catch {
    return null
  }

  watcher.on("error", () => {
    failed = true
  })

  const dispose = () => {
    if (closed) return
    closed = true
    try {
      watcher.close()
    } catch {
      // Advisory watcher cleanup must never interfere with the host tool.
    }
  }

  return {
    dispose,
    async finish() {
      if (closed) return { touchedPaths: 0, overflow: false }
      await new Promise((resolve) => setTimeout(resolve, WATCH_SETTLE_MS))
      dispose()
      if (failed || touched.size === 0) return { touchedPaths: touched.size, overflow }

      const states: string[] = []
      for (const relative of [...touched].sort()) {
        const state = await pathState(root, realRoot, relative)
        if (state) states.push(state)
      }
      if (!states.length) return { touchedPaths: touched.size, overflow }

      const digest = createHash("sha256")
      for (const state of states) digest.update(state).update("\0")
      digest.update(overflow ? "overflow:1" : "overflow:0")
      return {
        fingerprint: `workspace:${digest.digest("hex")}`,
        touchedPaths: touched.size,
        overflow,
      }
    },
  }
}
