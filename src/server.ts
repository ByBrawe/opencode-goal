import type { PluginModule } from "@opencode-ai/plugin"
import OpenCodeGoalPlugin from "./index.js"

const plugin = {
  id: "@bybrawe/opencode-goal",
  server: OpenCodeGoalPlugin,
} satisfies PluginModule & { id: string }

export default plugin
