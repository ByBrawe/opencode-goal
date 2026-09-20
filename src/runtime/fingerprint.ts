import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { GoalRuntimeFingerprint, GoalState } from "../domain/types.js"

const require = createRequire(import.meta.url)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function cleanIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 256) : undefined
}

function packageVersionFromManifest(file: string, expectedName?: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown }
    if (expectedName && parsed.name !== expectedName) return undefined
    return cleanIdentity(parsed.version)
  } catch {
    return undefined
  }
}

function packageVersionNear(entry: string, expectedName: string): string | undefined {
  let current = path.dirname(entry)
  for (let depth = 0; depth < 12; depth += 1) {
    const version = packageVersionFromManifest(path.join(current, "package.json"), expectedName)
    if (version) return version
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function resolvePackageVersion(name: string): string | undefined {
  try {
    return packageVersionFromManifest(require.resolve(`${name}/package.json`), name)
  } catch {
    try {
      return packageVersionNear(require.resolve(name), name)
    } catch {
      return undefined
    }
  }
}

function runtimeBuildIdentity(): string | undefined {
  const distRoot = path.join(packageRoot, "dist")
  try {
    const files: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile() && entry.name.endsWith(".js")) files.push(absolute)
      }
    }
    visit(distRoot)
    if (!files.length) return undefined

    const hash = createHash("sha256")
    for (const file of files) {
      hash.update(path.relative(distRoot, file).split(path.sep).join("/"))
      hash.update("\0")
      hash.update(readFileSync(file))
      hash.update("\0")
    }
    return `sha256:${hash.digest("hex")}`
  } catch {
    return undefined
  }
}

function currentFingerprint(): GoalRuntimeFingerprint {
  const goalVersion = packageVersionFromManifest(path.join(packageRoot, "package.json"), "@bybrawe/opencode-goal") ?? "unknown"
  const goalBuild = cleanIdentity(process.env.OPENCODE_GOAL_BUILD_SHA)
    ? `git:${cleanIdentity(process.env.OPENCODE_GOAL_BUILD_SHA)}`
    : runtimeBuildIdentity()
  const opencodeVersion = cleanIdentity(process.env.OPENCODE_VERSION) ?? resolvePackageVersion("opencode-ai")
  const pluginApiVersion = resolvePackageVersion("@opencode-ai/plugin")
  const loopVersion = cleanIdentity(process.env.OPENCODE_LOOP_VERSION) ?? resolvePackageVersion("@bybrawe/opencode-loop")

  return {
    goalVersion,
    ...(goalBuild ? { goalBuild } : {}),
    ...(opencodeVersion ? { opencodeVersion } : {}),
    ...(pluginApiVersion ? { pluginApiVersion } : {}),
    ...(loopVersion ? { loopVersion } : {}),
  }
}

const CURRENT_FINGERPRINT = Object.freeze(currentFingerprint())

export function currentGoalRuntimeFingerprint(): GoalRuntimeFingerprint {
  return { ...CURRENT_FINGERPRINT }
}

export function stampGoalRuntimeFingerprint(goal: GoalState): GoalState {
  if (!isDeepStrictEqual(goal.runtimeFingerprint, CURRENT_FINGERPRINT)) {
    goal.runtimeFingerprint = currentGoalRuntimeFingerprint()
  }
  return goal
}

export function formatGoalRuntimeFingerprint(value: GoalRuntimeFingerprint | undefined): string {
  if (!value) return "legacy/unknown"
  const parts = [`Goal ${value.goalVersion}`]
  if (value.goalBuild) parts.push(`build ${value.goalBuild}`)
  if (value.opencodeVersion) parts.push(`OpenCode ${value.opencodeVersion}`)
  if (value.pluginApiVersion) parts.push(`plugin-api ${value.pluginApiVersion}`)
  if (value.loopVersion) parts.push(`Loop ${value.loopVersion}`)
  return parts.join(", ")
}
