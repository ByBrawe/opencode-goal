import { spawnSync } from "node:child_process"

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
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
run("node", ["scripts/opencode2-tool-visibility-diagnostic.mjs"])
