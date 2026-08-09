import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCLI = process.env.npm_execpath
const minimumPeer = "@opencode-ai/plugin@1.4.0"

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
  const required = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]
  for (const file of required) {
    if (!files.has(file)) throw new Error(`publish tarball is missing required file: ${file}`)
  }

  const forbiddenPrefixes = ["src/", "test/", "scripts/", ".github/", "eval/", "node_modules/", ".opencode/"]
  const leaked = [...files].filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)))
  if (leaked.length) throw new Error(`publish tarball leaked development files: ${leaked.join(", ")}`)
  return [...files].sort()
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  if (packageJSON.private === true) throw new Error("package.json is private and cannot be published")
  if (packageJSON.publishConfig?.access !== "public") throw new Error("scoped beta package must set publishConfig.access=public")
  if (packageJSON.peerDependencies?.["@opencode-ai/plugin"] !== ">=1.4.0") {
    throw new Error("package smoke minimum peer fixture must match peerDependencies['@opencode-ai/plugin'] >=1.4.0")
  }
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
      const entryDir = path.dirname(fileURLToPath(import.meta.resolve("@bybrawe/opencode-goal")));
      if (!fs.existsSync(path.join(entryDir, "index.d.ts"))) throw new Error("published type declarations are missing");
      console.log("consumer import ok");
    `
    const consumerResult = run(process.execPath, ["--input-type=module", "--eval", probe], { cwd: consumer })

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
      gate: true,
    }

    console.log(`package ${report.npmPackage}@${report.version}`)
    console.log(`minimum runtime peer ${minimumPeer}`)
    console.log(`tarball ${report.filename} files=${report.fileCount} packed=${report.packageSize} unpacked=${report.unpackedSize}`)
    console.log("clean consumer install/import PASS")

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
