// The public API and dual server facade share this function identity.
// Importing native V2 must not resolve the V1 SDK or initialize its runtime.
type LegacyPlugin = typeof import("./legacy-v1.js").default

export default async function OpenCodeGoalPlugin(
  ...args: Parameters<LegacyPlugin>
): Promise<Awaited<ReturnType<LegacyPlugin>>> {
  const { default: legacy } = await import("./legacy-v1.js")
  return legacy(...args)
}
