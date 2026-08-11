#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageName = "@bybrawe/opencode-goal"
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJSON = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: unknown }
if (typeof packageJSON.version !== "string" || !packageJSON.version.trim()) throw new Error("package version is missing")
const packageVersion = packageJSON.version
const packageSpec = `${packageName}@${packageVersion}`
const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const commandDir = join(configDir, "commands")
const goalCommandPath = join(commandDir, "goal.md")
const managedCommandMarker = "<!-- managed-by:@bybrawe/opencode-goal -->"
const goalCommandContent = `---\ndescription: Set or manage a persistent evidence-verified goal\n---\n\n${managedCommandMarker}\n$ARGUMENTS\n`
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const installerArgs = process.argv.slice(2)
const uninstallRequested = installerArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(installerArgs[0] ?? "")

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`OpenCode Goals installer/updater\n\nUsage:\n  opencode-goal\n  npx -y @bybrawe/opencode-goal@latest\n  npx -y @bybrawe/opencode-goal@latest --uninstall\n\nInstall/update adds ${packageName} to the global OpenCode config, pins the exact package version,\nand installs a managed global commands/goal.md so /goal is discoverable in current OpenCode CLI/TUI.\nUninstall removes OpenCode Goals package/local plugin registrations and the managed /goal command\nbut preserves project Goal state and any user-owned goal.md file.\n\nSet OPENCODE_CONFIG_DIR to target a non-default OpenCode config directory.`)
  process.exit(0)
}

if (installerArgs.includes("--version") || installerArgs.includes("-v")) {
  console.log(packageVersion)
  process.exit(0)
}

if (installerArgs.length && !uninstallRequested) {
  console.error(`Unknown installer option: ${installerArgs[0]}`)
  process.exit(2)
}

function stripJsonComments(input: string): string {
  let output = ""
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ""
    const next = input[index + 1] ?? ""
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index += 1
      } else if (char === "\n" || char === "\r") {
        output += char
      }
      continue
    }
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') {
      quote = char
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    output += char
  }
  return output
}

function stripTrailingCommas(input: string): string {
  let output = ""
  let quote = ""
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ""
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') {
      quote = char
      output += char
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (/\s/.test(input[lookahead] ?? "")) lookahead += 1
      if (input[lookahead] === "]" || input[lookahead] === "}") continue
    }
    output += char
  }
  return output
}

function parseJsonc(input: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripTrailingCommas(stripJsonComments(input)))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenCode config root must be a JSON object")
  return parsed as Record<string, unknown>
}

function skipTrivia(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end < 0) throw new Error("unterminated block comment in OpenCode config")
      index = end + 2
      continue
    }
    break
  }
  return index
}

function readJsonString(source: string, start: number): { value: string; end: number } {
  if (source[start] !== '"') throw new Error("expected JSON string")
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? ""
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      const end = index + 1
      return { value: JSON.parse(source.slice(start, end)) as string, end }
    }
  }
  throw new Error("unterminated JSON string in OpenCode config")
}

function skipJsonValue(source: string, start: number): number {
  const valueStart = skipTrivia(source, start)
  const first = source[valueStart]
  if (first === '"') return readJsonString(source, valueStart).end
  if (first === "{" || first === "[") {
    const stack: string[] = []
    let quoted = false
    let escaped = false
    let lineComment = false
    let blockComment = false
    for (let index = valueStart; index < source.length; index += 1) {
      const char = source[index] ?? ""
      const next = source[index + 1] ?? ""
      if (lineComment) {
        if (char === "\n" || char === "\r") lineComment = false
        continue
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false
          index += 1
        }
        continue
      }
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') {
        quoted = true
        continue
      }
      if (char === "/" && next === "/") {
        lineComment = true
        index += 1
        continue
      }
      if (char === "/" && next === "*") {
        blockComment = true
        index += 1
        continue
      }
      if (char === "{" || char === "[") stack.push(char)
      else if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "["
        if (stack.at(-1) !== expected) throw new Error("mismatched JSON delimiters in OpenCode config")
        stack.pop()
        if (!stack.length) return index + 1
      }
    }
    throw new Error("unterminated JSON value in OpenCode config")
  }

  let index = valueStart
  while (index < source.length) {
    const char = source[index] ?? ""
    if (char === "," || char === "}" || char === "]") return index
    index += 1
  }
  return index
}

type RootPropertyScan = {
  property?: { valueStart: number; valueEnd: number; indent: string }
  rootClose: number
  firstIndent?: string
  lastValueEnd?: number
  lastHadComma: boolean
}

function scanRootProperty(source: string, propertyName: string): RootPropertyScan {
  let index = skipTrivia(source, 0)
  if (source[index] !== "{") throw new Error("OpenCode config must contain one root object")
  index += 1
  let firstIndent: string | undefined
  let lastValueEnd: number | undefined
  let lastHadComma = false

  while (true) {
    index = skipTrivia(source, index)
    if (source[index] === "}") {
      return {
        rootClose: index,
        lastHadComma,
        ...(firstIndent !== undefined ? { firstIndent } : {}),
        ...(lastValueEnd !== undefined ? { lastValueEnd } : {}),
      }
    }
    const keyStart = index
    const key = readJsonString(source, keyStart)
    const lineStart = Math.max(source.lastIndexOf("\n", keyStart - 1), source.lastIndexOf("\r", keyStart - 1)) + 1
    const indent = source.slice(lineStart, keyStart).match(/^[\t ]*/)?.[0] ?? "  "
    if (firstIndent === undefined) firstIndent = indent

    index = skipTrivia(source, key.end)
    if (source[index] !== ":") throw new Error(`expected ':' after config property ${key.value}`)
    const valueStart = skipTrivia(source, index + 1)
    const valueEnd = skipJsonValue(source, valueStart)
    lastValueEnd = valueEnd
    const afterValue = skipTrivia(source, valueEnd)
    const hadComma = source[afterValue] === ","
    lastHadComma = hadComma

    if (key.value === propertyName) {
      return {
        property: { valueStart, valueEnd, indent },
        rootClose: findRootClose(source, hadComma ? afterValue + 1 : afterValue),
        lastHadComma,
        ...(firstIndent !== undefined ? { firstIndent } : {}),
        ...(lastValueEnd !== undefined ? { lastValueEnd } : {}),
      }
    }

    if (hadComma) {
      index = afterValue + 1
      continue
    }
    if (source[afterValue] === "}") {
      return {
        rootClose: afterValue,
        lastHadComma: false,
        ...(firstIndent !== undefined ? { firstIndent } : {}),
        ...(lastValueEnd !== undefined ? { lastValueEnd } : {}),
      }
    }
    throw new Error(`expected ',' or '}' after config property ${key.value}`)
  }
}

function findRootClose(source: string, start: number): number {
  let index = start
  while (true) {
    index = skipTrivia(source, index)
    if (source[index] === "}") return index
    const key = readJsonString(source, index)
    index = skipTrivia(source, key.end)
    if (source[index] !== ":") throw new Error(`expected ':' after config property ${key.value}`)
    const valueEnd = skipJsonValue(source, index + 1)
    const afterValue = skipTrivia(source, valueEnd)
    if (source[afterValue] === ",") index = afterValue + 1
    else if (source[afterValue] === "}") return afterValue
    else throw new Error(`expected ',' or '}' after config property ${key.value}`)
  }
}

function isPackageSpec(value: unknown): boolean {
  if (typeof value !== "string") return false
  const spec = value.trim()
  return spec === packageName || spec.startsWith(`${packageName}@`)
}

function isKnownLocalGoalSpec(value: unknown): boolean {
  if (typeof value !== "string") return false
  const normalized = value.trim().replaceAll("\\", "/")
  return normalized === "./plugins/opencode-goal.ts"
    || normalized === "./plugins/opencode-goal.js"
    || normalized.endsWith("/plugins/opencode-goal.ts")
    || normalized.endsWith("/plugins/opencode-goal.js")
}

function formatPluginArray(values: unknown[], indent: string, eol: string): string {
  if (!values.length) return "[]"
  const childIndent = `${indent}  `
  return `[${eol}${values.map((value) => `${childIndent}${JSON.stringify(value)}`).join(`,${eol}`)}${eol}${indent}]`
}

function rewritePluginConfig(source: string, mode: "install" | "uninstall"): { content: string; changed: boolean } {
  const parsed = parseJsonc(source)
  const existing = parsed.plugin
  if (existing !== undefined && !Array.isArray(existing)) throw new Error("OpenCode config 'plugin' must be an array")
  const filtered = ((existing ?? []) as unknown[]).filter((value) => !isPackageSpec(value) && !isKnownLocalGoalSpec(value))
  const nextPlugins = mode === "install" ? [...filtered, packageSpec] : filtered
  const scan = scanRootProperty(source, "plugin")
  const eol = source.includes("\r\n") ? "\r\n" : "\n"

  if (scan.property) {
    const replacement = formatPluginArray(nextPlugins, scan.property.indent, eol)
    const content = `${source.slice(0, scan.property.valueStart)}${replacement}${source.slice(scan.property.valueEnd)}`
    return { content, changed: content !== source }
  }
  if (mode === "uninstall") return { content: source, changed: false }

  const propertyIndent = scan.firstIndent || "  "
  const lineStart = Math.max(source.lastIndexOf("\n", scan.rootClose - 1), source.lastIndexOf("\r", scan.rootClose - 1)) + 1
  const closeIndentOnly = /^[\t ]*$/.test(source.slice(lineStart, scan.rootClose))
  const insertionPoint = closeIndentOnly ? lineStart : scan.rootClose
  let content = source
  let adjustedInsertion = insertionPoint
  if (scan.lastValueEnd !== undefined && !scan.lastHadComma) {
    content = `${content.slice(0, scan.lastValueEnd)},${content.slice(scan.lastValueEnd)}`
    if (scan.lastValueEnd <= adjustedInsertion) adjustedInsertion += 1
  }
  const needsLineBreak = adjustedInsertion > 0 && !content.slice(0, adjustedInsertion).endsWith("\n") && !content.slice(0, adjustedInsertion).endsWith("\r")
  const insertion = `${needsLineBreak ? eol : ""}${propertyIndent}"plugin": [${JSON.stringify(packageSpec)}]${eol}`
  content = `${content.slice(0, adjustedInsertion)}${insertion}${content.slice(adjustedInsertion)}`
  return { content, changed: content !== source }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
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

async function assertGoalCommandAvailable(): Promise<void> {
  if (!(await fileExists(goalCommandPath))) return
  const existing = await readFile(goalCommandPath, "utf8")
  if (existing.includes(managedCommandMarker)) return
  throw new Error(`Refusing to overwrite user-owned OpenCode command: ${goalCommandPath}`)
}

async function installManagedGoalCommand(): Promise<void> {
  await mkdir(commandDir, { recursive: true })
  await writeAtomic(goalCommandPath, goalCommandContent)
}

async function removeManagedGoalCommand(): Promise<boolean> {
  if (!(await fileExists(goalCommandPath))) return false
  const existing = await readFile(goalCommandPath, "utf8")
  if (!existing.includes(managedCommandMarker)) {
    console.warn(`Preserved user-owned OpenCode command: ${goalCommandPath}`)
    return false
  }
  await rm(goalCommandPath, { force: true })
  return true
}

async function removeLegacyLocalCopies(): Promise<void> {
  const pluginDir = join(configDir, "plugins")
  for (const localName of ["opencode-goal.ts", "opencode-goal.js"]) {
    await rm(join(pluginDir, localName), { force: true })
  }
}

async function uninstall(): Promise<void> {
  const plans: Array<{ target: string; content: string; changed: boolean }> = []
  for (const name of configCandidates) {
    const target = join(configDir, name)
    if (!(await fileExists(target))) continue
    const source = await readFile(target, "utf8")
    const updated = rewritePluginConfig(source, "uninstall")
    plans.push({ target, ...updated })
  }

  for (const plan of plans) {
    if (plan.changed) await writeAtomic(plan.target, plan.content)
  }
  await removeLegacyLocalCopies()
  const removedCommand = await removeManagedGoalCommand()

  const changedCount = plans.filter((plan) => plan.changed).length
  console.log(changedCount > 0
    ? `Removed OpenCode Goals registrations from ${changedCount} OpenCode config file(s).`
    : "OpenCode Goals was not registered in the inspected OpenCode config files.")
  console.log("Removed known local opencode-goal.ts/js plugin copies when present.")
  console.log(removedCommand ? `Removed managed /goal command: ${goalCommandPath}` : "No managed /goal command needed removal.")
  console.log("Project Goal state under .opencode/goals, .opencode/goal-sequences, and .opencode/goal-locks is preserved.")
  console.log("Restart OpenCode to finish unloading the plugin.")
}

async function installOrUpdate(): Promise<void> {
  await mkdir(configDir, { recursive: true })
  await assertGoalCommandAvailable()

  let target: string | undefined
  for (const name of configCandidates) {
    const candidate = join(configDir, name)
    if (await fileExists(candidate)) {
      target = candidate
      break
    }
  }

  if (!target) {
    target = join(configDir, "opencode.json")
    const initial = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [packageSpec] }, null, 2)}\n`
    await writeAtomic(target, initial)
    console.log(`Installed OpenCode Goals ${packageVersion} in ${target}`)
  } else {
    const source = await readFile(target, "utf8")
    const updated = rewritePluginConfig(source, "install")
    if (updated.changed) await writeAtomic(target, updated.content)
    console.log(`${updated.changed ? "Installed/updated" : "Already configured"} OpenCode Goals ${packageVersion} in ${target}`)
  }

  await installManagedGoalCommand()
  await removeLegacyLocalCopies()
  console.log(`Pinned plugin spec: ${packageSpec}`)
  console.log(`Installed managed /goal command: ${goalCommandPath}`)
  console.log("Fully restart OpenCode, type /goal, then verify with: /goal status")
}

if (uninstallRequested) await uninstall()
else await installOrUpdate()
