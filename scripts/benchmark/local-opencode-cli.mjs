import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export function resolveLocalOpenCodeBinary(repoRoot = root, platform = process.platform) {
  if (platform !== "win32") {
    const candidate = path.join(repoRoot, "node_modules", ".bin", "opencode")
    if (existsSync(candidate)) return candidate
    throw new Error(`repo-local OpenCode binary is missing: ${candidate}`)
  }

  const candidates = [
    path.join(repoRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error(`repo-local OpenCode Windows binary is missing. Checked: ${candidates.join(", ")}`)
}

export async function runLocalOpenCode(args = process.argv.slice(2)) {
  const executable = resolveLocalOpenCodeBinary()
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (signal) return reject(new Error(`OpenCode terminated by ${signal}`))
      resolve(code ?? 1)
    })
  })
}

if (process.argv[1]?.endsWith("local-opencode-cli.mjs")) {
  runLocalOpenCode().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
