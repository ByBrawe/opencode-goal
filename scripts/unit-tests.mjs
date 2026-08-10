import { spawnSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testRoot = path.join(root, "test")
const files = (await readdir(testRoot))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testRoot, name))

if (!files.length) throw new Error("no unit test files found under test/*.test.mjs")

const child = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
})
if (child.error) throw child.error
process.exitCode = child.status ?? 1
