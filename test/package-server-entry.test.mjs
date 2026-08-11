import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("package exposes a dedicated OpenCode server entrypoint instead of legacy-loading the public API barrel", async () => {
  const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const serverExport = packageJSON.exports?.["./server"]

  assert.equal(serverExport?.import, "./dist/server.js")
  assert.equal(serverExport?.types, "./dist/server.d.ts")
  assert.equal(packageJSON.engines?.opencode, ">=1.4.0")
  assert.equal(packageJSON.dependencies?.["@opencode-ai/plugin"], "1.18.16")
  assert.equal(packageJSON.peerDependencies?.["@opencode-ai/plugin"], undefined)

  const publicModule = await import(pathToFileURL(path.join(root, "dist", "index.js")).href)
  assert.equal(typeof publicModule.default, "function")
  assert.equal(typeof publicModule.createGoal, "function")
  assert.ok(
    Object.keys(publicModule).length > 1,
    "the public API intentionally contains named exports and must not be fed to OpenCode's legacy plugin-export scanner",
  )

  const serverModule = await import(pathToFileURL(path.join(root, "dist", "server.js")).href)
  assert.deepEqual(Object.keys(serverModule), ["default"])
  assert.equal(serverModule.default?.id, "@bybrawe/opencode-goal")
  assert.equal(typeof serverModule.default?.server, "function")
  assert.equal(serverModule.default.server, publicModule.default)
})
