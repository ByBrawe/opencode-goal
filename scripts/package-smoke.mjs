import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCLI = process.env.npm_execpath
const runtimeDependency = "@opencode-ai/plugin"
const runtimeDependencyRange = ">=1.4.0 <2"
const v2RuntimeDependency = "@opencode/plugin"
const v2RuntimeDependencyRange = "^2.0.4"
const minimumOpenCode = ">=1.4.0"
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
    "package.json", "README.md", "CHANGELOG.md", "LICENSE", "bin/opencode-goal.js",
    "dist/index.js", "dist/index.d.ts", "dist/server.js", "dist/server.d.ts",
    "dist/install.js", "dist/tui/index.js", "dist/tui/index.d.ts",
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
  if (packageJSON.engines?.opencode !== minimumOpenCode) {
    throw new Error(`package smoke requires engines.opencode ${minimumOpenCode}`)
  }
  if (packageJSON.dependencies?.[runtimeDependency] !== runtimeDependencyRange) {
    throw new Error(`package smoke requires ${runtimeDependency} as a production dependency (${runtimeDependencyRange}) because dist imports it at runtime`)
  }
  if (packageJSON.peerDependencies?.[runtimeDependency]) {
    throw new Error(`${runtimeDependency} must not be peer-only; OpenCode installs npm plugins into an isolated production cache`)
  }
  if (packageJSON.dependencies?.[v2RuntimeDependency] !== v2RuntimeDependencyRange) {
    throw new Error(`package smoke requires ${v2RuntimeDependency} as a production dependency (${v2RuntimeDependencyRange}) for the stable OpenCode 2 plugin contract`)
  }
  if (packageJSON.peerDependencies?.[v2RuntimeDependency]) {
    throw new Error(`${v2RuntimeDependency} must not be peer-only; published V2 plugins must carry a compatible plugin runtime dependency`)
  }
  if (!packageJSON.exports?.["./server"]?.import) throw new Error("package.json must expose the OpenCode ./server entrypoint")
  if (!packageJSON.exports?.["./tui"]?.import) throw new Error("package.json must expose the target-exclusive ./tui entrypoint")
  if (packageJSON.bin?.["opencode-goal"] !== "bin/opencode-goal.js") throw new Error("package.json must expose the npm-canonical committed opencode-goal installer bin shim")
  if (!packageJSON.files?.includes("bin")) throw new Error("package.json files must include the committed installer bin directory")
  if (!(await exists(path.join(root, "bin", "opencode-goal.js")))) throw new Error("committed installer bin shim is missing before packaging")
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
      "--omit=dev",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      tarball,
    ], { cwd: consumer })

    const probe = String.raw`
      import fs from "node:fs";
      import path from "node:path";
      import { fileURLToPath } from "node:url";
      const mod = await import("@bybrawe/opencode-goal");
      if (typeof mod.default !== "function") throw new Error("default public API plugin export is missing");
      if (typeof mod.createGoal !== "function") throw new Error("createGoal export is missing");
      if (typeof mod.parseGoalCommand !== "function") throw new Error("parseGoalCommand export is missing");
      if (typeof mod.GoalSequenceStore !== "function") throw new Error("GoalSequenceStore export is missing");
      if (Object.keys(mod).length <= 1) throw new Error("public root API should remain a multi-export library barrel");
      const server = await import("@bybrawe/opencode-goal/server");
      if (JSON.stringify(Object.keys(server)) !== JSON.stringify(["default"])) throw new Error("server entrypoint must export only the plugin module");
      if (server.default?.id !== "@bybrawe/opencode-goal") throw new Error("server plugin id is incorrect");
      if (typeof server.default?.server !== "function") throw new Error("server plugin export is missing");
      if (typeof server.default?.setup !== "function") throw new Error("OpenCode 2 setup export is missing");
      if (server.default.server !== mod.default) throw new Error("server entrypoint does not delegate to the public plugin implementation");
      const toolModule = await import("@opencode-ai/plugin/tool");
      if (typeof toolModule.tool !== "function") throw new Error("runtime OpenCode V1 tool dependency is missing");
      const v2Plugin = await import("@opencode/plugin");
      if (typeof v2Plugin.Plugin?.define !== "function") throw new Error("runtime OpenCode V2 plugin dependency is missing");
      const tui = await import("@bybrawe/opencode-goal/tui");
      if (typeof tui.default?.tui !== "function") throw new Error("TUI plugin export is missing");
      if (tui.default?.id !== "opencode-goal") throw new Error("TUI plugin id is incorrect");
      const entryDir = path.dirname(fileURLToPath(import.meta.resolve("@bybrawe/opencode-goal")));
      if (!fs.existsSync(path.join(entryDir, "index.d.ts"))) throw new Error("published type declarations are missing");
      console.log("consumer import ok");
    `
    const consumerResult = run(process.execPath, ["--input-type=module", "--eval", probe], { cwd: consumer })

    const installedRoot = path.join(consumer, "node_modules", "@bybrawe", "opencode-goal")
    const installedPackageJSON = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"))
    const installedBin = installedPackageJSON.bin?.["opencode-goal"]
    if (installedBin !== "bin/opencode-goal.js") {
      throw new Error(`installed package lost or rewrote the canonical opencode-goal bin manifest: ${String(installedBin)}`)
    }

    const installerPath = path.join(installedRoot, "bin", "opencode-goal.js")
    if (!(await exists(installerPath))) throw new Error("installed package is missing the committed installer bin shim")
    const linkedBin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "opencode-goal.cmd" : "opencode-goal")
    if (!(await exists(linkedBin))) throw new Error("npm did not create the opencode-goal executable link from the package bin manifest")

    const installerConfig = path.join(temp, "installer-config")
    const installerEnv = {
      ...process.env,
      OPENCODE_CONFIG_DIR: installerConfig,
      OPENCODE_GOAL_HOST_VERSION: "1.17.15",
    }
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

    const installerV2Config = path.join(temp, "installer-v2-config")
    const installerV2Env = {
      ...process.env,
      OPENCODE_CONFIG_DIR: installerV2Config,
      OPENCODE_GOAL_HOST_VERSION: "2.0.15",
    }
    run(process.execPath, [installerPath], { cwd: consumer, env: installerV2Env })
    const configV2Path = path.join(installerV2Config, "opencode.json")
    const installedV2Config = JSON.parse(await readFile(configV2Path, "utf8"))
    if (!Array.isArray(installedV2Config.plugins) || installedV2Config.plugins.length !== 1 || installedV2Config.plugins[0] !== `${packageJSON.name}@${packageJSON.version}`) {
      throw new Error("published installer did not create the exact OpenCode 2 plugins pin")
    }
    if (installedV2Config.plugin !== undefined) {
      throw new Error("published OpenCode 2 installer wrote the legacy singular plugin key")
    }
    const commandV2Path = path.join(installerV2Config, "commands", "goal.md")
    if (await exists(commandV2Path)) {
      throw new Error("published OpenCode 2 installer created the legacy managed /goal command bridge")
    }

    run(process.execPath, [installerPath, "--uninstall"], { cwd: consumer, env: installerV2Env })
    const uninstalledV2Config = JSON.parse(await readFile(configV2Path, "utf8"))
    if (!Array.isArray(uninstalledV2Config.plugins) || uninstalledV2Config.plugins.some((value) => {
      const spec = typeof value === "string" ? value : value?.package
      return typeof spec === "string" && spec.startsWith(packageJSON.name)
    })) {
      throw new Error("published OpenCode 2 installer uninstall did not remove the Goal registration")
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npmPackage: packageJSON.name,
      version: packageJSON.version,
      minimumOpenCode,
      runtimeDependency: `${runtimeDependency}@${runtimeDependencyRange}`,
      v2RuntimeDependency: `${v2RuntimeDependency}@${v2RuntimeDependencyRange}`,
      filename: packed.filename,
      packageSize: packed.size,
      unpackedSize: packed.unpackedSize,
      fileCount: files.length,
      files,
      consumerImport: /consumer import ok/.test(String(consumerResult.stdout ?? "")),
      serverEntrypoint: true,
      installer: true,
      installerV2: true,
      installerBinLinked: true,
      commandDiscovery: true,
      nativeV2Command: true,
      uninstaller: true,
      gate: true,
    }

    console.log(`package ${report.npmPackage}@${report.version}`)
    console.log(`minimum OpenCode ${report.minimumOpenCode}`)
    console.log(`runtime dependency ${report.runtimeDependency}`)
    console.log(`V2 runtime dependency ${report.v2RuntimeDependency}`)
    console.log(`tarball ${report.filename} files=${report.fileCount} packed=${report.packageSize} unpacked=${report.unpackedSize}`)
    console.log("clean production-only consumer public API + server + TUI import + V1/V2 npm-linked installer + /goal command modes + uninstaller PASS")

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
