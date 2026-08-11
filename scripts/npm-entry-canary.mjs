import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"

function resolveOpenCodeBinary() {
  if (!isWindows) return path.join(repoRoot, "node_modules", ".bin", "opencode")
  const candidates = [
    path.join(repoRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`OpenCode native Windows binary was not installed. Checked: ${candidates.join(", ")}`)
  return found
}

function parseConfig(stdout) {
  const text = String(stdout ?? "").trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`OpenCode debug config returned no JSON:\n${text}`)
  return JSON.parse(text.slice(start, end + 1))
}

async function main() {
  const opencodeBin = resolveOpenCodeBinary()
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-npm-entry-canary-"))
  const home = path.join(workspace, ".home")
  const globalConfig = path.join(home, ".config", "opencode")

  try {
    await mkdir(globalConfig, { recursive: true })
    await writeFile(path.join(workspace, "README.md"), "# npm entry canary\n")

    // A package-directory path exercises the same package.json ./server entry
    // resolution that OpenCode uses after installing an npm plugin. This would
    // fail for 1.3.3, whose root module exposed public helper exports but had no
    // dedicated ./server entrypoint.
    const packagePlugin = pathToFileURL(repoRoot).href
    await writeFile(path.join(globalConfig, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [packagePlugin],
    }, null, 2)}\n`)

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DB: ":memory:",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      CI: "true",
    }

    const result = spawnSync(opencodeBin, ["debug", "config"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error([
        `OpenCode debug config exited ${result.status}`,
        String(result.stdout ?? ""),
        String(result.stderr ?? ""),
      ].filter(Boolean).join("\n"))
    }

    const config = parseConfig(result.stdout)
    assert.equal(
      config.command?.goal?.template,
      "$ARGUMENTS",
      `OpenCode loaded the package but the Goal config hook did not register /goal: ${JSON.stringify(config.command ?? null)}`,
    )
    assert.match(
      String(config.command?.goal?.description ?? ""),
      /persistent/i,
      "Goal command description was not registered by the plugin config hook",
    )

    console.log(`real OpenCode package-entry canary PASS (${packagePlugin})`)
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
