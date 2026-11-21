# autoprompter

An OpenCode V2 plugin that intercepts each user prompt, rewrites it with the
[`prompt-optimizer`](https://github.com/) skill using an auto-selected **free**
OpenCode model, and submits only the rewritten prompt to the original session.

## Features

- Intercepts prompts through the `prompt` admission hook — no extra session,
  no history, no hook recursion.
- Automatically selects a free `opencode` model (with override + fallback).
- Bundles a copy of the skill, or points at a live folder via `skillPath`.
- Returns **only** the optimized prompt: code fences and explanations are stripped.
- Fails open: any error, timeout, or empty result leaves the original prompt intact.
- Skips `/` commands and `!` shell syntax so built-ins keep working.
- Backs off after a rate-limit response instead of retrying every prompt.

## Requirements

- OpenCode v2.2+ (uses `Plugin.define` and the session `prompt` hook).
- Node.js 20+.

## Install

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json`) by
local path:

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
  "options": { "enabled": true }
}
```

Restart OpenCode (or run `opencode reload`) after changing the config.

## Options

Pass these in the plugin entry's `options` object:

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Disable all rewriting without uninstalling. |
| `skillPath` | bundled copy | Absolute path to a live `prompt-optimizer` folder. |
| `model` | auto-discovered | `{ "providerID": "opencode", "id": "..." }` override. |
| `excludePrefixes` | `["/", "!"]` | Prompts starting with these pass through unchanged. |
| `timeoutMs` | `30000` | Max total wait across all optimizer attempts, in milliseconds. |
| `maxCandidates` | `12` | How many free models to try (the fallback is always kept). |
| `log` | `false` | Log every original → optimized rewrite. |

## How it works

1. A `prompt` admission hook receives the incoming user prompt.
2. Empty prompts and command prefixes are passed through. Every other prompt
   gets a fresh optimizer attempt; a past failure never silences later prompts.
3. The bundled `prompt-optimizer` skill plus the original prompt are sent to
   `ctx.experimental.generate.text()` on a free `opencode` model (falling back to
   `ctx.generate.text()` on older versions).
4. The response is trimmed/unwrapped and replaces `event.prompt.text`. Stale
   `mention` offsets on attachments are cleared.
5. Any error or empty result leaves the original prompt untouched.

The skill's normal "Deliver" section asks for a fenced prompt plus an
explanation; the plugin's output contract overrides that so the model returns
only the rewritten text.

## Model selection

The plugin discovers **every free model from every provider** (`opencode`,
`openrouter`, custom providers, ...) and ranks them:

1. The model the current session is using (so the optimizer matches the model
   you are already talking to).
2. Known-fast free models: `hy4-flash-free`, `deepseek-v4.1-flash-free`,
   `mimo-v2.6-flash-free`, `beam-free`, `nemotron-3.5-lightning-free`.
3. Any other free model, with a hardcoded `opencode/beam-free` fallback always
   kept as the last candidate.

If the first candidate is rate-limited, errors, or returns an empty result, the
plugin tries the next free model instead of failing open immediately. Only when
**all** candidates fail does the original prompt pass through unchanged. An
explicit `options.model` overrides all of this and is used exclusively.

Note: OpenCode's `model.list()` returns `{ data: [...] }` in practice even
though the docs describe an array; both shapes are handled.

## Development

```pwsh
npm install
npm run typecheck
npm test
```

The repo is laid out as:

```
src/          plugin implementation (index, model, prompt, skill)
skill/        bundled copy of prompt-optimizer (SKILL.md + references/)
test/         node:test unit tests
```

## Troubleshooting

- **No rewriting happening:** enable `"log": true`, restart OpenCode, and check
  the log for a `rate_limit` / `429` message. The free tier may be exhausted;
  the plugin intentionally falls back to the original prompt and pauses briefly.
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
