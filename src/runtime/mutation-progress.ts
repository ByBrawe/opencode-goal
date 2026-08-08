import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

export interface MutationFingerprint {
  fingerprint: string
  summary: string
}

interface Candidate {
  filePath: string
  deleted?: boolean
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

function lexicalInside(root: string, candidate: string): { absolute: string; relative: string } | null {
  const base = path.resolve(root)
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate)
  const relative = path.relative(base, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return { absolute, relative: relative.split(path.sep).join("/") }
}

async function realInside(root: string, absolute: string): Promise<boolean> {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)])
    const relative = path.relative(realRoot, realFile)
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
  } catch {
    return false
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
    const safe = lexicalInside(input.root, item.filePath)
    if (!safe || seen.has(safe.relative)) continue
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

    if (!(await realInside(input.root, safe.absolute))) continue
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
