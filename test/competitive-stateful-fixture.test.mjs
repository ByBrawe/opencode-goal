import test from "node:test"
import assert from "node:assert/strict"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { validateManifest } from "../scripts/competitive-benchmark.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function oracle(name, workspace) {
  return spawnSync(process.execPath, [path.join(root, "benchmarks", "oracles", `${name}.mjs`), workspace], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  })
}

test("ordered sequence pilot fixture has the intended inert and exact-order oracle states", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-ordered-sequence-fixture-"))
  const workspace = path.join(temp, "workspace")
  try {
    await cp(path.join(root, "benchmarks", "fixtures", "ordered-sequence"), workspace, { recursive: true })

    assert.equal(oracle("ordered-sequence-inert", workspace).status, 0, "baseline queue state should be inert")
    assert.notEqual(oracle("ordered-sequence", workspace).status, 0, "baseline final oracle must start red")

    await writeFile(path.join(workspace, "order.log"), "first\n")
    assert.notEqual(oracle("ordered-sequence-inert", workspace).status, 0, "any early worktree mutation must fail the inert queue oracle")
    assert.notEqual(oracle("ordered-sequence", workspace).status, 0, "one completed Goal is not the ordered final state")

    await writeFile(path.join(workspace, "order.log"), "second\nfirst\n")
    assert.notEqual(oracle("ordered-sequence", workspace).status, 0, "wrong Goal order must fail")

    await writeFile(path.join(workspace, "order.log"), "first\nsecond\nextra\n")
    assert.notEqual(oracle("ordered-sequence", workspace).status, 0, "extra work must fail exact final-state proof")

    await writeFile(path.join(workspace, "order.log"), "first\nsecond\n")
    assert.equal(oracle("ordered-sequence", workspace).status, 0, "only the exact ordered two-Goal result should pass")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("ordered sequence pilot manifest is valid stateful benchmark wiring", async () => {
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "benchmarks", "ordered-sequence.pilot.json"), "utf8"))
  assert.equal(validateManifest(manifest), manifest)
  assert.equal(manifest.competitors.length, 1)
  assert.equal(manifest.scenarios[0].steps.length, 3)
  assert.equal(manifest.scenarios[0].steps[0].oracle.expect, "pass")
  assert.equal(manifest.scenarios[0].steps[1].oracle.expect, "pass")
  assert.equal(manifest.scenarios[0].preflightOracle, "fail")
})
