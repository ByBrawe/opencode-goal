import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"

const MAX_FILES = 1800
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 48 * 1024 * 1024
const MAX_MATCHES = 120
const CONTEXT = 260
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".map", ".md"])
const PATTERNS = [
  /\.name\.replace/g,
  /name\.replace/g,
  /codemode/g,
  /tool\.transform/g,
  /tools?\.add/g,
  /ToolDraft/g,
  /ToolDefinition/g,
  /session\.hook/g,
]

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 24 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${String(result.stderr ?? "").slice(-3000)}`)
  }
  return String(result.stdout ?? "").trim()
}

function clean(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()
}

function snippets(text, source, output) {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (output.length >= MAX_MATCHES) return
      const index = match.index ?? 0
      const start = Math.max(0, index - CONTEXT)
      const end = Math.min(text.length, index + match[0].length + CONTEXT)
      output.push({ source, pattern: pattern.source, snippet: clean(text.slice(start, end)).slice(0, 900) })
    }
  }
}

async function walk(root) {
  const files = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length && files.length < MAX_FILES) {
    const current = queue.shift()
    let entries
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < 7) queue.push({ dir: absolute, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      files.push(absolute)
      if (files.length >= MAX_FILES) break
    }
  }
  return files
}

async function main() {
  const globalRoot = command("npm", ["root", "-g"])
  const packageRoot = path.join(globalRoot, "@opencode-ai", "cli")
  const manifestPath = path.join(packageRoot, "package.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  const which = command(process.platform === "win32" ? "where" : "which", ["opencode2"]).split(/\r?\n/)[0]
  let realBinary = which
  try { realBinary = await fs.realpath(which) } catch {}

  console.log("=== OpenCode 2 exact beta artifact diagnostic ===")
  console.log(JSON.stringify({
    globalRoot,
    packageRoot,
    name: manifest.name,
    version: manifest.version,
    bin: manifest.bin ?? null,
    exports: manifest.exports ?? null,
    dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
    optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}).sort(),
    opencode2: which,
    opencode2RealPath: realBinary,
  }, null, 2))

  const roots = [...new Set([packageRoot, path.dirname(realBinary)])]
  const allFiles = []
  for (const root of roots) {
    for (const file of await walk(root)) if (!allFiles.includes(file)) allFiles.push(file)
  }
  console.log(`diagnostic roots=${JSON.stringify(roots)} files=${allFiles.length}`)
  console.log("candidate paths:")
  for (const file of allFiles.filter((file) => /(?:plugin|tool|session|command|v2|schema)/i.test(file)).slice(0, 180)) {
    console.log(`- ${file}`)
  }

  const matches = []
  let totalBytes = 0
  for (const file of allFiles) {
    if (matches.length >= MAX_MATCHES || totalBytes >= MAX_TOTAL_BYTES) break
    const ext = path.extname(file).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) continue
    let stat
    try { stat = await fs.stat(file) } catch { continue }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
    totalBytes += stat.size
    let text
    try { text = await fs.readFile(file, "utf8") } catch { continue }
    snippets(text, file, matches)
  }

  console.log(`text scan bytes=${totalBytes} matches=${matches.length}`)
  for (const item of matches) console.log(JSON.stringify(item))

  if (process.platform !== "win32") {
    const shell = [
      'set -o pipefail',
      'if command -v strings >/dev/null 2>&1; then',
      '  strings -a -n 6 "$TARGET" | grep -aEo ".{0,220}(name\\.replace|codemode|tools?\\.add|tool\\.transform|ToolDraft|ToolDefinition|session\\.hook).{0,320}" | head -n 100 || true',
      'fi',
    ].join("\n")
    const binaryMatches = spawnSync("bash", ["-lc", shell], {
      encoding: "utf8",
      env: { ...process.env, TARGET: realBinary },
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    console.log("binary string matches:")
    console.log(String(binaryMatches.stdout ?? "").slice(0, 80_000))
  }

  console.log("=== End exact beta artifact diagnostic ===")
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
