import type { Plugin } from "@opencode/plugin"

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

type OfficialContext = Plugin.Context
type SessionInterruptInput = Parameters<OfficialContext["session"]["interrupt"]>[0]
type SessionPromptInput = Parameters<OfficialContext["session"]["prompt"]>[0]
type SessionContextInput = Parameters<OfficialContext["session"]["context"]>[0]
type SessionSwitchModelInput = Parameters<OfficialContext["session"]["switchModel"]>[0]
type AgentGetInput = Parameters<OfficialContext["agent"]["get"]>[0]

/**
 * Compile-time tripwires for the pinned OpenCode 2 SDK surface used by the
 * native adapter. This module is intentionally not imported at runtime; tsc
 * includes it through the TypeScript source include configured in tsconfig.json.
 */
export type OpenCode2InterruptAcceptsSessionIdentity = Expect<
  { sessionID: string } extends SessionInterruptInput ? true : false
>

export type OpenCode2InterruptHasNoLegacyContinueFlag = Expect<
  Equal<"continue" extends keyof SessionInterruptInput ? true : false, false>
>

type GoalPromptAdmission = {
  sessionID: string
  text: string
  resume?: boolean
  delivery?: "steer" | "queue"
}

export type OpenCode2PromptAcceptsGoalAdmission = Expect<
  GoalPromptAdmission extends SessionPromptInput ? true : false
>

export type OpenCode2SessionContextIsSessionScoped = Expect<
  SessionContextInput extends { sessionID: string } ? true : false
>

export type OpenCode2SwitchModelAcceptsVerifierSelection = Expect<
  { sessionID: string; model: { providerID: string; id: string } } extends SessionSwitchModelInput ? true : false
>

export type OpenCode2AgentLookupAcceptsTitleAgent = Expect<
  { agentID: string } extends AgentGetInput ? true : false
>
