import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WIDTH = 1280;
const HEIGHT = 720;
const DEVICE_SCALE_FACTOR = 1.5;
const requestedPort = Number.parseInt(process.env.ORIENTATION_VIDEO_PORT ?? "4178", 10);
if (!Number.isFinite(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error(`Invalid ORIENTATION_VIDEO_PORT: ${process.env.ORIENTATION_VIDEO_PORT ?? "<missing>"}`);
}
const PORT = requestedPort;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WEB_ROOT, "../..");
const PUBLIC_OUTPUT = join(WEB_ROOT, "public", "onboarding", "orientation");
const REVIEW_OUTPUT = join(WEB_ROOT, "orientation-videos", "review");

const CHAPTERS = {
  "multi-agent": { keyframes: [0, 18, 32], poster: 18 },
};

function selectedChapters() {
  const chapterFlag = process.argv.indexOf("--chapter");
  if (chapterFlag < 0) return Object.entries(CHAPTERS);
  const requested = process.argv[chapterFlag + 1];
  if (!requested || !Object.hasOwn(CHAPTERS, requested)) {
    throw new Error(`Unknown chapter: ${requested ?? "<missing>"}`);
  }
  return [[requested, CHAPTERS[requested]]];
}

function run(command, args, options = {}) {
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

async function waitForServer(timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite has not bound the port yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("Timed out waiting for the Vite recording server");
}

function waitForExit(child, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${label} exited with code ${code}`));
    });
  });
}

async function writeToStream(stream, buffer) {
  if (stream.write(buffer)) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolvePromise();
    };
    const onError = (error) => {
      stream.off("drain", onDrain);
      rejectPromise(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function renderChapter(page, id, config) {
  const outputPath = join(PUBLIC_OUTPUT, `${id}.mp4`);
  await page.goto(`${BASE_URL}/preview/onboarding-orientation-video?chapter=${id}&frame=0`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => document.documentElement.dataset.orientationVideoReady === "true");
  await page.evaluate(() => document.fonts.ready);
  const previewMetadata = await page.evaluate(() => {
    const controller = window.orientationVideoController;
    return controller ? { fps: controller.fps, frameCount: controller.frameCount } : null;
  });
  if (!previewMetadata || !Number.isInteger(previewMetadata.frameCount) || previewMetadata.frameCount <= 0) {
    throw new Error(`Invalid frame count for ${id}: ${previewMetadata?.frameCount ?? "none"}`);
  }
  if (!Number.isInteger(previewMetadata.fps) || previewMetadata.fps <= 0) {
    throw new Error(`Invalid frame rate for ${id}: ${previewMetadata.fps ?? "none"}`);
  }
  const { fps, frameCount } = previewMetadata;

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-tune",
      "animation",
      "-crf",
      "18",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => {
    ffmpegError += chunk.toString();
  });
  let ffmpegInputError;
  ffmpeg.stdin.on("error", (error) => {
    ffmpegInputError ??= error;
  });
  const ffmpegExit = waitForExit(ffmpeg, `ffmpeg (${id})`).then(
    () => ({ error: null }),
    (error) => ({ error }),
  );

  const stillFrames = new Map(config.keyframes.map((seconds) => [Math.round(seconds * fps), seconds]));
  const posterFrame = Math.round(config.poster * fps);
  try {
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (ffmpegInputError) throw ffmpegInputError;
      await page.evaluate((nextFrame) => window.orientationVideoController?.setFrame(nextFrame), frame);
      const image = await page.screenshot({ type: "png", animations: "disabled" });
      await writeToStream(ffmpeg.stdin, image);

      const stillSecond = stillFrames.get(frame);
      if (stillSecond !== undefined) {
        const suffix = String(stillSecond).padStart(2, "0");
        await writeFile(join(REVIEW_OUTPUT, `${id}-${suffix}s.png`), image);
      }
      if (frame === posterFrame) {
        await writeFile(join(PUBLIC_OUTPUT, "stills", `${id}-poster.png`), image);
      }
      if (frame % fps === 0) process.stdout.write(`\r${id}: ${Math.round((frame / frameCount) * 100)}%`);
    }
  } catch (error) {
    ffmpeg.stdin.destroy();
    if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    const exitResult = await ffmpegExit;
    const failure = exitResult.error ?? ffmpegInputError ?? error;
    throw new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${ffmpegError}`);
  }
  ffmpeg.stdin.end();
  const exitResult = await ffmpegExit;
  if (exitResult.error) {
    throw new Error(
      `${exitResult.error instanceof Error ? exitResult.error.message : String(exitResult.error)}\n${ffmpegError}`,
    );
  }
  process.stdout.write(`\r${id}: 100%\n`);
}

async function main() {
  await mkdir(PUBLIC_OUTPUT, { recursive: true });
  await mkdir(join(PUBLIC_OUTPUT, "stills"), { recursive: true });
  await mkdir(REVIEW_OUTPUT, { recursive: true });

  const sharedBuild = spawn("pnpm", ["--filter", "@first-tree/shared", "build"], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
  });
  await waitForExit(sharedBuild, "@first-tree/shared build");

  const vite = run("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: WEB_ROOT,
  });
  let viteError = "";
  vite.stderr.on("data", (chunk) => {
    viteError += chunk.toString();
  });

  let browser;
  try {
    await waitForServer();
    const executablePath = process.env.ORIENTATION_VIDEO_BROWSER_EXECUTABLE;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    for (const [id, config] of selectedChapters()) await renderChapter(page, id, config);
    await context.close();
  } catch (error) {
    if (viteError) process.stderr.write(viteError);
    throw error;
  } finally {
    if (browser) await browser.close();
    vite.kill("SIGTERM");
  }
}

await main();
