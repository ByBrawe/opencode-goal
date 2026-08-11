import test from "node:test"
import assert from "node:assert/strict"
import { requiresDistinctGoalTurnCadence } from "../dist/runtime/cadence.js"

test("recognizes Turkish and English explicit Goal-turn cadence", () => {
  assert.equal(requiresDistinctGoalTurnCadence("10 ayrı goal turu boyunca her goal turunda yalnızca +1 yap"), true)
  assert.equal(requiresDistinctGoalTurnCadence("10 ayri goal turu boyunca value degerini bir artir"), true)
  assert.equal(requiresDistinctGoalTurnCadence("Do this over 10 separate goal turns"), true)
  assert.equal(requiresDistinctGoalTurnCadence("Increment once per goal turn"), true)
  assert.equal(requiresDistinctGoalTurnCadence("Build a calculator and verify it"), false)
})
