# autoprompter

An OpenCode V2 plugin that intercepts each user prompt, rewrites it with the
bundled [`prompt-design`](vendor/prompt-design/SKILL.md) skill using an
auto-selected **free** OpenCode model, and submits only the rewritten prompt to
the original session.

Published on npm as [`autoprompter`](https://www.npmjs.com/package/autoprompter).

## Features

- Intercepts prompts through the `prompt` admission hook — no extra session,
  no history, no hook recursion.
- Automatically selects a free model from **any** provider, preferring the
  model the current session is already using (with override + fallback chain).
- Bundles the `prompt-design` skill, or points at a live skill folder via
  `skillPath`.
- Returns **only** the optimized prompt: fenced output is unwrapped (unless the
  original prompt was itself a fence), reasoning markers are stripped, and
  questions, preambles, scaffolding, invented `{{PLACEHOLDERS}}`, and the
  clarification sentinel cause the output to be rejected.
- Fails open: any error, timeout, empty result, or rejected output leaves the
  original prompt intact. A rejected candidate triggers the next free model;
  there is no cross-prompt cooldown.
- Skips `/` commands and `!` shell commands (for example `!git status`), while
  still optimizing text like `!Important: fix the bug`.

## Requirements

- OpenCode v2.2+ (uses `Plugin.define` and the session `prompt` hook).
- Node.js 20+.

## Install

Install from npm:

```sh
opencode plugin add autoprompter
```

Or install the latest GitHub source:

```sh
opencode plugin add github:SchooiCodes/autoprompter
```

For local development, add the plugin to your OpenCode config
(`~/.config/opencode/opencode.json`) by path:

```json
{
  "plugin": [
    {
      "package": "/absolute/path/to/autoprompter",
      "options": { "enabled": true }
    }
  ]
}
```

On this machine the entry is:

```json
{
  "package": "C:/Users/Schooi/Documents/GitHub/autoprompter",
  "options": {
    "enabled": true,
    "skillPath": "C:/Users/Schooi/Documents/GitHub/autoprompter/vendor/prompt-design"
  }
}
```

Run `opencode reload` (or restart OpenCode) after changing the config.

## Options

Pass these in the plugin entry's `options` object:

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Disable all rewriting without uninstalling. |
| `skillPath` | bundled `vendor/prompt-design` | Absolute path to a live skill folder. The loader reads `SKILL.md` plus every `references/*.md` in it. |
| `model` | auto-discovered | `{ "providerID": "opencode", "id": "..." }` override; used exclusively when set. |
| `excludePrefixes` | `["/", "!"]` | Prefixes that pass through. A leading `!` is skipped only for shell-like commands, not prose. |
| `timeoutMs` | `30000` | Max total wait across all optimizer attempts, in milliseconds. |
| `maxCandidates` | `12` | Total number of free models to try. One slot is reserved for the hardcoded fallback. |
| `showOptimized` | `true` | Show the optimized text in the message bubble; the typed text is kept in `metadata.originalText`. Set `false` to show what you typed. |
| `log` | `false` | Log rewrites, rejected outputs, and failures via `console.warn`. |

## How it works

1. A `prompt` admission hook receives the incoming user prompt.
2. Empty prompts and command prefixes are passed through. Every other prompt
   gets a fresh optimizer attempt; a past failure never silences later prompts.
3. The bundled skill plus the original prompt are sent to
   `ctx.experimental.generate.text()` on a free model (falling back to
   `ctx.generate.text()` on older versions).
4. The response is sanitized: surrounding prose/fences are stripped, reasoning
   markers are removed, and output that looks like a clarifying question,
   preamble, scaffolding, invented `{{PLACEHOLDERS}}`, or the
   `AUTOPROMPTER_NEEDS_CLARIFICATION` sentinel is rejected. A rejected result
   tries the next candidate instead of being injected into the user's message.
5. Only a clean rewrite replaces `event.prompt.text`. Stale `mention` offsets on
   attachments are cleared, and the message bubble shows the optimized text
   while `metadata.originalText` keeps what you typed. If every candidate
   errors, times out, is empty, or is rejected, the original prompt passes
   through unchanged.

The skill's normal delivery section asks for a fenced prompt plus an
explanation; the plugin's output contract overrides that and also tells the
optimizer it may decline with the sentinel when the task is genuinely
undefined, rather than inventing details.

## Model selection

The plugin discovers **every free model from every provider** (`opencode`,
`openrouter`, custom providers, ...) and ranks them:

1. The model the current session is using (so the optimizer matches the model
   you are already talking to).
2. Known-fast free models: `hy4-flash-free`, `deepseek-v4.1-flash-free`,
   `mimo-v2.6-flash-free`, `beam-free`, `nemotron-3.5-lightning-free`.
3. Any other free model, with a hardcoded `opencode/beam-free` fallback always
   kept as the last candidate.

`maxCandidates` is the total chain length, including the fallback slot. If the
first candidate is rate-limited, errors, returns an empty result, or returns a
rejected rewrite, the plugin tries the next free model. Only when **all**
candidates fail does the original prompt pass through unchanged. An explicit
`options.model` overrides all of this and is used exclusively.

Note: OpenCode's `model.list()` returns `{ data: [...] }` in practice even
though the docs describe an array; both shapes are handled.

## Auto-install prompt for an LLM

Copy and paste this into any coding LLM:

> Install the OpenCode plugin `autoprompter` for me. Run
> `opencode plugin add autoprompter`, then verify with `opencode plugin list`
> that `autoprompter` is present and active. If OpenCode is already running,
> run `opencode reload`. Report the exact commands you ran and whether the
> plugin is active. Do not change any other plugins or settings.

## Development

```pwsh
npm install
npm run typecheck
npm test
```

The repo is laid out as:

```
src/                plugin implementation (index, model, prompt, skill)
vendor/prompt-design/ bundled prompt-design skill (SKILL.md + references/)
skill/              legacy bundled prompt-optimizer copy
test/               node:test unit tests
```

## Troubleshooting

- **No rewriting happening:** enable `"log": true`, run `opencode reload`, and
  check the log for `rate_limit` / `429` or `rejected non-rewrite`. The free tier
  may be exhausted or the model may have returned a question/scaffold. The
  plugin falls back to the original prompt and tries again on the next prompt —
  there is no cooldown.
- **Wrong model selected:** set `options.model` explicitly to force one.
- **Skill drift:** set `options.skillPath` to your live skill folder instead of
  using the bundled copy.

## Limitations

- `ctx.experimental.generate.text()` is experimental; future OpenCode API
  changes may require an update.
- Every eligible prompt adds one extra model call (latency; no cost on free
  models).
- Prompt hooks run once at admission; option changes need a new session/prompt.

## License

[MIT](LICENSE) © 2026 SchooiCodes
