import core from './experimental.js'
import { registerGoalStatusRpc, type GoalStatusHost } from './status-rpc.js'

// Presentation adds no lifecycle/continuation path. Both shipped V2
// entries delegate to the same tested Goal implementation.
export async function setupNativeGoals(ctx: Parameters<typeof core.setup>[0]): Promise<() => Promise<void>> {
  const stopStatus = await registerGoalStatusRpc(ctx as unknown as GoalStatusHost)
  let stopCore: (() => Promise<void>) | undefined
  try { stopCore = await core.setup(ctx) }
  catch (error) { await stopStatus().catch(() => {}); throw error }
  let disposal: Promise<void> | undefined
  return () => {
    if (disposal) return disposal
    // Revoke the read handler immediately; release both even if one fails.
    const status = stopStatus()
    disposal = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([status, Promise.resolve().then(() => stopCore!())])
      const failures = results.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Native Goal cleanup failed')
    })
    return disposal
  }
}
