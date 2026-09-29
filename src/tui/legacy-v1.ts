import { formatGoalSidebar } from "./format.js"

type GoalTuiApi = {
  slots: {
    register(plugin: {
      order?: number
      slots: {
        sidebar_content: (context: unknown, props: { session_id: string }) => unknown
      }
    }): unknown
  }
  state: {
    path: { directory: string; worktree: string }
    session: {
      status(sessionID: string): unknown
      messages(sessionID: string): ReadonlyArray<unknown>
    }
  }
}

type GoalTuiModule = {
  id: string
  tui(api: GoalTuiApi, options?: Record<string, unknown>, meta?: unknown): Promise<void>
}

const tui: GoalTuiModule["tui"] = async (api) => {
  api.slots.register({
    order: 340,
    slots: {
      sidebar_content: (_context, props) => {
        // Host session state is intentionally touched so normal status/message
        // transitions re-evaluate this read-only filesystem projection.
        api.state.session.status(props.session_id)
        api.state.session.messages(props.session_id).length
        const root = api.state.path.directory || api.state.path.worktree
        return formatGoalSidebar(root, props.session_id)
      },
    },
  })
}

const plugin: GoalTuiModule = {
  id: "opencode-goal",
  tui,
}

export default plugin
