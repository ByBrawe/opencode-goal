# Compaction and Goal Continuation Contract

This document defines how OpenCode Goals behaves when OpenCode compacts a session, how that differs from an explicitly paused Goal, and which component owns the next autonomous turn.

## Short version

For an **active Goal**, context compaction is transparent to the user:

1. OpenCode decides when model context should be compacted.
2. OpenCode Goals injects the persisted Goal context into the compaction request.
3. OpenCode's generic post-compaction synthetic continuation is disabled for that active Goal.
4. Exactly one Goal-owned continuation is admitted through the normal guarded Goal path.
5. The user should not need to type `continue` / `devam et` merely because compaction happened.

For a **paused Goal**, no autonomous continuation is started. `/goal resume` remains the explicit lifecycle command. A narrow set of short, unambiguous continuation messages such as `continue`, `devam et`, `kaldığın yerden devam et`, or `resume` is also treated as resume intent and routed through the same lifecycle/ownership chain.

These are deliberately different states: compaction does not pause an active Goal, while an explicit or fail-closed pause remains a persisted lifecycle decision.

## Single-owner rule

An active Goal is the continuation owner for its session.

OpenCode also has a native post-compaction auto-continue mechanism. Allowing both mechanisms to start a turn would create two autonomous owners and could dispatch duplicate prompts after the same compaction boundary. OpenCode Goals therefore keeps the native generic continuation disabled while an active Goal owns the session and uses a dedicated one-shot compaction continuation coordinator instead.

The coordinator accepts either the real post-compaction idle boundary or a guarded fallback wake-up, but both compete for the same one-shot claim. Once a Goal-owned continuation has been admitted, late or duplicate compaction idles are suppressed until the Goal-owned prompt is observed.

User steering and safety/task deferrals remain authoritative. Compaction recovery is not allowed to bypass a newer explicit user instruction, delegated work, or the normal Goal admission guards.

## What is persisted across compaction

The compaction request receives a `Persistent OpenCode goal state` context block derived from the current persisted Goal. It includes the information needed to preserve the contract across the summary boundary, including the active objective and current Goal state/progress.

Compaction is a model-context operation. It does **not** erase Goal state and it does **not** convert the Goal's cumulative work accounting into context-window accounting.

## Token budget vs. model context

These are separate concepts:

- **Model context/input limits** describe how much the selected model can accept in the current request. OpenCode owns context management and compaction decisions.
- **Goal cumulative token usage** describes total Goal-owned work observed across turns.
- New Goals have no cumulative token cap by default (`maxTokens: 0`).
- `--max-tokens` or `/goal budget --max-tokens` is an explicit total-work runaway guard. Compaction does not subtract historical Goal usage from that counter.

`/goal status` reports model context pressure separately from Goal budget/accounting. When the model exposes a smaller input limit, input-side pressure is reported independently from the full context window.

## What counts as a Goal turn

A compaction summary request is not a Goal executor turn and must not increment `goal.usage.turns`.

The Goal-owned assistant request before compaction and the Goal-owned continuation after compaction are normal Goal turns. This distinction is important for `--max-turns`, temporal requirements, accounting, and duplicate-dispatch detection.

## Real-host regression

The repository contains `scripts/host-compaction-canary.mjs` and runs it on both Ubuntu and Windows against the current OpenCode CLI.

The canary deliberately creates this race:

1. start a real `/goal` with `--max-turns 2`;
2. hold the first provider request open;
3. admit `POST /session/:id/summarize` while that Goal turn is still active;
4. release the first turn so OpenCode performs manual compaction at the safe boundary;
5. observe the compaction request and the next autonomous request.

The expected provider sequence is exactly:

```text
1. Goal-owned executor turn
2. OpenCode compaction summary request with Persistent OpenCode goal state
3. one Goal-owned continuation
```

The canary fails if:

- the persisted Goal context/objective is missing from compaction;
- OpenCode's generic `Continue if you have next steps...` continuation leaks through;
- more than one post-compaction continuation is dispatched;
- the compaction summary is counted as a Goal turn;
- the two Goal-owned turns do not stop cleanly at `--max-turns 2`.

This test is intentionally a real-host test rather than only a mocked plugin test. It protects the integration boundary where OpenCode event ordering, compaction, idle delivery, and Goal ownership meet.

## Troubleshooting decision table

| Situation | Expected behavior | User action |
| --- | --- | --- |
| Goal is active and OpenCode compacts | Goal context survives; exactly one Goal-owned continuation starts | None |
| Goal is active and normal turn becomes idle | Normal guarded Goal continuation starts | None |
| Goal is explicitly paused | No autonomous continuation | `/goal resume` or a short explicit continuation message |
| Verifier timeout exhausts its bounded retry and Goal becomes paused | Goal stays paused; evidence is preserved | Fix/wait for provider, then `/goal resume` or a short explicit continuation message |
| Goal reaches `--max-turns`, explicit token/runtime/cost limit, or another hard stop | Goal stops according to that limit | Inspect `/goal status` / `/goal audit`; raise or change the limit only if intended |
| Prompt-producing OpenCode Loop also targets the same active Goal session | Two autonomous controllers may compete | Pause/remove the prompt Loop or use a separate session |

## Türkçe özet

Aktif bir Goal sırasında OpenCode context compaction yaparsa kullanıcıdan ayrıca `devam et` yazması beklenmez. Goal state compaction isteğine taşınır, OpenCode'un generic post-compaction continue mekanizması o aktif Goal için kapalı tutulur ve normal Goal guard'larından geçen **tek bir Goal-owned continuation** başlatılır.

Buna karşılık Goal gerçekten `paused` durumundaysa autonomous continuation yapılmaz. `/goal resume` açık lifecycle komutudur; `devam et`, `continue`, `kaldığın yerden devam et` veya `resume` gibi kısa ve açık devam mesajları da aynı resume/ownership zincirine yönlendirilir.

Compaction model context'ini yönetir; geçmiş Goal token kullanımını silmez. Yeni Goal'larda cumulative token limiti varsayılan olarak yoktur (`maxTokens: 0`). `--max-tokens` yalnız kullanıcı açıkça toplam çalışma için runaway guard istediğinde kullanılır.

Ubuntu ve Windows real-host canary'si gerçek OpenCode `summarize` akışında şu diziyi zorunlu tutar: ilk Goal turnü -> Goal context'li compaction summary -> tam bir Goal-owned continuation. Generic duplicate continue, fazla provider request veya compaction summary'nin Goal turnü sayılması testi kırar.
