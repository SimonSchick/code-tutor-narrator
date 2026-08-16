# Code Tutor Narrator

Lets an agent drive VS Code like a tutor: scroll to a range of code, highlight it,
dim everything else, and narrate it out loud — then read back what you're looking at.

It exposes an **MCP server** over loopback HTTP, so Claude Code calls it as ordinary
tools rather than shelling out.

## Tools

| Tool | What it does |
| --- | --- |
| `show_code` | Scrolls to `file` + `start_line`–`end_line`, highlights it, pins an optional `note` beside it, optionally speaks `say`. Returns the numbered source lines. |
| `speak` | Says something aloud without moving the editor. Interrupts narration in progress. |
| `editor_state` | Active file, cursor line, current selection, visible line range, and any errors. |
| `clear_highlight` | Drops the highlight and stops narration. |

`show_code` blocks until narration finishes, so consecutive calls pace themselves
into a walkthrough instead of talking over each other.

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
"codeTutor.elevenlabs.voiceId": "<from elevenlabs.io/app/voice-library>",
"codeTutor.elevenlabs.modelId": "eleven_flash_v2_5"
```

Store the key with **⌘⇧P → "Code Tutor: Set ElevenLabs API Key"**. It goes into the
OS login keychain via VS Code's SecretStorage — deliberately *not* into
`settings.json`, which is easy to commit by accident. `ELEVENLABS_API_KEY` is also
honoured as a fallback.

`eleven_flash_v2_5` is the right default here: ~75ms and half the price of
`eleven_multilingual_v2`, and narration doesn't need the extra expressiveness.

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
| `codeTutor.voice` | `Samantha` | macOS `say` voice. `say -v '?'` lists them. |
| `codeTutor.rate` | `175` | Words per minute (`say` only). |
| `codeTutor.elevenlabs.voiceId` | Rachel | Voice id from the ElevenLabs library. |
| `codeTutor.elevenlabs.modelId` | `eleven_flash_v2_5` | Model id. |
| `codeTutor.elevenlabs.stability` | `0.5` | 0 is expressive and variable, 1 is flat. |
| `codeTutor.elevenlabs.speed` | `1` | Speech speed multiplier. |
| `codeTutor.cacheAudio` | `true` | Cache synthesised audio so replays are free. |

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

A cue file is also watched, so you can drive it from a terminal:

```sh
~/.claude/tutor/narrate --file src/main.rs --lines 12-20 --note "the borrow" \
  --say "Here we take a reference instead of moving the value."
~/.claude/tutor/narrate --clear
```
