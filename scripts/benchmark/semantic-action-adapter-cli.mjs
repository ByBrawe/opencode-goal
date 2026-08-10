import { main } from "./semantic-action-adapter.mjs"

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
