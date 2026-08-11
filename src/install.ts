#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const packageName = "@bybrawe/opencode-goal"
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJSON = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: unknown }
if (typeof packageJSON.version !== "string" || !packageJSON.version.trim()) throw new Error("package version is missing")
const packageVersion = packageJSON.version
const packageSpec = `${packageName}@${packageVersion}`
const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const commandDir = join(configDir, "commands")
const goalCommandPath = join(commandDir, "goal.md")
const managedCommandMarker = "<!-- managed-by:@bybrawe/opencode-goal -->"
const legacyInstaller = join(dirname(fileURLToPath(import.meta.url)), "install-legacy.js")
const installerArgs = process.argv.slice(2)

function runLegacy(targetConfigDir: string, args = installerArgs, inherit = true) {
  const result = spawnSync(process.execPath, [legacyInstaller, ...args], {
    cwd: packageRoot,
    env: { ...process.env, OPENCODE_CONFIG_DIR: targetConfigDir },
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  })
  if (result.error) throw result.error
  return result
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false
    throw error
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.opencode-goal-${process.pid}-${Date.now()}.tmp`
  await writeFile(temporary, content, "utf8")
  try {
    await rename(temporary, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== "EPERM" && code !== "EACCES" && code !== "EXDEV") {
      await rm(temporary, { force: true })
      throw error
    }
    await copyFile(temporary, target)
    await rm(temporary, { force: true })
  }
}

async function assertManagedCommandWritable(): Promise<void> {
  if (!(await fileExists(goalCommandPath))) return
  const existing = await readFile(goalCommandPath, "utf8")
  if (existing.includes(managedCommandMarker)) return
  throw new Error(`Refusing to overwrite user-owned OpenCode command: ${goalCommandPath}`)
}

function assertStageSuccess(result: ReturnType<typeof runLegacy>, source: string): void {
  if (result.status === 0) return
  const details = [String(result.stdout ?? ""), String(result.stderr ?? "")].filter(Boolean).join("\n")
  throw new Error(`OpenCode Goals could not safely update ${source}. No config files were changed.\n${details}`)
}

async function stageConfig(name: string): Promise<{ target: string; content: string; commandContent: string }> {
  const stageDir = await mkdtemp(join(tmpdir(), "opencode-goal-config-stage-"))
  try {
    const source = join(configDir, name)
    const staged = join(stageDir, name)
    await copyFile(source, staged)

    // First pass performs the semantic install/update. A second pass reaches the
    // legacy formatter's fixed point when it had to add a new plugin property,
    // so the first real multi-config install is already byte-idempotent.
    assertStageSuccess(runLegacy(stageDir, [], false), source)
    assertStageSuccess(runLegacy(stageDir, [], false), source)

    return {
      target: source,
      content: await readFile(staged, "utf8"),
      commandContent: await readFile(join(stageDir, "commands", "goal.md"), "utf8"),
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installAcrossExistingConfigs(existing: string[]): Promise<void> {
  await assertManagedCommandWritable()

  const plans = [] as Array<{ target: string; content: string; commandContent: string }>
  for (const name of existing) plans.push(await stageConfig(name))

  for (const plan of plans) await writeAtomic(plan.target, plan.content)

  await mkdir(commandDir, { recursive: true })
  await writeAtomic(goalCommandPath, plans[0]!.commandContent)

  const pluginDir = join(configDir, "plugins")
  for (const localName of ["opencode-goal.ts", "opencode-goal.js"]) {
    await rm(join(pluginDir, localName), { force: true })
  }

  console.log(`Installed/updated OpenCode Goals ${packageVersion} across ${plans.length} OpenCode config files.`)
  for (const plan of plans) console.log(`- ${plan.target}`)
  console.log(`Pinned plugin spec: ${packageSpec}`)
  console.log(`Installed managed /goal command: ${goalCommandPath}`)
  console.log("Fully restart OpenCode, type /goal, then verify with: /goal status")
}

async function main() {
  // Help/version/uninstall/unknown-option behavior remains owned by the battle-tested
  // legacy installer. Multi-config staging is needed only for normal install/update.
  if (installerArgs.length > 0) {
    const result = runLegacy(configDir)
    process.exitCode = result.status ?? 1
    return
  }

  await mkdir(configDir, { recursive: true })
  const existing: string[] = []
  for (const name of configCandidates) {
    if (await fileExists(join(configDir, name))) existing.push(name)
  }

  // With zero or one config file, preserve the original installer path exactly.
  if (existing.length <= 1) {
    const result = runLegacy(configDir, [])
    process.exitCode = result.status ?? 1
    return
  }

  // OpenCode may load more than one global config filename. Stage every rewrite
  // first, then commit them together so a later config cannot shadow the Goal pin.
  await installAcrossExistingConfigs(existing)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
