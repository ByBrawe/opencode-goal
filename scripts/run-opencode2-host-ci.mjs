import { spawnSync } from "node:child_process"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
    ...options,
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
run("node", ["scripts/opencode2-host-canary.mjs"])

const behaviorConfig = JSON.stringify({
  command: {
    goal: {
      description: "OpenCode Goals V2 behavior canary transport",
      template: "$ARGUMENTS",
      subtask: false,
    },
  },
})
run("node", ["scripts/opencode2-goal-behavior-canary.mjs"], {
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: behaviorConfig,
  },
})
