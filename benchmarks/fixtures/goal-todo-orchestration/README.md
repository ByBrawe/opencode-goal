# Goal Todo orchestration fixture

This repository is ready only when its existing release contract is satisfied.

## Existing release contract

- `normalizeLabel(value)` keeps its public export name and one-argument API.
- It returns trimmed lowercase words separated by a single `-`, collapsing any run of whitespace between words.
- `npm test` passes without changing the test contract.
- `STATUS.md` contains exactly `READY` (plus the normal trailing newline) only after the implementation and tests satisfy this contract.

## Boundaries

Do not add dependencies, rename the public export, modify `package.json`, change the tests, or invent unrelated product features. Fix only what is required to make this existing project ready.
