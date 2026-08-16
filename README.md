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

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codeTutor.port` | `51730` | Loopback port for the MCP server. |
| `codeTutor.voice` | `Samantha` | macOS `say` voice. `say -v '?'` lists them. |
| `codeTutor.rate` | `175` | Words per minute. |

For a markedly better voice, download an Enhanced or Premium one:
**System Settings → Accessibility → Spoken Content → System Voice → Manage Voices**
(Ava, Zoe, and Evan Premium are the natural-sounding ones), then set `codeTutor.voice`
to its exact name.

## Development

```sh
npm run watch   # recompile on change
npm test        # protocol tests for the MCP transport
```

`src/mcp.ts` deliberately has no `vscode` import, which is what makes the transport
testable outside the extension host. Everything that touches the editor lives in
`src/extension.ts` and is covered by the type checker instead.

## Without an agent

A cue file is also watched, so you can drive it from a terminal:

```sh
~/.claude/tutor/narrate --file src/main.rs --lines 12-20 --note "the borrow" \
  --say "Here we take a reference instead of moving the value."
~/.claude/tutor/narrate --clear
```
