import { setupNativeGoals } from "./opencode2/native-setup.js"

// Explicit native-only entry. Persisted Goal state remains owned by the same
// V2 implementation; this entry adds no alternate lifecycle or recovery path.
export default {
  id: "@bybrawe/opencode-goal",
  setup: setupNativeGoals,
}
