import { spawn } from "node:child_process"
import process from "node:process"

function usage() {
  return "Usage: node scripts/benchmark/assert-command-version.mjs <executable> <expected-semver> [version-args...]"
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

export function extractSemver(text) {
  return text.match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s)/)?.[1] ?? null
}

export async function assertCommandVersion(executable, expected, args = ["--version"]) {
  if (!executable || !expected) throw new Error(usage())
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) throw new Error(`expected version must be an exact semver: ${expected}`)
  const result = await run(executable, args)
  if (result.signal) throw new Error(`${executable} version probe terminated by ${result.signal}`)
  if (result.code !== 0) {
    throw new Error(`${executable} version probe exited ${result.code}: ${(result.stderr || result.stdout).trim()}`)
  }
  const actual = extractSemver(`${result.stdout}\n${result.stderr}`)
  if (!actual) throw new Error(`${executable} version probe did not contain a semantic version`)
  if (actual !== expected) throw new Error(`${executable} version mismatch: expected ${expected}, got ${actual}`)
  return actual
}

async function main(argv = process.argv.slice(2)) {
  const [executable, expected, ...args] = argv
  if (!executable || !expected) throw new Error(usage())
  const actual = await assertCommandVersion(executable, expected, args.length ? args : ["--version"])
  console.log(`${executable} ${actual}`)
}

if (process.argv[1]?.endsWith("assert-command-version.mjs")) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
