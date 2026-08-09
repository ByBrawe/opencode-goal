import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function requireWorkspace(argv = process.argv) {
  const workspace = argv[2]
  if (!workspace) throw new Error("oracle expects workspace path as argv[2]")
  return path.resolve(workspace)
}

export async function assertExactFile(workspace, relativePath, expected) {
  const actual = await readFile(path.join(workspace, relativePath), "utf8")
  if (actual !== expected) throw new Error(`${relativePath} was modified; benchmark contract requires the exact original file`)
}

export function runNodeTests(workspace, testFile) {
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ["--test", testFile], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    env,
  })
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-4000)
    throw new Error(`visible tests failed${detail ? `: ${detail}` : ""}`)
  }
}

export async function importWorkspaceModule(workspace, relativePath) {
  const url = pathToFileURL(path.join(workspace, relativePath))
  url.searchParams.set("oracle", `${Date.now()}-${Math.random()}`)
  return import(url.href)
}

export function pass(message) {
  console.log(`ORACLE PASS: ${message}`)
}

export function fail(error) {
  console.error(`ORACLE FAIL: ${error?.message ?? error}`)
  process.exitCode = 1
}
