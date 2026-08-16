import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { createMcpServer, Tool } from "./mcp";
import { createSpeaker, Provider, Speaker, TtsConfig } from "./tts";

/**
 * Turns VS Code into something an agent can drive as a tutor: it can scroll the
 * editor to a range, highlight it, read the surrounding code back, see what the
 * user is looking at, and narrate out loud.
 *
 * The primary interface is an MCP server (see mcp.ts). A cue file is also watched
 * as a no-agent fallback, so `~/.claude/tutor/narrate` works from a plain terminal.
 */

let highlight: vscode.TextEditorDecorationType;
let dimRest: vscode.TextEditorDecorationType;
let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let server: http.Server | undefined;
let speaker: Speaker;
/** Cached from SecretStorage so speaking stays synchronous-ish. */
let elevenLabsKey: string | undefined;

function config<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration("codeTutor").get<T>(key);
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string" && value.trim() === "") {
    return fallback;
  }
  return value;
}

const SECRET_KEY = "codeTutor.elevenlabs.apiKey";

function ttsConfig(cacheDir: string): TtsConfig {
  return {
    provider: config<Provider>("tts.provider", "say"),
    voice:
      config<Provider>("tts.provider", "say") === "elevenlabs"
        ? config("elevenlabs.voiceId", "21m00Tcm4TlvDq8ikWAM")
        : config("voice", "Samantha"),
    rate: config("rate", 175),
    elevenlabs: {
      apiKey: elevenLabsKey ?? process.env["ELEVENLABS_API_KEY"],
      modelId: config("elevenlabs.modelId", "eleven_flash_v2_5"),
      baseUrl: config("elevenlabs.baseUrl", "https://api.elevenlabs.io"),
      stability: config("elevenlabs.stability", 0.5),
      similarityBoost: config("elevenlabs.similarityBoost", 0.75),
      speed: config("elevenlabs.speed", 1),
    },
    command: config<string | undefined>("tts.command", undefined),
    cacheDir: config("cacheAudio", true) ? cacheDir : "",
  };
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Code Tutor");

  highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorCursor.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorCursor.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  // Faint tint on everything else, so the highlighted band reads as "the focus".
  dimRest = vscode.window.createTextEditorDecorationType({ opacity: "0.4" });

  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  context.subscriptions.push(highlight, dimRest, statusItem, output);

  const cacheDir = path.join(context.globalStorageUri.fsPath, "audio");
  speaker = createSpeaker(() => ttsConfig(cacheDir));

  // Load the stored key before anything can ask to speak.
  void context.secrets.get(SECRET_KEY).then((value) => {
    elevenLabsKey = value;
  });
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key === SECRET_KEY) {
        void context.secrets.get(SECRET_KEY).then((value) => {
          elevenLabsKey = value;
        });
      }
    })
  );

  startServer(context);
  watchCueFile(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("codeTutor.clear", () => {
      speaker.stop();
      clear();
    }),
    vscode.commands.registerCommand("codeTutor.showStatus", () => {
      const provider = config<Provider>("tts.provider", "say");
      void vscode.window.showInformationMessage(
        `Code Tutor MCP on http://127.0.0.1:${config("port", 51730)}/mcp — voice: ${provider}`
      );
    }),
    vscode.commands.registerCommand("codeTutor.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "ElevenLabs API key",
        prompt: "Stored in the OS keychain, not in settings.json.",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      if (key.trim() === "") {
        await context.secrets.delete(SECRET_KEY);
        void vscode.window.showInformationMessage("Code Tutor: API key cleared.");
        return;
      }
      await context.secrets.store(SECRET_KEY, key.trim());
      void vscode.window.showInformationMessage("Code Tutor: API key saved.");
    })
  );
}

function startServer(context: vscode.ExtensionContext): void {
  const port = config("port", 51730);
  try {
    server = createMcpServer({
      port,
      tools: buildTools(),
      version: String(context.extension.packageJSON.version ?? "unknown"),
      onLog: (line) => output.appendLine(line),
    });
    server.on("error", (error: Error) =>
      output.appendLine(`server error: ${error.message}`)
    );
    output.appendLine(`Code Tutor MCP listening on http://127.0.0.1:${port}/mcp`);

    // A lockfile so tooling can discover the port without hardcoding it.
    const lockDir = path.join(os.homedir(), ".claude", "tutor");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "mcp.json"),
      JSON.stringify(
        { port, url: `http://127.0.0.1:${port}/mcp`, pid: process.pid },
        null,
        2
      )
    );
  } catch (error) {
    output.appendLine(`failed to start server: ${(error as Error).message}`);
  }
  context.subscriptions.push({ dispose: () => server?.close() });
}

// ------------------------------------------------------------ argument types

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" is required and must be a number`);
  }
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a number`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}

function requireArray(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown>[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`"${key}[${index}]" must be an object`);
    }
    return item as Record<string, unknown>;
  });
}

// ------------------------------------------------------------------- tools

function buildTools(): Tool[] {
  return [
    {
      name: "show_code",
      description:
        "Scroll the user's VS Code editor to a range of lines, highlight it, dim the rest, and optionally narrate it aloud. Returns the numbered source lines. Use this to walk someone through code the way a tutor would.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Path to the file, absolute or relative to the workspace root.",
          },
          start_line: { type: "number", description: "First line, 1-indexed." },
          end_line: {
            type: "number",
            description: "Last line, inclusive. Defaults to start_line.",
          },
          note: {
            type: "string",
            description:
              "Short label pinned beside the code and in the status bar.",
          },
          say: {
            type: "string",
            description:
              "Narration to speak aloud once the editor has scrolled. Blocks until finished, so consecutive calls pace themselves naturally.",
          },
          select: {
            type: "boolean",
            description: "Also make it a real text selection. Default false.",
          },
        },
        required: ["file", "start_line"],
      },
      run: async (args) => {
        const revealed = await reveal({
          file: requireString(args, "file"),
          startLine: requireNumber(args, "start_line"),
          endLine: optionalNumber(args, "end_line"),
          note: optionalString(args, "note"),
          select: optionalBoolean(args, "select") ?? false,
        });
        const narration = optionalString(args, "say");
        if (narration) {
          await speaker.speak(narration, true);
        }
        return numbered(revealed.doc, revealed.startLine, revealed.endLine);
      },
    },
    {
      name: "walkthrough",
      description:
        "Play a planned sequence of beats back-to-back with no pauses between them: each one scrolls, highlights and narrates, while the next is synthesised in the background. Use this when you already know what every beat will say. Use show_code instead when you need to read the code back before deciding what to say next, or when the user is likely to interrupt.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Default file for every beat, absolute or relative to the workspace root.",
          },
          beats: {
            type: "array",
            description:
              "Beats to play in order. One idea each: 5-20 lines, 1-3 spoken sentences.",
            items: {
              type: "object",
              properties: {
                file: {
                  type: "string",
                  description: "Overrides the top-level file for this beat.",
                },
                start_line: {
                  type: "number",
                  description: "First line, 1-indexed.",
                },
                end_line: {
                  type: "number",
                  description: "Last line, inclusive. Defaults to start_line.",
                },
                note: {
                  type: "string",
                  description: "Short label pinned beside the code.",
                },
                say: { type: "string", description: "Narration for this beat." },
                select: {
                  type: "boolean",
                  description: "Also make it a real text selection.",
                },
              },
              required: ["start_line"],
            },
          },
        },
        required: ["beats"],
      },
      run: async (args) => {
        const fallbackFile = optionalString(args, "file");
        const beats = requireArray(args, "beats");
        const sections: string[] = [];

        for (let index = 0; index < beats.length; index += 1) {
          const beat = beats[index];
          const file = optionalString(beat, "file") ?? fallbackFile;
          if (!file) {
            throw new Error(
              `beat ${index + 1} has no "file" and no top-level "file" was given`
            );
          }

          const revealed = await reveal({
            file,
            startLine: requireNumber(beat, "start_line"),
            endLine: optionalNumber(beat, "end_line"),
            note: optionalString(beat, "note"),
            select: optionalBoolean(beat, "select") ?? false,
          });
          sections.push(
            numbered(revealed.doc, revealed.startLine, revealed.endLine)
          );

          // Warm the next beat while this one is still talking. That overlap is
          // the whole point of this tool: it is what removes the gap.
          const upcoming = beats[index + 1];
          if (upcoming) {
            const nextNarration = optionalString(upcoming, "say");
            if (nextNarration) {
              speaker.prefetch(nextNarration);
            }
          }

          const narration = optionalString(beat, "say");
          if (narration) {
            const outcome = await speaker.speak(narration, true);
            if (outcome === "interrupted") {
              sections.push(
                `(stopped after beat ${index + 1} of ${beats.length})`
              );
              break;
            }
          }
        }

        return sections.join("\n\n");
      },
    },
    {
      name: "speak",
      description:
        "Say something aloud without moving the editor. Interrupts any narration already in progress.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          wait: {
            type: "boolean",
            description: "Block until speech finishes. Default true.",
          },
        },
        required: ["text"],
      },
      run: async (args) =>
        speaker.speak(
          requireString(args, "text"),
          optionalBoolean(args, "wait") ?? true
        ),
    },
    {
      name: "editor_state",
      description:
        "What the user is currently looking at: active file, cursor position, selected text, and the visible line range. Use it to pick up where their attention already is.",
      inputSchema: { type: "object", properties: {} },
      run: async () => JSON.stringify(editorState(), null, 2),
    },
    {
      name: "clear_highlight",
      description: "Remove the tutor highlight and stop any narration.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        speaker.stop();
        clear();
        return "cleared";
      },
    },
  ];
}

// ------------------------------------------------------------------ editor

interface RevealRequest {
  file: string;
  startLine: number;
  endLine: number | undefined;
  note: string | undefined;
  select: boolean;
}

interface Revealed {
  doc: vscode.TextDocument;
  startLine: number;
  endLine: number;
}

async function reveal(request: RevealRequest): Promise<Revealed> {
  const uri = resolveFile(request.file);
  if (!fs.existsSync(uri.fsPath)) {
    throw new Error(`No such file: ${request.file}`);
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preserveFocus: true,
    preview: false,
  });

  const lastLine = Math.max(doc.lineCount - 1, 0);
  const startLine = clamp(request.startLine - 1, 0, lastLine);
  const endLine = clamp(
    (request.endLine ?? request.startLine) - 1,
    startLine,
    lastLine
  );
  const range = new vscode.Range(
    startLine,
    0,
    endLine,
    doc.lineAt(endLine).text.length
  );

  const decoration: vscode.DecorationOptions = request.note
    ? {
        range,
        renderOptions: {
          after: {
            contentText: `   ${request.note}`,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
          },
        },
      }
    : { range };

  editor.setDecorations(highlight, [decoration]);
  editor.setDecorations(dimRest, dimAround(doc, startLine, endLine, lastLine));
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = request.select
    ? new vscode.Selection(range.start, range.end)
    : new vscode.Selection(range.start, range.start);

  if (request.note) {
    statusItem.text = `$(mortar-board) ${request.note}`;
    statusItem.tooltip = `${request.file}:${startLine + 1}-${endLine + 1}`;
    statusItem.show();
  } else {
    statusItem.hide();
  }

  return { doc, startLine, endLine };
}

function numbered(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number
): string {
  const width = String(endLine + 1).length;
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    lines.push(`${String(line + 1).padStart(width)}  ${doc.lineAt(line).text}`);
  }
  return lines.join("\n");
}

function editorState(): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { activeFile: null };
  }
  const doc = editor.document;
  const visible = editor.visibleRanges.length > 0 ? editor.visibleRanges[0] : undefined;
  return {
    activeFile: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    lineCount: doc.lineCount,
    cursorLine: editor.selection.active.line + 1,
    selection: editor.selection.isEmpty
      ? null
      : {
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1,
          text: doc.getText(editor.selection),
        },
    visibleLines: visible
      ? { first: visible.start.line + 1, last: visible.end.line + 1 }
      : null,
    errors: vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 10)
      .map((d) => `${d.range.start.line + 1}: ${d.message}`),
  };
}

function clear(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(highlight, []);
    editor.setDecorations(dimRest, []);
  }
  statusItem.hide();
}

function dimAround(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number,
  lastLine: number
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  if (startLine > 0) {
    ranges.push(new vscode.Range(0, 0, startLine - 1, 0));
  }
  if (endLine < lastLine) {
    ranges.push(
      new vscode.Range(
        endLine + 1,
        0,
        lastLine,
        doc.lineAt(lastLine).text.length
      )
    );
  }
  return ranges;
}

function resolveFile(file: string): vscode.Uri {
  if (path.isAbsolute(file)) {
    return vscode.Uri.file(file);
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, file);
    if (fs.existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }
  const first = folders[0];
  if (first) {
    return vscode.Uri.file(path.join(first.uri.fsPath, file));
  }
  return vscode.Uri.file(file);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ------------------------------------------------- cue file (no-agent path)

interface Cue {
  action?: string;
  file?: string;
  start?: number;
  end?: number;
  note?: string;
  select?: boolean;
}

function watchCueFile(context: vscode.ExtensionContext): void {
  const cuePath = path.join(os.homedir(), ".claude", "tutor", "cue.json");
  fs.mkdirSync(path.dirname(cuePath), { recursive: true });

  let lastSeen = "";
  // Polling, not fs.watch: the cue is written atomically (write + rename),
  // which swaps the inode out from under a watcher.
  const timer = setInterval(() => {
    let raw: string;
    try {
      raw = fs.readFileSync(cuePath, "utf8");
    } catch {
      return;
    }
    if (raw === lastSeen) {
      return;
    }
    lastSeen = raw;

    let cue: Cue;
    try {
      cue = JSON.parse(raw) as Cue;
    } catch {
      return;
    }

    if (cue.action === "clear") {
      clear();
      return;
    }
    if (!cue.file || typeof cue.start !== "number") {
      return;
    }
    reveal({
      file: cue.file,
      startLine: cue.start,
      endLine: cue.end,
      note: cue.note,
      select: cue.select ?? false,
    }).catch((error: Error) => output.appendLine(`cue error: ${error.message}`));
  }, 150);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  speaker?.stop();
  server?.close();
}
