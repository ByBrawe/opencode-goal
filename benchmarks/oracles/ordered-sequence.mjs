import { readFile } from "node:fs/promises"
import path from "node:path"

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

const workspace = process.argv[2]
if (!workspace) {
  fail("ordered-sequence oracle requires a workspace path")
} else {
  const target = path.join(path.resolve(workspace), "order.log")
  const expected = "first\nsecond\n"
  try {
    const actual = await readFile(target, "utf8")
    if (actual === expected) {
      console.log("PASS: order.log contains first then second exactly once and in order")
    } else {
      fail(`order.log mismatch: expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`)
    }
  } catch (error) {
    if (error?.code === "ENOENT") fail("order.log is missing; ordered sequence did not complete both Goals")
    else fail(`could not read order.log: ${error?.message ?? error}`)
  }
}
