import assert from "node:assert/strict"
import test from "node:test"
import { runUnitIdentityCommand } from "../dist/opencode2/unit-command.js"
import { processTreeFixture, bounded } from "./native-process-tree-fixture.mjs"

for (const mode of ["timeout", "overflow"]) {
  test(`V2 unit ${mode} stops pipe-detached descendants before rejecting`, { timeout: 15000 }, async () => {
    const fixture = await processTreeFixture(mode)
    try {
      await bounded(assert.rejects(runUnitIdentityCommand(fixture.command, fixture.directory,
        mode === "timeout" ? 2000 : 10000), mode === "timeout" ? /timed out/ : /stdout exceeds/))
      await fixture.assertStopped()
    } finally { await fixture.cleanup() }
  })
}
