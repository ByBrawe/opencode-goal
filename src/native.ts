import OpenCode2GoalsPlugin from "./opencode2/experimental.js"

// Explicit native-only entry. Persisted Goal state remains owned by the same
// V2 implementation; this entry adds no alternate lifecycle or recovery path.
export default {
  id: "@bybrawe/opencode-goal",
  setup: OpenCode2GoalsPlugin.setup,
}
