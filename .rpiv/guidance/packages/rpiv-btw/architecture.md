# rpiv-btw

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Not in `rpiv-pi`'s auto-install bundle (dropped from `siblings.ts` and its `peerDependencies`) — installed and loaded independently.

## Responsibility
Slash-command-only Pi extension. Spawns a one-off side call to the same primary model with a read-only clone of the current conversation as context, streams a Markdown answer into a centered ephemeral card, and never writes back to the main agent's transcript or to disk. Per-session history is process-scoped via a `globalThis` Symbol-keyed singleton.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`/`ExtensionContext`, branch-to-LLM converter (`convertToLlm`), `SessionEntry`/`Theme` types
- **`@earendil-works/pi-ai`** (peer): the legacy global `streamSimple` fallback and the overflow detector `isContextOverflow` (both resolved lazily via `pi-compat.ts` against the host's copy — never a static import), plus message types; the PRIMARY side-call entry is the host's `ModelRuntime.streamSimple` facade read structurally off `ctx.modelRegistry` (also via `pi-compat.ts`), with `tools: []` passed on either path
- **`@earendil-works/pi-tui`** (peer): `Markdown`, overlay/component types (`OverlayOptions`, `Component`, `TUI`), key-matching (`matchesKey`), ANSI-safe width/wrap helpers

## Consumers
- **Pi extension host**: loads via `pi.extensions: ["./index.ts"]` — the sole consumer

## Module Structure
```
.                — Flat package. Logic + state in one source module (btw.ts); overlay controller in another (btw-ui.ts);
                   the BtwTurn record + text extractors in a cycle-break leaf (btw-messages.ts); context budgeting in
                   btw-budget.ts; host-version-tolerant `streamSimple` loader in `pi-compat.ts` (shipped via `files`);
                   composer (index.ts) wires command registrar + lifecycle hooks.
prompts/         — System-prompt asset shipped via `files`. Loaded once at module init.
```

## No-Pollution Architecture
Five layered constraints keep the main transcript untouched:
1. **Read-only branch clone** — a snapshot of session messages is taken at `message_end` and held until invalidation; calls work off the clone (cold-start only: a live `ctx.sessionManager.getBranch()` read before the first `message_end`)
2. **Direct LLM call bypasses the agent loop** — the call runs **without** tools (no `registerTool` here; the call site MUST pass an empty tool set) so no tool turn lands in transcript
3. **Own `AbortController`** — never reuse the caller's session signal; Esc in the card cancels only the side-question
4. **Centered card via `ctx.ui.custom`** — no agent-message emission, so nothing surfaces in transcript
5. **Process-scoped, session-keyed storage** — history lives on a well-known `globalThis` Symbol cell, never on disk

## Stable-Reference Prompt-Cache Discipline
History stores **actual** `UserMessage`/`AssistantMessage` object references (never re-fabricated) and concatenates them in a deterministic order so the prefix bytes stay byte-identical across turns — this is what keeps prompt-cache hits warm. The architectural rule: **no copy, no mutate, no reorder** of any message the LLM has already seen.

## Snapshot Invalidation
The cached branch clone is dropped on `session_compact` and `session_tree`. Without invalidation, post-compact callers would see a stale view of the conversation. Invalidation is event-driven — never time- or size-based. The snapshot carries both `{ messages, entries }`: the converted `Message[]` for fast-path prompt-cache parity, and the raw `SessionEntry[]` retained so `fitBranch`/`findCutPoint`/`getLastAssistantUsage` can re-slice the cached snapshot on retry without re-reading `ctx.sessionManager.getBranch()`.

## Context Budgeting

`/btw` side calls are bounded so they fit the model's context window instead of failing on long sessions or silently degrading the prompt cache.

- **Fast-path parity guarantee** — when the whole request fits, `buildBtwMessages` returns reference-identical cached messages plus the FULL `BtwTurn` history (`toBe`, no copy/mutate/reorder), byte-identical to the pre-budgeting assembly — the history cap (`BTW_HISTORY_TOKEN_BUDGET`) engages only once the full-history request is over budget (and always on the overflow retry). Trimming only ever produces a strict subset or a stubbed copy; it never mutates the cached snapshot.
- **Host-primitives rule** — `btw-budget.ts` value-imports the six host primitives (`calculateContextTokens`, `convertToLlm`, `estimateTokens`, `findCutPoint`, `getLastAssistantUsage`, `sessionEntryToContextMessages`) from `@earendil-works/pi-coding-agent` with no re-implementation. It deliberately does NOT reuse the host's backward `findTurnStartIndex` for the forward turn-start scan — the host's scan direction is wrong for this package's trim semantics. Branch accounting anchors on the last valid assistant usage PLUS `estimateTokens` over every unmetered entry after it (turns the provider hasn't billed still occupy the window). The budget constants live in `btw-budget.ts` (leaf module; `btw.ts` re-exports them) so the module cycle stays type-only at runtime.
- **Single-retry rule** — exactly one overflow retry halves `keepBudget`; the rebuild re-slices the cached snapshot (never re-reads `ctx.sessionManager.getBranch()`). Legacy hosts where `isContextOverflow` is absent degrade gracefully with no retry, and never crash.

## Version-Tolerant `streamSimple` Resolution
`executeBtw` resolves the call in two tiers. FIRST it tries Pi's auth-aware `ModelRuntime.streamSimple` facade via `getRuntimeStreamSimple(ctx.modelRegistry)` from `pi-compat.ts` (Pi >= 0.80.8) — preferred because Pi applies credential-derived request fields internally (OAuth tokens, GitHub Copilot's OAuth-specific `baseUrl`), so that path passes only `{ signal }` (NEVER explicit `apiKey`/`headers`, which would bypass Pi's credential resolution), and a missing literal API key is not fatal when the facade exists. Only when the host exposes no runtime streaming method does it fall back to awaiting `loadStreamSimple()` — never a static import, because pi-ai resolves against the HOST's copy (peer `"*"`). The fallback tries `@earendil-works/pi-ai/compat` first (Pi >= 0.80.1 moved the global dispatch API there), falling back to the package root ONLY on module-resolution failures (`ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`, walking the error `cause` chain); any other `/compat` error rethrows so real init failures surface instead of being masked. `/compat` is temporary — when pi's ModelManager migration deletes it, `pi-compat.ts` is the single place to migrate.

## Architectural Boundaries
- **NO disk persistence** — `globalThis` only; lost on Pi exit by design
- **NO `ctx.signal` reuse** — own `AbortController` so Esc cancels only this command, not the main session
- **NO tool registration** — slash command + lifecycle hooks only
- **NO runtime imports of sibling packages** — `pi-compat.ts` deliberately duplicates rpiv-core's `isModuleNotFound` (plus the subpath-export code); siblings never import each other at runtime
- **System prompt is frozen** — dynamic context appended via a hint helper; never mutate the static prefix (cache parity)

<important if="you are customizing the BTW overlay">
## Customizing the Overlay
Architectural rules for overlay edits:
- **Mode set is a closed union** — extending modes requires a matching setter + render trigger so state and view never desync
- **Styling goes through `theme.fg/bg(...)`** and width-safe pi-tui helpers — never raw ANSI; visible-width math must be SGR-aware
- **Keys via `matchesKey`** — Esc in the card aborts the controller AND resolves `done()`. Before the first text token no input hook is installed, so Pi retains all editor and main-agent keys.
- **Scroll is layout-driven** — lay out natural rows first, then clip the body; title and footer stay visible. Streaming follows the bottom unless the user scrolls up.
- **Lifecycle cleanup** — `session_shutdown` aborts the active request and clears its wait timer before context invalidation. Ignore late tokens and do not persist cancelled turns.
- **Final-message identity** — deltas only drive display; history uses the provider's final `AssistantMessage` object. Early errors use toasts, later errors use the open card.
</important>

<important if="you are adding a new side-question variant">
## Adding a Variant
1. Add an identity constant next to the existing command name (e.g., `BTW_DEEP_COMMAND_NAME`)
2. Add new `MSG_*`/`errXxx` constants in the existing Messages/Errors blocks — never inline strings
3. Drop a new prompt file under `prompts/`; mirror the `readFileSync` + `fileURLToPath(new URL(...))` + `.trimEnd()` recipe
4. Write a registrar mirroring the existing one; wire from the composer
5. Reuse the storage helper; pick a different storage key only if isolation from the existing variant is required
6. Keep the four-branch `StopReason` shape: aborted | error | empty | success
7. Always own the `AbortController`; never reuse `ctx.signal`
</important>
