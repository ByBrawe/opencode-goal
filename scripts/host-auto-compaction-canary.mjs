import { runCompactionCanary } from "./host-compaction-canary-core.mjs"

runCompactionCanary({ mode: "auto" }).catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
