import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  collectOpenCode2SuccessfulToolProgress,
  createOpenCode2ToolProgressRuntime,
  forgetOpenCode2ToolProgressSession,
  rememberOpenCode2ShellBefore,
} from "../dist/opencode2/tool-progress.js"

test("V2 write/edit success becomes progress only through current project file hashing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-tool-progress-"))
  try {
    await writeFile(path.join(root, "README.md"), "verified mutation\n", "utf8")
    const runtime = createOpenCode2ToolProgressRuntime()

    const progress = await collectOpenCode2SuccessfulToolProgress(runtime, {
      sessionID: "s1",
      callID: "c1",
      tool: "write",
      args: { filePath: "README.md", content: "verified mutation\n" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    assert.equal(progress.length, 1)
    assert.match(progress[0].fingerprint, /^file:README\.md:[a-f0-9]{64}$/)
    assert.match(progress[0].summary, /README\.md/)

    const ignored = await collectOpenCode2SuccessfulToolProgress(runtime, {
      sessionID: "s1",
      callID: "c2",
      tool: "write",
      args: { filePath: ".opencode/goals/s1.json", content: "{}" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    assert.deepEqual(ignored, [], "Goal control-plane writes must never manufacture project progress")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test("V2 shell success keeps the V1 read-only guard and bounded pending state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-shell-progress-"))
  try {
    const runtime = createOpenCode2ToolProgressRuntime()

    await rememberOpenCode2ShellBefore(runtime, {
      sessionID: "s1",
      callID: "read",
      tool: "shell",
      args: { command: "pwd" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    assert.deepEqual(await collectOpenCode2SuccessfulToolProgress(runtime, {
      sessionID: "s1",
      callID: "read",
      tool: "shell",
      args: { command: "pwd" },
      directory: root,
      goalID: "g1",
      revision: 1,
    }), [])

    await rememberOpenCode2ShellBefore(runtime, {
      sessionID: "s1",
      callID: "mutate",
      tool: "shell",
      args: { command: "printf proof > generated.txt" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    const fallback = await collectOpenCode2SuccessfulToolProgress(runtime, {
      sessionID: "s1",
      callID: "mutate",
      tool: "shell",
      args: { command: "printf proof > generated.txt" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    assert.equal(fallback.length, 1)
    assert.match(fallback[0].fingerprint, /^shell:[a-f0-9]{64}$/)

    await rememberOpenCode2ShellBefore(runtime, {
      sessionID: "s1",
      callID: "stale",
      tool: "bash",
      args: { command: "echo x" },
      directory: root,
      goalID: "g1",
      revision: 1,
    })
    forgetOpenCode2ToolProgressSession(runtime, "s1")
    assert.equal(runtime.shellPending.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})
