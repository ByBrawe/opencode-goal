import type CorePlugin from "./plugin.js"
import { GoalStore, GoalStoreIntegrityError } from "../persistence/store.js"
import { currentGoalLocale, isNaturalResumeText, translateCoreText } from "../i18n.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function isSyntheticHostMessage(parts: any[]): boolean {
  return parts.some((part) => part?.synthetic === true)
}

/**
 * Localize only the user-visible Goal command surface. Before the later
 * chat.message hook reaches the existing ownership/lifecycle wrappers, restore
 * the exact English command-owned text they originally produced. This keeps
 * localization from becoming lifecycle state or model-visible authorization.
 *
 * Short resume intent is recognized across all supported languages. When the
 * Goal is actually paused, normalize only that one foreground message to the
 * already-supported English "continue" intent and let the normal lifecycle
 * chain perform the resume. Persistence is never mutated here.
 */
export function installGoalI18nUX(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const store = new GoalStore(input.directory)
  const translations = new Map<string, PromptTranslation>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    await commandHook(event, output)
    if (event.command !== "goal") return

    const owned = textFromParts(output?.parts ?? [])
    if (!owned) return
    const shown = translateCoreText(owned, currentGoalLocale())
    if (shown === owned) return

    replaceParts(output.parts, shown)
    translations.set(event.sessionID, { shown, owned })
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const shown = textFromParts(output?.parts ?? [])
    const translation = translations.get(event.sessionID)
    if (translation) {
      translations.delete(event.sessionID)
      if (shown === translation.shown) {
        replaceParts(output.parts, translation.owned)
        await chatHook(event, output)
        return
      }
    }

    const synthetic = (output as any)?.noReply === true || isSyntheticHostMessage(output?.parts ?? [])
    if (!synthetic && isNaturalResumeText(shown)) {
      try {
        const goal = await store.load(event.sessionID)
        if (goal?.status === "paused") {
          // The existing lifecycle wrapper already treats "continue" as a
          // narrow explicit resume intent and routes it through /goal resume.
          // Normalize multilingual intent into that path rather than creating a
          // second persistence mutation path here.
          replaceParts(output.parts, "continue")
          await chatHook(event, output)
          return
        }
      } catch (error) {
        if (!(error instanceof GoalStoreIntegrityError)) throw error
      }
    }

    await chatHook(event, output)
  }
}
