import type CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore, GoalStoreIntegrityError } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function normalizedContinuationIntent(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
}

function isNaturalResumeMessage(text: string): boolean {
  const normalized = normalizedContinuationIntent(text)
  return new Set([
    "devam",
    "devam et",
    "devam edelim",
    "kaldığın yerden devam et",
    "kaldigin yerden devam et",
    "continue",
    "continue working",
    "resume",
    "resume work",
  ]).has(normalized)
}

function isAutoStallPause(goal: GoalState): boolean {
  return goal.status === "paused"
    && /^Paused after \d+ continuation turns without host-observed progress\.$/.test(goal.stopReason ?? "")
}

function isActionablePausedSteering(text: string): boolean {
  const normalized = normalizedContinuationIntent(text)
  if (!normalized || normalized.startsWith("/")) return false
  if (/[?？]$/.test(text.trim())) return false
  if (/^(ne|neden|niye|nasıl|nasil|what|why|how|when|where|who)\b/.test(normalized)) return false
  if (/\b(status|durum|özet|ozet|summary)\b/.test(normalized)) return false
  return /\b(devam|yap|düzelt|duzelt|ekle|çıkar|cikar|sil|bitir|tamamla|uygula|incele|araştır|arastir|test|denetle|kontrol et|fix|implement|add|remove|delete|finish|complete|apply|review|research|test|check|update|change|refactor|build|create|use|work on)\b/.test(normalized)
}

function conflictMessage(goal: GoalState): string {
  const resume = goal.status === "paused" ? "\n- /goal resume — resume the current paused Goal." : ""
  return [
    "New Goal not created: this session already has an unfinished Goal.",
    `Current Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    "",
    "Choose explicitly before starting another Goal:",
    `- /goal status — inspect the current Goal.${resume}`,
    "- /goal edit <objective> — intentionally revise the current Goal contract.",
    "- /goal add <objective> — queue another Goal without replacing the current one.",
    "- /goal clear — archive/clear the current Goal; then run /goal <objective> again.",
    "",
    "No Goal state was changed by this command.",
  ].join("\n")
}

function pausedMessage(goal: GoalState): string {
  return [
    "Goal paused. Autonomous Goal continuation is now off.",
    `Current Goal: ${goal.objective}`,
    "",
    "To continue this persisted Goal, either run:",
    "/goal resume",
    "",
    "or send a short explicit continuation message such as \"devam et\" or \"continue\".",
    "Other normal chat remains foreground conversation and does not silently reactivate the Goal.",
    "Use /goal clear only when you intentionally want to stop tracking this Goal and start another one.",
  ].join("\n")
}

function pausedNoticeKey(goal: GoalState): string {
  return `${goal.id}:${goal.revision}:${goal.stopReason ?? ""}`
}

function isSyntheticHostMessage(parts: any[]): boolean {
  return parts.some((part) => part?.synthetic === true)
}

export function installGoalLifecycleUX(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const translations = new Map<string, PromptTranslation>()
  const commandOutputs = new Map<string, string>()
  const pausedChatNotices = new Map<string, string>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    let parsed: ReturnType<typeof parseGoalCommand>
    try {
      parsed = parseGoalCommand(event.arguments ?? "")
    } catch {
      await commandHook(event, output)
      return
    }

    if (parsed.action === "create" && parsed.objective) {
      const goal = await store.load(event.sessionID)
      if (goal && goal.status !== "completed") {
        await commandHook({ ...event, arguments: "status" }, output)
        const owned = textFromParts(output.parts)
        const shown = conflictMessage(goal)
        ;(output as any).noReply = true
        replaceParts(output.parts, shown)
        translations.set(event.sessionID, { shown, owned })
        await showGoalToast(input.client, "An unfinished Goal already exists. Use /goal status, /goal resume, /goal add, or /goal clear.", "warning")
        return
      }
    }

    if (parsed.action === "pause") {
      pausedChatNotices.delete(event.sessionID)
      await commandHook(event, output)
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "paused") return
      const owned = textFromParts(output.parts)
      const shown = pausedMessage(goal)
      ;(output as any).noReply = true
      replaceParts(output.parts, shown)
      translations.set(event.sessionID, { shown, owned })
      await showGoalToast(input.client, "Goal paused. Use /goal resume or a short continuation message such as 'devam et' to restart autonomous continuation.", "info")
      return
    }

    await commandHook(event, output)
    if (["create", "edit", "resume", "clear"].includes(parsed.action)) pausedChatNotices.delete(event.sessionID)

    const commandOutput = textFromParts(output?.parts ?? [])
    if (commandOutput) commandOutputs.set(event.sessionID, commandOutput)
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const shown = textFromParts(output?.parts ?? [])
    const translation = translations.get(event.sessionID)
    if (translation && shown === translation.shown) {
      translations.delete(event.sessionID)
      await chatHook(event, {
        ...output,
        parts: [{ type: "text", text: translation.owned }],
      })
      return
    }

    const commandOutput = commandOutputs.get(event.sessionID)
    if (commandOutput) {
      commandOutputs.delete(event.sessionID)
      if (shown === commandOutput) {
        await chatHook(event, output)
        return
      }
    }

    const synthetic = (output as any)?.noReply === true || isSyntheticHostMessage(output?.parts ?? [])
    if (!synthetic) {
      let paused: GoalState | null
      try {
        paused = await store.load(event.sessionID)
      } catch (error) {
        if (error instanceof GoalStoreIntegrityError) paused = null
        else throw error
      }

      if (paused?.status === "paused" && isNaturalResumeMessage(shown)) {
        const resumeOutput: any = { parts: [{ type: "text", text: "resume" }] }
        await commandHook({ ...event, command: "goal", arguments: "resume" }, resumeOutput)
        const resumeText = textFromParts(resumeOutput.parts)
        if (resumeText) replaceParts(output.parts, resumeText)
        const resumed = await store.load(event.sessionID)
        pausedChatNotices.delete(event.sessionID)
        await chatHook(event, output)
        if (resumed?.status === "active") {
          await showGoalToast(input.client, "Paused Goal resumed from your continuation message.", "success")
        }
        return
      }

      if (paused && isAutoStallPause(paused) && isActionablePausedSteering(shown)) {
        // An automatic no-progress pause is a safety backstop, not a user intent
        // boundary. Resume through the normal command chain, consume that
        // internal command ownership, then preserve the original human message
        // so core Goal steering owns and executes the actual instruction.
        const resumeOutput: any = { parts: [{ type: "text", text: "resume" }] }
        await commandHook({ ...event, command: "goal", arguments: "resume" }, resumeOutput)
        await chatHook(event, resumeOutput)
        const resumed = await store.load(event.sessionID)
        pausedChatNotices.delete(event.sessionID)
        await chatHook(event, output)
        if (resumed?.status === "active") {
          await showGoalToast(input.client, "Auto-paused Goal resumed from your new work instruction.", "success")
        }
        return
      }
    }

    await chatHook(event, output)

    if (synthetic) return

    let goal: GoalState | null
    try {
      goal = await store.load(event.sessionID)
    } catch (error) {
      if (error instanceof GoalStoreIntegrityError) return
      throw error
    }
    if (!goal || goal.status !== "paused") {
      pausedChatNotices.delete(event.sessionID)
      return
    }

    const key = pausedNoticeKey(goal)
    if (pausedChatNotices.get(event.sessionID) === key) return
    pausedChatNotices.set(event.sessionID, key)
    await showGoalToast(
      input.client,
      isAutoStallPause(goal)
        ? "Goal auto-paused after repeated no-progress turns. Send a concrete work instruction to resume and steer it, or use /goal resume."
        : "Goal remains paused. Use /goal resume or send a short continuation message such as 'devam et' to continue the persisted Goal.",
      "warning",
    )
  }
}
