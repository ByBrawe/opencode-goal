import { spawnSync } from "node:child_process"

function run(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
    env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
  }
}

run("npm", ["install"])
run("npm", ["run", "build"])
run("npm", ["install", "-g", "@opencode-ai/cli@next"])
run("opencode2", ["--version"])

// Activation intentionally runs without a synthetic command declaration: a
// missing project /goal command must not crash plugin setup. Behavior testing is
// different: it needs a real project command so command.transform can wrap the
// host-provided command exactly as production would.
run("node", ["scripts/opencode2-host-canary.mjs"])
const behaviorConfig = JSON.stringify({
  command: {
    goal: {
      template: "$ARGUMENTS",
      description: "OpenCode Goals V2 behavior canary command",
    },
  },
})
run("node", ["scripts/opencode2-goal-behavior-canary.mjs"], {
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: behaviorConfig },
})
