import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

function usage() {
  return "Usage: node scripts/benchmark/install-local-goal-plugin.mjs <workspace> <built-plugin-entry>"
}

export async function installLocalGoalPlugin(workspaceInput, entryInput) {
  if (!workspaceInput || !entryInput) throw new Error(usage())
  const workspace = path.resolve(workspaceInput)
  const entry = path.resolve(entryInput)
  await access(entry)
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  await mkdir(pluginDir, { recursive: true })
  const target = path.join(pluginDir, "opencode-goal-local.js")
  const href = pathToFileURL(entry).href
  await writeFile(target, `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(href)}\n`)
  return target
}

async function main(argv = process.argv.slice(2)) {
  const [workspace, entry] = argv
  const target = await installLocalGoalPlugin(workspace, entry)
  console.log(target)
}

if (process.argv[1]?.endsWith("install-local-goal-plugin.mjs")) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
