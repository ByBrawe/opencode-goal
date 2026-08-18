import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("CHANGELOG latest release heading matches the package version", async () => {
  const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8")
  const latest = changelog.match(/^##\s+([^\s—]+)\s+—/m)?.[1]

  assert.equal(latest, packageJSON.version, `CHANGELOG latest release is ${latest ?? "missing"}; package.json is ${packageJSON.version}`)
})
