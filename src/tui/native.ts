import { createElement, insert, setProp } from '@opentui/solid'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { GoalStatusRpc } from '../status-rpc.js'
import { createGoalStatusController, type GoalStatusRead } from './status-controller.js'

// Structural public V2 surface; no dependency on private CLI services.
export type GoalTuiContext = {
  client: { rpc(definition: typeof GoalStatusRpc): { read: GoalStatusRead } }
  data: {
    session: { get(sessionID: string): { location?: unknown } | undefined }
    listen(callback: (event: { details: { type?: string; data?: { sessionID?: string; session?: { id?: string }; id?: string } } }) => void): () => void
  }
  theme: { text: { base: unknown } }
  ui: { slot(definition: { append: 'sidebar.content'; render(props: { sessionID: string }): unknown }): () => void }
}

export function setupNativeGoalTui(context: GoalTuiContext): () => void {
  if (typeof context.ui?.slot !== 'function' || typeof context.client?.rpc !== 'function' || typeof context.data?.session?.get !== 'function' || typeof context.data?.listen !== 'function') throw new Error('Goal sidebar requires the OpenCode 2 native CLI slot, data and RPC APIs.')
  const status = context.client.rpc(GoalStatusRpc)
  const cleanups = new Set<() => void>()
  let closed = false
  const unregister = context.ui.slot({
    append: 'sidebar.content',
    render: (props) => {
      if (closed) return null
      // These are the same public render primitives used by compiled
      // OpenTUI JSX, so published JS needs no runtime JSX compiler.
      const element = createElement('text')
      setProp(element, 'fg', context.theme.text.base)
      const [text, setText] = createSignal('OpenCode Goals\nLoading server status...')
      insert(element, text)
      const controller = createGoalStatusController({
        read: (input, options) => status.read(input, options),
        publish: setText,
      })
      const stop = context.data.listen(({ details }) => {
        if (details.type === 'server.connected') { controller.invalidate(); return }
        const sessionID = details.data?.sessionID ?? details.data?.session?.id ?? (details.type === 'session.deleted' ? details.data?.id : undefined)
        if (sessionID) controller.invalidate(sessionID)
      })
      let released = false
      const release = () => {
        if (released) return
        released = true
        controller.dispose()
        stop()
        cleanups.delete(release)
      }
      cleanups.add(release)
      onCleanup(release)
      createEffect(() => {
        const sessionID = props.sessionID
        const session = context.data.session.get(sessionID)
        // Never substitute the CLI process's local directory for a
        // remote, missing or differently located session.
        void controller.select(sessionID, session?.location)
      })
      return element
    },
  })
  return () => {
    if (closed) return
    closed = true
    const errors: unknown[] = []
    for (const release of [...cleanups]) { try { release() } catch (error) { errors.push(error) } }
    try { unregister() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Goal sidebar cleanup failed')
  }
}
