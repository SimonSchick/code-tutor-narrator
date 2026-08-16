// Tests for the speech backends. The ElevenLabs path runs against a local stub
// server, so the request shape and caching are verified without a real API key
// and without spending any characters.
//   node test/test-tts.js

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { synthesize, createSpeaker, playbackArgs } = require(path.join(__dirname, "..", "out", "tts.js"));

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// A stub standing in for api.elevenlabs.io.
const requests = [];
const FAKE_MP3 = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00fake-audio");
let respondWith = { status: 200, body: FAKE_MP3 };

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(respondWith.status, { "Content-Type": "audio/mpeg" });
    res.end(respondWith.body);
  });
});

// Note the ordering: `elevenlabs` is merged *after* the top-level spread, so a
// caller overriding one nested field doesn't drop the rest of the block.
function config(overrides = {}) {
  const { elevenlabs: elevenlabsOverrides, ...rest } = overrides;
  return {
    provider: "elevenlabs",
    voice: "VOICE123",
    rate: 175,
    command: undefined,
    cacheDir,
    ...rest,
    elevenlabs: {
      apiKey: "test-key",
      modelId: "eleven_flash_v2_5",
      baseUrl: `http://127.0.0.1:${stub.address().port}`,
      stability: 0.5,
      similarityBoost: 0.75,
      speed: 1,
      ...(elevenlabsOverrides || {}),
    },
  };
}

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-cache-"));

(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));

  // --- request shape -------------------------------------------------------
  const file = await synthesize("Ownership means one owner.", config());
  const req = requests[0];

  check("POSTs to /v1/text-to-speech/{voice_id}",
    req.method === "POST" && req.url.startsWith("/v1/text-to-speech/VOICE123"), req.url);
  check("sets output_format query param",
    /output_format=mp3_44100_128/.test(req.url), req.url);
  check("sends xi-api-key header (not Authorization)",
    req.headers["xi-api-key"] === "test-key" && !req.headers.authorization,
    JSON.stringify(req.headers["xi-api-key"]));
  check("sends JSON content-type",
    (req.headers["content-type"] || "").includes("application/json"), req.headers["content-type"]);

  const sent = JSON.parse(req.body);
  check("body carries text and model_id",
    sent.text === "Ownership means one owner." && sent.model_id === "eleven_flash_v2_5",
    req.body);
  check("body carries voice_settings",
    sent.voice_settings.stability === 0.5 &&
    sent.voice_settings.similarity_boost === 0.75 &&
    sent.voice_settings.speed === 1,
    JSON.stringify(sent.voice_settings));

  check("writes the audio bytes to disk",
    fs.readFileSync(file).equals(FAKE_MP3), `got ${fs.statSync(file).size} bytes`);
  check("caches into the configured directory",
    path.dirname(file) === cacheDir, file);

  // --- caching -------------------------------------------------------------
  const again = await synthesize("Ownership means one owner.", config());
  check("identical text is served from cache (no second request)",
    requests.length === 1 && again === file, `${requests.length} requests`);

  await synthesize("A different sentence.", config());
  check("different text does hit the API", requests.length === 2, `${requests.length} requests`);

  await synthesize("Ownership means one owner.", config({ elevenlabs: { modelId: "eleven_multilingual_v2" } }));
  check("changing the model busts the cache", requests.length === 3, `${requests.length} requests`);

  // --- prefetch ------------------------------------------------------------
  async function settle(done, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !done()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const before = requests.length;
  const cachedBefore = fs.readdirSync(cacheDir).length;
  const warmer = createSpeaker(() => config());
  warmer.prefetch("warmed ahead of time");
  // The next beat calls stop() before it speaks. That must not cancel a
  // warm-up already in flight, or prefetching would be worse than useless.
  warmer.stop();
  await settle(() => fs.readdirSync(cacheDir).length > cachedBefore);
  check("prefetch synthesises in the background",
    requests.length === before + 1, `${requests.length - before} requests`);

  const warmed = await synthesize("warmed ahead of time", config());
  check("prefetch survives stop() and serves the cache",
    requests.length === before + 1 && fs.existsSync(warmed),
    `${requests.length - before} requests`);

  const sayer = createSpeaker(() => ({ ...config(), provider: "say" }));
  sayer.prefetch("nothing to synthesise here");
  await settle(() => false, 50);
  check("prefetch is a no-op for non-elevenlabs providers",
    requests.length === before + 1, `${requests.length - before} requests`);

  // --- playback rate -------------------------------------------------------
  check("playbackRate of 1 adds no flags",
    JSON.stringify(playbackArgs("/tmp/a.mp3", 1)) === '["/tmp/a.mp3"]',
    JSON.stringify(playbackArgs("/tmp/a.mp3", 1)));
  check("playbackRate asks for the pitch-preserving algorithm",
    JSON.stringify(playbackArgs("/tmp/a.mp3", 1.6)) === '["-r","1.6","-q","1","/tmp/a.mp3"]',
    JSON.stringify(playbackArgs("/tmp/a.mp3", 1.6)));
  check("an unset or nonsense playbackRate is ignored",
    JSON.stringify(playbackArgs("/tmp/a.mp3", undefined)) === '["/tmp/a.mp3"]' &&
    JSON.stringify(playbackArgs("/tmp/a.mp3", 0)) === '["/tmp/a.mp3"]',
    "did not fall back to plain playback");

  // --- failure modes -------------------------------------------------------
  try {
    await synthesize("hi", config({ elevenlabs: { apiKey: undefined } }));
    check("missing API key raises a clear error", false, "no error thrown");
  } catch (err) {
    check("missing API key raises a clear error",
      /API key/i.test(err.message) && /Set ElevenLabs API Key/i.test(err.message), err.message);
  }

  respondWith = { status: 401, body: Buffer.from('{"detail":"invalid api key"}') };
  try {
    await synthesize("unauthorised please", config());
    check("HTTP error surfaces status and body", false, "no error thrown");
  } catch (err) {
    check("HTTP error surfaces status and body",
      /401/.test(err.message) && /invalid api key/.test(err.message), err.message);
  }

  // --- command provider ----------------------------------------------------
  respondWith = { status: 200, body: FAKE_MP3 };
  const marker = path.join(cacheDir, "spoken.txt");
  const speaker = createSpeaker(() => ({
    ...config(),
    provider: "command",
    command: `cat > ${JSON.stringify(marker)}`,
  }));
  const result = await speaker.speak("piped to a local program", true);
  check("command provider pipes text to stdin and waits",
    result === "done" && fs.readFileSync(marker, "utf8") === "piped to a local program",
    `${result} / ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "(no file)"}`);

  const noCommand = createSpeaker(() => ({ ...config(), provider: "command", command: undefined }));
  try {
    await noCommand.speak("x", true);
    check("command provider without a command errors clearly", false, "no error");
  } catch (err) {
    check("command provider without a command errors clearly",
      /codeTutor\.tts\.command/.test(err.message), err.message);
  }

  check("stop() is a no-op when idle", speaker.stop() === false, "returned true");

  stub.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
