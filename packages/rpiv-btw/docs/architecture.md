# rpiv-btw architecture

Module layout, what the extension registers with Pi, how the overlay is laid out,
how state is stored, and how the package tolerates different Pi host versions.

## Modules

```
rpiv-btw/
├── index.ts             — entry; registers the command + 4 hooks
├── btw.ts               — state, snapshots, threading, the model call
├── btw-budget.ts        — history cap + branch fit
├── btw-messages.ts      — BtwTurn + message-text extractors
├── btw-ui.ts            — centered Markdown card, footer wait status and keys
├── pi-compat.ts         — host-tolerant pi-ai /compat loaders
└── prompts/btw-system.txt — system prompt for the side call
```

Pi discovers the extension through the manifest block in `package.json`:

```json
"pi": { "extensions": ["./index.ts"] }
```

That is the entire registration surface. The package ships no skills, no agents,
no `bin`, and declares no `exports` or `main`. A test (`ship-manifest.test.ts`)
asserts that the published `files` list covers every production module.

## What gets registered

One slash command:

| Command | Description string |
| --- | --- |
| `/btw <question>` | `Ask a side question without polluting the main conversation` |

Four lifecycle hooks:

| Event | Behavior |
| --- | --- |
| `message_end` | Snapshots the branch, only for assistant messages whose `stopReason` is not `toolUse` |
| `session_compact` | Invalidates this session's cached snapshot |
| `session_tree` | Invalidates this session's cached snapshot |
| `session_shutdown` | Aborts the side call, clears its footer status and dismisses its card before context invalidation |

No tools are registered. No CLI flags are added.

## State

All state lives on a single process-wide cell:

```ts
export const BTW_STATE_KEY = Symbol.for("rpiv-btw");
```

It holds two maps — `histories` and `snapshots` — both keyed by
`ctx.sessionManager.getSessionFile()`, with `memory:<sessionId>` as the fallback
key when there is no session file.

Using `globalThis` plus `Symbol.for()` (the same idiom OpenTelemetry uses for
cross-import-graph singletons) means the cell survives module re-import, so
`/btw` history outlives `/new`, `/fork`, `/resume`, and `/reload`. It is lost
when the Pi process exits — by design. Nothing is persisted to disk, and the
package reads no environment variables and no config files.

## Wait and answer card

Before the first text token, `startBtwWaiting` animates a braille indicator through
`ctx.ui.setStatus("btw", ...)` every 80 ms. It adds no widget or input hook, so the
editor and its keys remain available. Only one `/btw` can be open at a time.
The wait stops on the first text token, completion, error or session shutdown.

`showBtwOverlay` mounts a `Component` through `ctx.ui.custom` on the first text
token, or on a successful final answer from a provider that emits no deltas:

| Option | Value |
| --- | --- |
| `anchor` | `center` |
| `width` | `90%` |
| `maxHeight` | `70%` (`BTW_MAX_HEIGHT_RATIO = 0.7`) |

Render order, top to bottom:

```
rounded border
question title                         sticky
separator
history, Markdown answer or error      scrollable
context-trim notice (when applicable)   scrollable
separator
key-hint footer                        sticky
rounded border
```

The card grows with content up to `floor(terminalRows × 0.7)`. Streaming follows
the newest content until the user scrolls up. Returning to the bottom resumes
following. The body uses Pi's `Markdown` and `getMarkdownTheme()` rather than a
second Markdown renderer. Very short terminals omit the frame to retain a
content viewport and the dismiss hint.

### Keys and footer gates

| Key | Action | Matching |
| --- | --- | --- |
| `Esc` | Aborts the in-flight call and dismisses the overlay | `matchesKey` (ANSI + Kitty) |
| `↑` | Scroll up one row, clamped at 0 | `matchesKey` |
| `↓` | Scroll down one row, clamped to the overflow amount | `matchesKey` |
| `x` | Clears this session's `/btw` history and resets scroll | raw `data === "x"` — uppercase `X` is not bound |

| Footer hint | Shown when |
| --- | --- |
| `↑/↓ to scroll` | the body exceeds its viewport |
| `x to clear history` | this session has at least one prior `/btw` turn |
| `Esc to dismiss` | always |

Hints are joined with `" · "` and truncated to the card width. Before the card
opens, `Esc` keeps Pi's normal behavior and does not cancel `/btw`.

## Host-version tolerance

pi-ai resolves at runtime against the *host's* copy (all three pi peers are
declared `"*"`), and pi moved the global dispatch API to a `/compat` entrypoint
in 0.80.1. `pi-compat.ts` first probes the host's auth-aware
`ModelRuntime.streamSimple` through `getRuntimeStreamSimple(ctx.modelRegistry)`
(available since Pi 0.80.8). The bound method receives only `{ signal }`, letting
Pi apply OAuth credentials, headers and credential-derived endpoints. A missing
literal API key is valid on this path.

For hosts without runtime streaming, `loadStreamSimple()` resolves the legacy
function and passes the preflight key and headers:

1. `import("@earendil-works/pi-ai/compat")` — pi >= 0.80.1.
2. On a **module-resolution** failure only, fall back to
   `import("@earendil-works/pi-ai")` — pi <= 0.79.x, which has no `/compat`
   subpath at all.

The fallback is gated on the error codes `ERR_PACKAGE_PATH_NOT_EXPORTED`,
`ERR_MODULE_NOT_FOUND`, and `MODULE_NOT_FOUND`, walked down the `cause` chain
(bounded at 16 links, because ESM loaders and test mock layers nest the real
code). Any other `/compat` error — the entrypoint exists but throws at module
init — rethrows, so a real failure surfaces instead of being masked by a root
import that may not have the export.

If neither entrypoint exposes the function, the call fails with
`pi-ai does not expose streamSimple on /compat or the package root — unsupported host pi-ai version`.

`/compat` is documented upstream as temporary, so this module is the single place
to migrate when it is removed.

## Messages and errors

Every notify and overlay error string the package can produce:

| String | When |
| --- | --- |
| `/btw requires interactive mode` (error) | `ctx.hasUI` is false — `pi --print`, RPC |
| `Usage: /btw <question>` (warning) | the argument is empty or whitespace-only |
| `/btw requires an active model` (error) | there is no `ctx.model` |
| `/btw model (<provider>:<id>) is misconfigured: <err>` | credential lookup returned an error |
| `/btw model (<provider>:<id>) has no API key available.` | lookup succeeded but the API key is empty and runtime streaming is unavailable |
| `/btw call failed: <err ?? "unknown error">` | the stream returned `stopReason: "error"` |
| `/btw call threw: <message>` | credential lookup or streaming threw and the call was not aborted |
| `/btw returned no text content.` | the response contained no text parts |

Errors before the first text token use `ctx.ui.notify` toasts and do not open a
card. Errors after the card opens render inside it. A stream that closes without
a terminal message reports `stream ended without a final message` through the
`call threw` path. A second command while one is open produces a warning asking
the user to wait for and dismiss the existing answer.

## Boundaries

- **No runtime dependencies.** No `dependencies`, no `devDependencies` — only the
  three `@earendil-works` peers.
- **No sibling imports at runtime.** `pi-compat.ts` deliberately duplicates
  rpiv-core's `isModuleNotFound` rather than importing it, because the rpiv
  packages never import each other at runtime.
- **Standalone.** rpiv-btw is excluded from `rpiv-pi`'s auto-install sibling list,
  and a test asserts that exclusion.
