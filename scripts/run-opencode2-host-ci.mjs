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

const failures = []
for (const script of [
  "scripts/opencode2-host-canary.mjs",
  "scripts/opencode2-command-control-canary.mjs",
]) {
  try {
    run("node", [script])
  } catch (error) {
    failures.push({ script, error })
    console.error(`OpenCode 2 host canary failed: ${script}`)
    console.error(error?.stack || error)
  }
}

if (failures.length) {
  throw new Error(`OpenCode 2 host gate failed ${failures.length}/${2} canaries: ${failures.map((item) => item.script).join(", ")}`)
}
