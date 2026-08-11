import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCLI = process.env.npm_execpath
const minimumPeer = "@opencode-ai/plugin@1.4.0"
const managedCommandMarker = "<!-- managed-by:@bybrawe/opencode-goal -->"

function parseArgs(argv) {
  const options = { jsonPath: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      const value = argv[++i]
      if (!value) throw new Error("--json expects a file path")
      options.jsonPath = value
      continue
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length)
      continue
    }
    throw new Error(`unknown package smoke option: ${arg}`)
  }
  return options
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `command failed (${result.status}): ${command} ${args.join(" ")}`,
      String(result.stdout ?? ""),
      String(result.stderr ?? ""),
    ].filter(Boolean).join("\n"))
  }
  return result
}

function runNpm(args, options = {}) {
  if (!npmCLI) throw new Error("npm_execpath is unavailable; run package smoke through npm run package:smoke")
  return run(process.execPath, [npmCLI, ...args], options)
}

function parsePackResult(stdout) {
  const value = JSON.parse(stdout)
  if (!Array.isArray(value) || value.length !== 1 || !value[0]?.filename || !Array.isArray(value[0]?.files)) {
    throw new Error(`unexpected npm pack --json output: ${stdout}`)
  }
  return value[0]
}

function assertPackageFiles(pack) {
  const files = new Set(pack.files.map((item) => String(item.path).replaceAll("\\", "/")))
  const required = [
    "package.json", "README.md", "CHANGELOG.md", "LICENSE",
    "dist/index.js", "dist/index.d.ts", "dist/install.js", "dist/tui/index.js", "dist/tui/index.d.ts",
  ]
  for (const file of required) {
    if (!files.has(file)) throw new Error(`publish tarball is missing required file: ${file}`)
  }

  const forbiddenPrefixes = ["src/", "test/", "scripts/", ".github/", "eval/", "node_modules/", ".opencode/"]
  const leaked = [...files].filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)))
  if (leaked.length) throw new Error(`publish tarball leaked development files: ${leaked.join(", ")}`)
  return [...files].sort()
}

async function exists(target) {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return false
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  if (packageJSON.private === true) throw new Error("package.json is private and cannot be published")
  if (packageJSON.publishConfig?.access !== "public") throw new Error("scoped public package must set publishConfig.access=public")
  if (packageJSON.peerDependencies?.["@opencode-ai/plugin"] !== ">=1.4.0") {
    throw new Error("package smoke minimum peer fixture must match peerDependencies['@opencode-ai/plugin'] >=1.4.0")
  }
  if (!packageJSON.exports?.["./tui"]?.import) throw new Error("package.json must expose the target-exclusive ./tui entrypoint")
  if (packageJSON.bin?.["opencode-goal"] !== "./dist/install.js") throw new Error("package.json must expose the opencode-goal installer bin")
  if (!packageJSON.repository?.url || !packageJSON.homepage || !packageJSON.bugs?.url) {
    throw new Error("package.json release metadata is incomplete (repository/homepage/bugs)")
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-package-smoke-"))
  const consumer = path.join(temp, "consumer")
  try {
    const packed = parsePackResult(runNpm(["pack", root, "--json", "--ignore-scripts"], { cwd: temp }).stdout)
    const files = assertPackageFiles(packed)
    const tarball = path.join(temp, packed.filename)

    await mkdir(consumer, { recursive: true })
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`)
    runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      minimumPeer,
      tarball,
    ], { cwd: consumer })

    const probe = String.raw`
      import fs from "node:fs";
      import path from "node:path";
      import { fileURLToPath } from "node:url";
      const mod = await import("@bybrawe/opencode-goal");
      if (typeof mod.default !== "function") throw new Error("default OpenCode plugin export is missing");
      if (typeof mod.createGoal !== "function") throw new Error("createGoal export is missing");
      if (typeof mod.parseGoalCommand !== "function") throw new Error("parseGoalCommand export is missing");
      if (typeof mod.GoalSequenceStore !== "function") throw new Error("GoalSequenceStore export is missing");
      const tui = await import("@bybrawe/opencode-goal/tui");
      if (typeof tui.default?.tui !== "function") throw new Error("TUI plugin export is missing");
      if (tui.default?.id !== "opencode-goal") throw new Error("TUI plugin id is incorrect");
      const entryDir = path.dirname(fileURLToPath(import.meta.resolve("@bybrawe/opencode-goal")));
      if (!fs.existsSync(path.join(entryDir, "index.d.ts"))) throw new Error("published type declarations are missing");
      console.log("consumer import ok");
    `
    const consumerResult = run(process.execPath, ["--input-type=module", "--eval", probe], { cwd: consumer })

    const installedRoot = path.join(consumer, "node_modules", "@bybrawe", "opencode-goal")
    const installerPath = path.join(installedRoot, "dist", "install.js")
    const installerConfig = path.join(temp, "installer-config")
    const installerEnv = { ...process.env, OPENCODE_CONFIG_DIR: installerConfig }
    const installerVersion = run(process.execPath, [installerPath, "--version"], { cwd: consumer, env: installerEnv })
    if (String(installerVersion.stdout ?? "").trim() !== packageJSON.version) throw new Error("published installer reports the wrong version")

    run(process.execPath, [installerPath], { cwd: consumer, env: installerEnv })
    const configPath = path.join(installerConfig, "opencode.json")
    const installedConfig = JSON.parse(await readFile(configPath, "utf8"))
    if (!Array.isArray(installedConfig.plugin) || installedConfig.plugin.length !== 1 || installedConfig.plugin[0] !== `${packageJSON.name}@${packageJSON.version}`) {
      throw new Error("published installer did not create the exact OpenCode plugin pin")
    }
    const commandPath = path.join(installerConfig, "commands", "goal.md")
    const commandContent = await readFile(commandPath, "utf8")
    if (!commandContent.includes(managedCommandMarker) || !commandContent.includes("$ARGUMENTS")) {
      throw new Error("published installer did not create the managed discoverable /goal command")
    }

    run(process.execPath, [installerPath, "--uninstall"], { cwd: consumer, env: installerEnv })
    const uninstalledConfig = JSON.parse(await readFile(configPath, "utf8"))
    if (!Array.isArray(uninstalledConfig.plugin) || uninstalledConfig.plugin.some((value) => String(value).startsWith(packageJSON.name))) {
      throw new Error("published installer uninstall did not remove the OpenCode Goals package registration")
    }
    if (await exists(commandPath)) throw new Error("published installer uninstall did not remove its managed /goal command")

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npmPackage: packageJSON.name,
      version: packageJSON.version,
      minimumPeer,
      filename: packed.filename,
      packageSize: packed.size,
      unpackedSize: packed.unpackedSize,
      fileCount: files.length,
      files,
      consumerImport: /consumer import ok/.test(String(consumerResult.stdout ?? "")),
      installer: true,
      commandDiscovery: true,
      uninstaller: true,
      gate: true,
    }

    console.log(`package ${report.npmPackage}@${report.version}`)
    console.log(`minimum runtime peer ${minimumPeer}`)
    console.log(`tarball ${report.filename} files=${report.fileCount} packed=${report.packageSize} unpacked=${report.unpackedSize}`)
    console.log("clean consumer server + TUI import + installer + /goal command + uninstaller PASS")

    if (options.jsonPath) {
      const target = path.resolve(root, options.jsonPath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`report ${path.relative(root, target).replaceAll(path.sep, "/")}`)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
