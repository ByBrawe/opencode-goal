import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("V2 package entries isolate V1 imports and preserve lazy per-host legacy delegation", () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const result = spawnSync(process.execPath, ["scripts/native-entry-test.mjs"], { cwd: root, encoding: "utf8", timeout: 90_000, windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
