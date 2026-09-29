import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = (file) => import(pathToFileURL(path.join(root, "dist", file)).href)

test("package root is the OpenCode 2 plugin while API and V1 compatibility stay explicit", async () => {
  const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(packageJSON.exports?.["."]?.import, "./dist/index.js")
  assert.equal(packageJSON.exports?.["./server"]?.import, "./dist/server.js")
  assert.equal(packageJSON.exports?.["./v2"]?.import, "./dist/native.js")
  assert.equal(packageJSON.exports?.["./api"]?.import, "./dist/api.js")
  assert.equal(packageJSON.exports?.["./v1"]?.import, "./dist/legacy-loader.js")
  assert.equal(packageJSON.dependencies?.["@opencode/plugin"], "^2.0.18")
  assert.equal(packageJSON.dependencies?.["@opencode-ai/plugin"], ">=1.4.0 <2")

  const rootModule = await dist("index.js")
  const serverModule = await dist("server.js")
  const nativeModule = await dist("native.js")
  const apiModule = await dist("api.js")
  const v1Module = await dist("legacy-loader.js")

  assert.equal(rootModule.default, serverModule.default)
  assert.equal(rootModule.default?.id, "@bybrawe/opencode-goal")
  assert.equal(typeof rootModule.default?.setup, "function")
  assert.equal(typeof rootModule.default?.server, "function")
  assert.equal(nativeModule.default?.id, "@bybrawe/opencode-goal")
  assert.equal(typeof nativeModule.default?.setup, "function")
  assert.equal("server" in nativeModule.default, false)

  assert.equal(typeof v1Module.default, "function")
  assert.equal(rootModule.default.server, v1Module.default)
  assert.equal(rootModule.OpenCodeGoalV1Plugin, v1Module.default)

  assert.equal(typeof apiModule.createGoal, "function")
  assert.equal(typeof apiModule.parseGoalCommand, "function")
  assert.ok(Object.keys(apiModule).length > 1)
  assert.equal("createGoal" in rootModule, false, "plugin root must not be the programmatic API barrel")
})
