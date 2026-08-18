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

function withText(output: any, text: string): any {
  return {
    ...output,
    parts: [{ type: "text", text }],
  }
}

function isSyntheticHostMessage(parts: any[]): boolean {
  return parts.some((part) => part?.synthetic === true)
}

/**
 * Localize only the user-visible Goal command surface. Before the later
 * chat.message hook reaches the existing ownership/lifecycle wrappers, feed
 * those wrappers a clone containing the exact English command-owned text they
 * originally produced. The host-owned command output keeps the localized text,
 * so localization never becomes lifecycle state or model-visible authorization.
 *
 * Short resume intent is recognized across all supported languages. When the
 * Goal is actually paused, normalize that foreground message in place to the
 * already-supported English "continue" intent so the existing lifecycle wrapper
 * can replace it with the normal Goal-owned continuation prompt. Persistence is
 * never mutated directly here.
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
        await chatHook(event, withText(output, translation.owned))
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
          // Keep its in-place prompt replacement behavior intact.
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
