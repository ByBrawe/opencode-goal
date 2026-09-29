import { Plugin } from "@opencode/plugin"
import OpenCodeGoalPlugin from "./legacy-loader.js"
import { setupNativeGoals } from "./opencode2/native-setup.js"

const native = Plugin.define({
  id: "@bybrawe/opencode-goal",
  setup: setupNativeGoals,
})

const plugin = {
  ...native,

  // OpenCode 1.x compatibility remains an explicitly separate implementation.
  // V2 reads id/setup and ignores server(); V1 1.18.29+ calls server().
  server: OpenCodeGoalPlugin,
}

export default plugin
