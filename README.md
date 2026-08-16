# Code Tutor Narrator

[![CI](https://github.com/SimonSchick/code-tutor-narrator/actions/workflows/ci.yml/badge.svg)](https://github.com/SimonSchick/code-tutor-narrator/actions/workflows/ci.yml)

> ### ⚠️ Vibe-coded by an AI, start to finish
>
> **Every line of this extension was written by Claude** (Claude Code, Opus 5), across a
> handful of conversational sessions. I directed it and listened to the output; I did not
> write it, and I have not reviewed most of it line by line.
>
> What that means for you:
>
> - **Treat it as a prototype**, not as engineering you can lean on. It works for me, on
>   my machine, for the thing I use it for.
> - It spawns child processes, reads your settings, and sends the text you narrate to a
>   third-party API. **Read the source before you run it** — it's ~1000 lines, and that
>   is genuinely the whole review that has happened.
> - The tests are real and they pass, but they were written by the same AI that wrote the
>   code, so they encode the same assumptions and blind spots.
> - Design decisions in here were made mid-conversation and may be wrong in ways neither
>   of us noticed.
>
> Issues and PRs are welcome, but no support is promised. If you need something
> dependable, this isn't it.

Lets an agent drive VS Code like a tutor: scroll to a range of code, highlight it,
dim everything else, and narrate it out loud — then read back what you're looking at.

Requires macOS: speech goes through `say` and playback through `afplay`.

It exposes an **MCP server** over loopback HTTP, so Claude Code calls it as ordinary
tools rather than shelling out.

## Tools

| Tool | What it does |
| --- | --- |
| `show_code` | Scrolls to `file` + `start_line`–`end_line`, highlights it, pins an optional `note` beside it, optionally speaks `say`. Returns the numbered source lines. |
| `walkthrough` | A planned sequence of `beats`, played back-to-back with no pauses. Each beat takes the same fields as `show_code`. |
| `speak` | Says something aloud without moving the editor. Interrupts narration in progress. |
| `editor_state` | Active file, cursor line, current selection, visible line range, and any errors. |
| `clear_highlight` | Drops the highlight and stops narration. |

`show_code` blocks until narration finishes, so consecutive calls pace themselves
into a walkthrough instead of talking over each other.

### `show_code` or `walkthrough`?

Chained `show_code` calls leave an audible gap between beats, and the gap is *not* TTS
latency — it is the agent's round-trip to compose the next call. Nothing on this side
can shrink it.

`walkthrough` removes it by taking the whole sequence at once and synthesising beat
N+1 while N is still speaking, so playback is continuous. The trade is adaptivity: you
commit to all the narration before reading any of the code back.

- **`walkthrough`** — the tour you have already planned, an overview of a file you've
  read, anything scripted.
- **`show_code`** — you need the returned source of one beat before deciding the next,
  the user is likely to interrupt, or you're following their cursor.

Mixing them is normal: `walkthrough` a section, then drop to `show_code` for a part
worth pausing on. Interrupting a `walkthrough` stops it and reports which beat it
reached.

## Driving it from an agent

Claude Code should enter through the `tutor` skill rather than calling these tools
cold — the skill carries the pedagogy; this section covers the mechanics.

**Sequence the calls.** `show_code` blocks. Issue one, wait, issue the next. Batching
them into a single parallel block defeats the pacing and produces overlapping audio.
When the beats are already planned, use `walkthrough` instead of chaining — same
result, no gaps.

**Open with `editor_state`.** It reports the active file, cursor line, selection,
visible range, and current diagnostics. If something is selected or the cursor is
parked, start there instead of at line 1.

**One idea per call, 5–20 lines.** A whole file in one `show_code` is a wall of audio
with a highlight that means nothing. Use `note` as the anchor that survives after the
audio has passed — a short label like "the move happens here", not a summary.

**Jumping is cheap.** Following the difficulty — to a definition and back — is what a
human tutor does. Line order is not an obligation.

**Speak or write, never both.** If narration is playing, don't also paste the same
explanation into chat. Written text is the fallback when audio is unavailable, not an
accompaniment.

**Always `clear_highlight` at the end**, so the editor is handed back clean.

**Failure modes.** `ECONNREFUSED` means no VS Code window is open — the server lives in
the extension host and there is nothing to reconnect to. Say so and stop; do not
silently fall back to pasting the walkthrough into chat, and do not retry. A `402` is
voice plan-gating, not a code problem. See *Troubleshooting* for the rest.

**Diagnostics are advisory.** The `errors` array is whatever the language server
currently believes, which on a file full of stubs can be stale or misleading. Don't
narrate them as fact without reading the code.

## Install

```sh
npm install
npm run package          # builds code-tutor-narrator-<version>.vsix
npm run install-ext      # installs it into VS Code
```

Then reload VS Code (**Developer: Reload Window**) and register it once with Claude Code:

```sh
claude mcp add --transport http tutor http://127.0.0.1:51730/mcp --scope user
```

The server only exists while VS Code is open. If Claude Code reports the `tutor`
server as unreachable, that just means no window is running.

**Raise the tool timeout.** `walkthrough` holds its response open for as long as the
narration lasts, and an HTTP MCP server gets only 60 seconds per request by default —
so a tour of any length reports `The operation timed out` while the audio carries on
playing. Progress notifications do *not* extend that window; only config does. Add a
`timeout` to the server entry in `~/.claude.json`:

```jsonc
"tutor": {
  "type": "http",
  "url": "http://127.0.0.1:51730/mcp",
  "timeout": 600000
}
```

Restart Claude Code afterwards — the value is read at connect. Note the separate
five-minute *idle* timeout for HTTP servers: a single `walkthrough` that narrates for
longer than that aborts regardless, so keep one call under ~5 minutes of speech, or
raise `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.

## Choosing a voice

`codeTutor.tts.provider` picks the backend. The built-in macOS voices are the
default because they always work, but they are the weakest option.

| Provider | Quality | Latency | Cost | Notes |
| --- | --- | --- | --- | --- |
| `say` | Poor → decent | Instant | Free | Decent *only* with Premium voices installed — see below. Offline. |
| `elevenlabs` | Best | ~75ms (flash) | ~$0.05 / 1k chars | Needs an API key. Audio is cached, so replays are free. |
| `command` | Whatever you point it at | Depends | Usually free | Escape hatch for local models (Kokoro, Piper) or another API. |

### Free first: install better macOS voices

The stock `Samantha` is a *compact* voice, and it sounds like 2005. macOS ships far
better ones, they're just not downloaded by default:

**System Settings → Accessibility → Spoken Content → System Voice → Manage Voices**

Grab an **Enhanced** or **Premium** English voice (Ava, Zoe, and Evan are the good
ones), then set `codeTutor.voice` to its exact name. Confirm with `say -v '?'`.
This costs nothing and closes most of the gap.

### ElevenLabs

```jsonc
"codeTutor.tts.provider": "elevenlabs",
"codeTutor.elevenlabs.voiceId": "<see below>",
"codeTutor.elevenlabs.modelId": "eleven_flash_v2_5"
```

**Voice ids are plan-gated.** Voice *Library* (community) voices are paid-only via the
API. On a free plan they play fine in the web UI and then fail here with
`402 paid_plan_required: Free users cannot use library voices via the API` — so copying
an id out of the library is the one obvious move that doesn't work. Either use a default
voice, or add a library voice to your workspace, which mints a new id you own. List what
your key can actually reach:

```sh
curl -s -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/voices \
  | jq -r '.voices[] | "\(.category)\t\(.voice_id)\t\(.name)"'
```

Anything `premade` works on the free plan. Buying pay-as-you-go credits does **not**
lift this: PAYG is a balance, not a tier, and plan-level restrictions come from the
subscription. Starter ($6/mo) is the cheapest plan that unlocks library voices.

Store the key with **⌘⇧P → "Code Tutor: Set ElevenLabs API Key"**. It goes into the
OS login keychain via VS Code's SecretStorage — deliberately *not* into
`settings.json`, which is easy to commit by accident. `ELEVENLABS_API_KEY` is also
honoured as a fallback.

`eleven_flash_v2_5` is the right default here: ~75ms and half the price of
`eleven_multilingual_v2`, and narration doesn't need the extra expressiveness.

### Speaking faster

There are two speed knobs and they are not interchangeable.

`codeTutor.elevenlabs.speed` changes how the voice is *synthesised*, and the API caps
it at 1.2 — 1.25 is a 400, not a clamp, so narration fails outright.

`codeTutor.playbackRate` speeds up the audio *after* it arrives, via `afplay -r` with
the high-quality algorithm, so pitch is preserved rather than chipmunked. It has no
1.2 ceiling, costs nothing, and doesn't invalidate the cache — playback speed isn't
part of the cache key, so you can re-tune it as often as you like without paying for
another synthesis. It's the right knob for genuinely fast narration:

```jsonc
"codeTutor.playbackRate": 1.5
```

The two stack, so 1.2 synthesis × 1.5 playback ≈ 1.8× overall. Past roughly 2× the
articulation starts to blur, but that's taste rather than a limit.

Budget roughly: continuous speech runs ~800 characters/minute, so a solid hour of
*talking* is around $2.50 — realistically closer to $1/hour once you account for
pauses and questions. Synthesised audio is cached by content hash, so re-walking
the same code is free.

### Local models (free, offline, private)

Point `command` at anything that reads text on stdin and plays it:

```jsonc
"codeTutor.tts.provider": "command",
"codeTutor.tts.command": "kokoro-tts - --stdout | afplay -"
```

Kokoro-82M is the sweet spot on Apple Silicon — Apache-licensed, runs faster than
real time on CPU, ~100ms, and clearly better than `say`. It's still short of
ElevenLabs on expressiveness, which matters less for steady narration than it
would for character work.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codeTutor.port` | `51730` | Loopback port for the MCP server. |
| `codeTutor.tts.provider` | `say` | `say`, `elevenlabs`, or `command`. |
| `codeTutor.tts.command` | — | Command for the `command` provider; text arrives on stdin. |
| `codeTutor.voice` | `Samantha` | macOS `say` voice. **`say` only** — ElevenLabs uses `elevenlabs.voiceId`. `say -v '?'` lists them. |
| `codeTutor.rate` | `175` | Words per minute. **`say` only** — silently ignored by the other providers. |
| `codeTutor.elevenlabs.voiceId` | Rachel | Voice id. Plan-gated — see above. Only applies when the provider is `elevenlabs`; the `say` provider uses `codeTutor.voice`. |
| `codeTutor.elevenlabs.modelId` | `eleven_flash_v2_5` | Model id. |
| `codeTutor.elevenlabs.baseUrl` | `https://api.elevenlabs.io` | Override for a proxy or a test stub. |
| `codeTutor.elevenlabs.stability` | `0.5` | 0 is expressive and variable, 1 is flat. |
| `codeTutor.elevenlabs.similarityBoost` | `0.75` | How closely to match the reference voice. |
| `codeTutor.elevenlabs.speed` | `1` | Synthesis speed. Must be 0.7–1.2; outside that the API returns 400 and nothing is spoken. |
| `codeTutor.playbackRate` | `1` | Local playback speed, applied after synthesis. No 1.2 ceiling — this is the knob for fast narration. |
| `codeTutor.cacheAudio` | `true` | Cache synthesised audio so replays are free. |

Blank values fall back to the default rather than being sent as empty, so clearing a
setting is the same as unsetting it.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `connect ECONNREFUSED 127.0.0.1:51730` | No VS Code window. The server lives inside the extension host; nothing to reconnect to. |
| `walkthrough` returns "The operation timed out" | The call outlived the MCP request window, but the narration is still playing. **Never retry** — you'd double-trigger audio. Raise the per-server `timeout`; see *Install*. |
| A new tool doesn't appear after installing | The MCP client caches `tools/list` from when it connected. Reloading VS Code is not enough; reconnect the server (`/mcp` in Claude Code). |
| `402 paid_plan_required` | Library voice on a free plan. See *Choosing a voice*. |
| `401` from ElevenLabs | No key stored. Run **Code Tutor: Set ElevenLabs API Key**, or export `ELEVENLABS_API_KEY`. |
| A settings change does nothing | Stale build. Config is read per call, so if a new setting is ignored the installed VSIX predates it. |
| Speech speed setting does nothing | `codeTutor.rate` is `say`-only. On ElevenLabs the knob is `codeTutor.elevenlabs.speed`, clamped by the API to ~0.7–1.2. |
| `stability` / `similarityBoost` change does nothing | Cache hit. The key covers provider, voice, model, and speed — but not those two. Set `codeTutor.cacheAudio` to `false` while tuning them. |
| Silence, no error, `command` provider | The command is responsible for *playing*, not just synthesising. It needs to end in something like `afplay -`. |

`npm run install-ext` installs alongside older versions rather than replacing them —
VS Code runs the highest. To see what is actually installed:

```sh
ls -d ~/.vscode/extensions/*code-tutor*
```

Reload the window (**Developer: Reload Window**) after installing; the extension host
does not pick up a new build on its own. **Code Tutor: Show server status** reports the
port and active provider, and the **Code Tutor** output channel logs each request.

## Development

```sh
npm run watch   # recompile on change
npm test        # MCP transport tests + TTS backend tests
```

`src/mcp.ts` and `src/tts.ts` deliberately have no `vscode` import, which is what
makes them testable outside the extension host — the ElevenLabs client is verified
against a local stub server, so the request shape is covered without a real key or
a single billed character. Everything that touches the editor lives in
`src/extension.ts` and is covered by the type checker instead.

## Without an agent

A cue file is also watched, so you can drive it from a terminal. `bin/narrate` is a
small bash wrapper around that:

```sh
./bin/narrate --file src/main.rs --lines 12-20 --note "the borrow" \
  --say "Here we take a reference instead of moving the value."
./bin/narrate --clear
```

It writes to `~/.claude/tutor/cue.json` and speaks with `say`, configurable through
`TUTOR_VOICE`, `TUTOR_RATE`, `TUTOR_TTS_CMD`, and `TUTOR_MUTE`. It does not go through
the MCP server at all, so it works without Claude Code.

## The agent side

`skill/SKILL.md` is the [Claude Code skill](https://code.claude.com/docs/en/skills) that
teaches an agent how to tutor with these tools — when to narrate, how long a beat should
be, when to stop and ask. Copy it into your skills directory to use it:

```sh
mkdir -p ~/.claude/skills/tutor && cp skill/SKILL.md ~/.claude/skills/tutor/
```

The extension is usable without it; you'll just be explaining the tools to your agent
yourself each time.

## License

MIT — see [LICENSE](LICENSE).
