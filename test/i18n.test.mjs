import test from "node:test"
import assert from "node:assert/strict"
import {
  SUPPORTED_GOAL_LOCALES,
  isNaturalResumeText,
  resolveGoalLocale,
  translateCoreText,
} from "../dist/i18n.js"

test("core i18n exposes 25 distinct supported locales", () => {
  assert.equal(SUPPORTED_GOAL_LOCALES.length, 25)
  assert.equal(new Set(SUPPORTED_GOAL_LOCALES).size, 25)
  assert.ok(SUPPORTED_GOAL_LOCALES.includes("tr"))
  assert.ok(SUPPORTED_GOAL_LOCALES.includes("ja"))
  assert.ok(SUPPORTED_GOAL_LOCALES.includes("zh-TW"))
  assert.ok(SUPPORTED_GOAL_LOCALES.includes("ar"))
})

test("locale resolution accepts common OS locale forms and falls back safely", () => {
  assert.equal(resolveGoalLocale("tr_TR.UTF-8"), "tr")
  assert.equal(resolveGoalLocale("pt_BR.UTF-8"), "pt-BR")
  assert.equal(resolveGoalLocale("zh_HK.UTF-8"), "zh-TW")
  assert.equal(resolveGoalLocale("zh_CN.UTF-8"), "zh-CN")
  assert.equal(resolveGoalLocale("nb_NO.UTF-8"), "no")
  assert.equal(resolveGoalLocale("xx_YY"), "en")
})

test("short explicit resume intent is recognized across supported languages", () => {
  for (const text of [
    "devam et",
    "Weiter!",
    "continuer",
    "continuar",
    "riprendi",
    "doorgaan",
    "kontynuuj",
    "продолжить",
    "продовжити",
    "pokračuj",
    "fortsätt",
    "fortsæt",
    "jatka",
    "fortsett",
    "continuă",
    "folytasd",
    "συνέχισε",
    "続けて。",
    "계속해",
    "继续！",
    "繼續",
    "تابع",
  ]) assert.equal(isNaturalResumeText(text), true, text)

  for (const text of [
    "please explain why it paused",
    "bu goal neden durdu",
    "what should I do next?",
    "devam kelimesi ne demek",
  ]) assert.equal(isNaturalResumeText(text), false, text)
})

test("core command and sidebar labels localize without rewriting user content", () => {
  const source = [
    "Goal: kullanıcı metni aynen kalsın",
    "Status: paused",
    "Revision: 3",
    "Budget: 2 / 10 turns",
    "Requirements:",
    "Queue · 2",
    "ACTIVE · 1/2 proven",
    "turns 2/10 · tokens 120/1000",
  ].join("\n")

  const tr = translateCoreText(source, "tr")
  assert.match(tr, /^Hedef: kullanıcı metni aynen kalsın/m)
  assert.match(tr, /^Durum: paused/m)
  assert.match(tr, /^Revizyon: 3/m)
  assert.match(tr, /^Bütçe:/m)
  assert.match(tr, /^Gereksinimler:/m)
  assert.match(tr, /^Kuyruk · 2/m)
  assert.match(tr, /1\/2 kanıtlandı/)
  assert.match(tr, /^turlar 2\/10 · tokenlar 120\/1000/m)
  assert.match(tr, /kullanıcı metni aynen kalsın/)

  assert.equal(translateCoreText("No active goal.", "ja"), "アクティブな目標はありません。")
  assert.equal(translateCoreText("No live Goal", "ar"), "لا يوجد هدف جارٍ")
})
