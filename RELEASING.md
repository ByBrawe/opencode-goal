# Releasing OpenCode Goals

This project intentionally separates **release readiness** from **publishing**. CI can prove that a commit is packageable; publishing still requires an authorized npm account and an explicit human release decision.

## Automated release gate

Before a beta can be published, the exact commit should have all repository workflows green, including:

- `CI`
- `Real Host Progress`
- `Real Restart Recovery`
- `Release Readiness`

`Release Readiness` runs on Ubuntu and Windows with Node 20 and Node 24. Each matrix job runs TypeScript checks, the full unit/regression suite, the adversarial eval corpus, then builds the npm tarball, installs that tarball into a clean temporary consumer project, and imports the package through its public export.

The package smoke test also rejects tarballs that are missing `README.md`, `LICENSE`, `dist/index.js`, `dist/index.d.ts`, or `package.json`, and rejects accidental publication of source/tests/scripts/workflow/eval files.

Local equivalent:

```text
npm install
npm run release:check
```

For a machine-readable tarball report:

```text
npm run package:smoke -- --json package-smoke-report.json
```

## Before the first npm publish

1. Protect `main` (or add an equivalent repository ruleset) so required checks cannot be bypassed by an accidental force push or unreviewed direct release change.
2. Confirm the publishing account is authorized for the npm scope used by `@bybrawe/opencode-goal`.
3. Confirm the exact release commit is the commit whose CI, real-host canaries, eval corpus, and release-readiness matrix are green.
4. Run `npm run release:check` from a clean checkout of that exact commit.
5. Inspect `npm pack --dry-run` and the package-smoke report one final time.
6. Publish the beta only as an explicit release action. Do not turn ordinary pull-request CI into a publishing path.

The package declares `publishConfig.access = public`, so a scoped publish is intended to be public. The current beta version is `0.1.0-beta.1`.

## After publishing

Verify the registry package can be installed into a clean project and that OpenCode can load the published package by its npm name. Only after that verification should the README switch from "planned npm package" / development-install wording to normal end-user npm installation instructions.
