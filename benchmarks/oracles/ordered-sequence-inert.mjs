import { access } from "node:fs/promises"
import path from "node:path"

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

const workspace = process.argv[2]
if (!workspace) {
  fail("ordered-sequence inert oracle requires a workspace path")
} else {
  const target = path.join(path.resolve(workspace), "order.log")
  try {
    await access(target)
    fail("order.log exists before sequence activation; queued Goals were not inert")
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("PASS: order.log is still absent; queued Goals remain inert")
    } else {
      fail(`could not inspect order.log: ${error?.message ?? error}`)
    }
  }
}
