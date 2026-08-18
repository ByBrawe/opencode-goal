import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const behaviorScript = path.join(root, "scripts", "opencode2-goal-behavior-canary.mjs")

const result = spawnSync(process.execPath, [behaviorScript], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 180_000,
  maxBuffer: 4 * 1024 * 1024,
})

if (result.error) throw result.error
if (result.status !== 0) {
  process.stdout.write(result.stdout ?? "")
  process.stderr.write(result.stderr ?? "")
  throw new Error(`OpenCode 2 Goal behavior canary exited with ${result.status}`)
}

const stdout = String(result.stdout ?? "").trim()
let payload
try {
  payload = JSON.parse(stdout)
} catch {
  process.stdout.write(result.stdout ?? "")
  process.stderr.write(result.stderr ?? "")
  throw new Error("OpenCode 2 Goal behavior canary did not emit one parseable JSON result")
}

assert.equal(payload?.ok, true, "underlying OpenCode 2 Goal behavior canary did not report success")
const observations = Array.isArray(payload?.provider?.observations) ? payload.provider.observations : []
const ordinary = observations.filter((item) => item?.phase === "ordinary")
assert.ok(ordinary.length > 0, "real-host behavior canary recorded no ordinary follow-up provider request")
assert.equal(
  ordinary.some((item) => item?.hasControl === true),
  false,
  "ordinary follow-up exposed the mutating V2 Goal lifecycle control",
)
assert.equal(
  ordinary.every((item) => item?.hasGet === true),
  true,
  "ordinary follow-up lost the read-only V2 Goal get tool while lifecycle control was hidden",
)

console.log(JSON.stringify({
  ok: true,
  opencode2Version: payload.opencode2Version,
  ordinaryRequests: ordinary.length,
  ordinaryToolObservations: ordinary.map((item) => ({
    request: item.request,
    hasControl: item.hasControl,
    hasGet: item.hasGet,
    tools: item.tools,
  })),
}, null, 2))
