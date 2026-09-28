import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, access, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { readGoalUnitIdentity } from "../dist/opencode2/unit-handoff.js"

async function fixture(source, check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goal-unit-command-"))
  try {
    await writeFile(path.join(directory, "unit.cjs"), source)
    const read = (options) => readGoalUnitIdentity(`"${process.execPath}" unit.cjs`, directory, options)
    await check(read, directory)
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

test("unit command normalizes its full bounded stdout", async () => {
  await fixture('process.stdout.write("  unit-001\\r\\n ")', async (read) => {
    assert.equal(await read(), "unit-001")
  })
})

test("unit command rejects empty and overlong identities", async () => {
  await fixture('process.stdout.write(" ")', async (read) => { await assert.rejects(read(), /empty stdout/) })
  await fixture('process.stdout.write("x".repeat(4097))', async (read) => { await assert.rejects(read(), /4096 characters/) })
})

test("unit command cannot turn overflowing output into a short truncated identity", async () => {
  await fixture('process.stdout.write(" ".repeat(50000)+"unit-002")', async (read) => {
    await assert.rejects(read(), /stdout exceeds 16384 bytes/)
  })
})

test("failed unit command never provides rotation evidence", async () => {
  await fixture('process.stdout.write("unit-002"); process.stderr.write("bad unit"); process.exitCode=7', async (read) => {
    await assert.rejects(read(), /failed \(7\): bad unit/)
  })
})

test("unit command timeout terminates its descendants before returning", async () => {
  await fixture('process.on("SIGTERM",()=>{}); setTimeout(()=>require("node:fs").writeFileSync("leaked","yes"),2000); setInterval(()=>{},1000)', async (read, directory) => {
    await assert.rejects(read({ timeoutMs: 200 }), /timed out/)
    await new Promise((resolve) => setTimeout(resolve, 2300))
    await assert.rejects(access(path.join(directory, "leaked")), { code: "ENOENT" })
  })
})

test("invalid unit command timeout does not overflow into a one-millisecond timer", async () => {
  await fixture('process.stdout.write("unit")', async (read) => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) await assert.rejects(read({ timeoutMs }), /timer range/)
  })
})
