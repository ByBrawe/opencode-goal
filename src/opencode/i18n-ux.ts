import type CorePlugin from "./plugin.js"
import { currentGoalLocale, translateCoreText } from "../i18n.js"

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

/**
 * Localize only the user-visible Goal command surface. Before the later
 * chat.message hook reaches the existing ownership/lifecycle wrappers, feed
 * those wrappers a clone containing the exact English command-owned text they
 * originally produced. The host-owned command output keeps the localized text,
 * so localization never becomes lifecycle state or model-visible authorization.
 *
 * Natural-language work/resume intent is deliberately not normalized here.
 * The user's original text reaches the model unchanged; the model decides
 * semantically whether to invoke the Goal resume tool in any language.
 */
export function installGoalI18nUX(_input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

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

    await chatHook(event, output)
  }
}
