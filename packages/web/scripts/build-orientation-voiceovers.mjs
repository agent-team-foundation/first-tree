import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VOICEOVER_OUTPUT = join(WEB_ROOT, "orientation-videos", "voiceover");
const CAPTIONS_OUTPUT = join(WEB_ROOT, "public", "onboarding", "orientation");
const PIPER_MODEL = process.env.ORIENTATION_PIPER_MODEL;

if (!PIPER_MODEL) {
  throw new Error("Set ORIENTATION_PIPER_MODEL to an approved Piper ONNX voice model");
}

const CHAPTERS = {
  "multi-agent": {
    duration: 35,
    cues: [
      [0.5, 5.5, "Give one lead Agent a clear software task."],
      [5.5, 12, "As work unfolds, the lead brings each specialist into the same Chat."],
      [
        12,
        21,
        "A user experience specialist clarifies the interaction. A developer implements it, with progress visible in the conversation.",
      ],
      [21, 29, "Quality assurance verifies the result without opening another Chat."],
      [29, 35, "One shared conversation reaches a reviewed pull request."],
    ],
  },
  "context-tree": {
    duration: 59,
    cues: [
      [0.5, 8.5, "Context Tree carries durable team knowledge from one task into the next."],
      [8.5, 18.5, "Before work begins, an Agent reads only the relevant, authorized paths."],
      [18.5, 30.5, "Settled constraints guide design, code, and tests without replacing verification."],
      [
        30.5,
        45.5,
        "Temporary implementation detail stays with the code. Lasting decisions become source-backed proposals for a dedicated Context Reviewer.",
      ],
      [45.5, 55.5, "Once approved, the shared snapshot helps every future Agent start smarter."],
    ],
  },
  github: {
    duration: 31,
    cues: [
      [0.2, 3.2, "Connect one GitHub repository to First Tree."],
      [3.2, 9.2, "Assigning an Issue creates or reuses its Source Chat, then wakes the teammate's Delegate Agent."],
      [9.2, 15.2, "The Issue context travels with the work, without rebuilding the task."],
      [15.2, 22.2, "A linked pull request stays attached to the same Issue Chat."],
      [
        22.2,
        30.5,
        "Review feedback, updates, approval, and merge events return automatically, preserving the work's history.",
      ],
    ],
  },
};

function run(command, args, { input, label = command } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${label} exited with code ${code}\n${stderr}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function mediaDuration(path) {
  const child = spawn(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`ffprobe exited with code ${code}\n${stderr}`));
    });
  });
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error(`Invalid audio duration for ${path}: ${stdout.trim()}`);
  return duration;
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const minutes = Math.floor(milliseconds / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainingMilliseconds = milliseconds % 1000;
  return `00:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}.${String(remainingMilliseconds).padStart(3, "0")}`;
}

function vttFor(cues) {
  const blocks = cues.map(([start, end, text]) => `${timestamp(start)} --> ${timestamp(end)}\n${text}`);
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

async function renderChapter(id, chapter, temporaryDirectory) {
  const segments = [];
  for (const [index, [start, end, text]] of chapter.cues.entries()) {
    const segmentPath = join(temporaryDirectory, `${id}-${index}.wav`);
    await run(
      "uv",
      [
        "tool",
        "run",
        "--python",
        "3.12",
        "--from",
        "piper-tts",
        "piper",
        "--model",
        PIPER_MODEL,
        "--output-file",
        segmentPath,
        "--length-scale",
        "0.92",
        "--sentence-silence",
        "0.12",
      ],
      { input: `${text}\n`, label: `Piper (${id} cue ${index + 1})` },
    );
    const duration = await mediaDuration(segmentPath);
    const available = end - start;
    if (duration > available) {
      throw new Error(
        `${id} cue ${index + 1} is ${duration.toFixed(2)}s but only ${available.toFixed(2)}s is available`,
      );
    }
    segments.push({ path: segmentPath, start });
  }

  const inputs = segments.flatMap(({ path }) => ["-i", path]);
  const delayed = segments.map(
    ({ start }, index) => `[${index}:a]adelay=${Math.round(start * 1000)}:all=1[voice${index}]`,
  );
  const voices = segments.map((_, index) => `[voice${index}]`).join("");
  const filter = [
    ...delayed,
    `${voices}amix=inputs=${segments.length}:normalize=0,apad=whole_dur=${chapter.duration},atrim=duration=${chapter.duration},loudnorm=I=-16:LRA=7:TP=-1.5[aout]`,
  ].join(";");
  const outputPath = join(VOICEOVER_OUTPUT, `${id}.m4a`);
  await run(
    "ffmpeg",
    [
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "48000",
      "-ac",
      "1",
      outputPath,
    ],
    { label: `ffmpeg (${id})` },
  );
  await writeFile(join(CAPTIONS_OUTPUT, `${id}.vtt`), vttFor(chapter.cues));
  process.stdout.write(`${id}: ${chapter.duration}s voiceover and captions written\n`);
}

async function main() {
  await mkdir(VOICEOVER_OUTPUT, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "first-tree-orientation-voiceover-"));
  try {
    for (const [id, chapter] of Object.entries(CHAPTERS)) {
      await renderChapter(id, chapter, temporaryDirectory);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
