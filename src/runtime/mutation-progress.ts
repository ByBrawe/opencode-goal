import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { isGoalControlPlanePath } from "./control-plane-path.js"

export interface MutationFingerprint {
  fingerprint: string
  summary: string
}

interface Candidate {
  filePath: string
  deleted?: boolean
}

interface SafePath {
  absolute: string
  relative: string
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function candidates(tool: string, args: any, metadata: any): Candidate[] {
  if (tool === "write" || tool === "edit") {
    const filePath = asString(metadata?.filepath)
      ?? asString(metadata?.filediff?.file)
      ?? asString(args?.filePath)
      ?? asString(args?.path)
      ?? asString(args?.file_path)
    return filePath ? [{ filePath }] : []
  }

  if (tool === "apply_patch") {
    const files = Array.isArray(metadata?.files) ? metadata.files : []
    return files.flatMap((item: any) => {
      const type = asString(item?.type)
      const moved = asString(item?.movePath)
      const original = asString(item?.filePath)
      if (type === "move" && moved) return [{ filePath: moved }]
      if (type === "delete" && original) return [{ filePath: original, deleted: true }]
      return original ? [{ filePath: original }] : []
    })
  }

  return []
}

function relativeInside(realRoot: string, realCandidate: string): string | null {
  const relative = path.relative(realRoot, realCandidate)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

async function canonicalInside(root: string, candidate: string, deleted = false): Promise<SafePath | null> {
  try {
    const realRoot = await fs.realpath(root)
    const unresolved = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)

    if (!deleted) {
      // Resolve the file itself before containment. On Windows this normalizes
      // 8.3 aliases such as RUNNER~1 to the same canonical path OpenCode uses,
      // while also preventing symlinks inside the project from escaping it.
      const absolute = await fs.realpath(unresolved)
      const relative = relativeInside(realRoot, absolute)
      return relative ? { absolute, relative } : null
    }

    // A deleted file cannot be realpath'ed. Canonicalize its still-existing
    // parent instead, then reconstruct the deleted project-local path.
    const realParent = await fs.realpath(path.dirname(unresolved))
    const absolute = path.join(realParent, path.basename(unresolved))
    const relative = relativeInside(realRoot, absolute)
    return relative ? { absolute, relative } : null
  } catch {
    return null
  }
}

export async function collectMutationFingerprints(input: {
  root: string
  tool: string
  args?: any
  metadata?: any
}): Promise<MutationFingerprint[]> {
  const found = candidates(input.tool, input.args, input.metadata)
  const output: MutationFingerprint[] = []
  const seen = new Set<string>()

  for (const item of found) {
    const safe = await canonicalInside(input.root, item.filePath, item.deleted === true)
    if (!safe || isGoalControlPlanePath(safe.relative) || seen.has(safe.relative)) continue
    seen.add(safe.relative)

    if (item.deleted) {
      try {
        await fs.access(safe.absolute)
        continue
      } catch (error: any) {
        if (error?.code !== "ENOENT") continue
      }
      output.push({
        fingerprint: `file:${safe.relative}:deleted`,
        summary: `Project file deleted: ${safe.relative}`,
      })
      continue
    }

    let bytes: Buffer
    try {
      bytes = await fs.readFile(safe.absolute)
    } catch {
      continue
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    output.push({
      fingerprint: `file:${safe.relative}:${sha256}`,
      summary: `Project file content changed: ${safe.relative}`,
    })
  }

  return output
}
