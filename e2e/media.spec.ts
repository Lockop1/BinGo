import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";

/**
 * Media pipeline + recap, against the dev-only lab page (/dev/media-lab).
 * There is no hosted Storage here, so image/video processing runs for real in
 * Chromium while uploads go to an in-page fake backend, and the recap's
 * "signed URLs" are data: URLs drawn on canvases.
 */

type LabResult = Record<string, unknown>;
type LabWindow = { __mediaLab?: { run(file: File, opts?: { fakeDurationSec?: number }): Promise<LabResult> } };

const GAME_ID = "00000000-0000-4000-8000-00000000fa6e";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

async function openLab(page: Page) {
  await page.goto("/dev/media-lab");
  await page.waitForFunction(() => Boolean((window as unknown as LabWindow).__mediaLab));
}

async function expectNoHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `scrollWidth on ${page.url()}`).toBeLessThanOrEqual(375);
}

test.describe("prepareMedia in the browser", () => {
  test("a 4000×3000 PNG becomes a JPEG with a 1600 px long edge", async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 4000;
      canvas.height = 3000;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 4000, 3000);
      g.addColorStop(0, "#a8141b");
      g.addColorStop(1, "#2e7d32");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4000, 3000);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const file = new File([blob], "huge.png", { type: "image/png" });
      return (window as unknown as LabWindow).__mediaLab!.run(file);
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "photo",
      ext: "jpg",
      contentType: "image/jpeg",
      blobType: "image/jpeg",
      width: 1600,
      height: 1200,
      decodedWidth: 1600,
      decodedHeight: 1200,
      passthrough: false,
    });
    await expect(page.getByTestId("lab-result")).toContainText('"ext": "jpg"');
  });

  test("EXIF orientation is honoured (orientation 6 turns 400×200 upright)", async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 200;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#1d4ed8";
      ctx.fillRect(0, 0, 400, 200);
      const jpeg = new Uint8Array(await (await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg"))).arrayBuffer());
      // Minimal APP1 Exif segment: big-endian TIFF, one IFD entry Orientation (0x0112) = 6.
      const app1 = [
        0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
        0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];
      const bytes = new Uint8Array(jpeg.length + app1.length);
      bytes.set(jpeg.subarray(0, 2), 0);
      bytes.set(app1, 2);
      bytes.set(jpeg.subarray(2), 2 + app1.length);
      const file = new File([bytes], "rotated.jpg", { type: "image/jpeg" });
      return (window as unknown as LabWindow).__mediaLab!.run(file);
    });
    expect(result).toMatchObject({ ok: true, ext: "jpg", width: 200, height: 400, decodedWidth: 200, decodedHeight: 400 });
  });

  test("a 1-second MediaRecorder webm passes the video check", async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const ctx = canvas.getContext("2d")!;
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((r) => (recorder.onstop = r));
      let n = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = `hsl(${(n += 20) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 160, 120);
      }, 33);
      recorder.start(100);
      await new Promise((r) => setTimeout(r, 1000));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      const file = new File(chunks, "clip.webm", { type: recorder.mimeType });
      return (window as unknown as LabWindow).__mediaLab!.run(file);
    });
    expect(result).toMatchObject({ ok: true, kind: "video", ext: "webm", contentType: "video/webm", passthrough: true });
    expect(result.durationSec as number).toBeGreaterThan(0.5);
    expect(result.durationSec as number).toBeLessThan(3);
  });

  test("a 20-second video is rejected with friendly copy", async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const file = new File([new Uint8Array(2048)], "long.mp4", { type: "video/mp4" });
      return (window as unknown as LabWindow).__mediaLab!.run(file, { fakeDurationSec: 20 });
    });
    expect(result).toEqual({ ok: false, code: "video_too_long", message: "Videos need to be 15 seconds or shorter." });
  });

  test("an unsupported file type is rejected", async ({ page }) => {
    await openLab(page);
    await page.getByTestId("lab-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    const out = page.getByTestId("lab-result");
    await expect(out).toHaveAttribute("data-ready", "true");
    await expect(out).toContainText('"code": "unsupported_type"');
    await expect(out).toContainText("That file type isn't supported. Try a photo or a video.");
  });
});

test("square media row: background upload, retry after a failure, share to group chat", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true });
  });
  const page = await context.newPage();
  await openLab(page);

  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#c2185b";
    ctx.fillRect(0, 0, 64, 48);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const photo = { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") };

  const row = page.getByTestId("lab-actions-done");
  await expect(row.getByTestId("add-media")).toBeVisible();
  const box = await row.getByTestId("add-media").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const input = row.getByTestId("add-media-input");
  await expect(input).toHaveAttribute("capture", "environment");
  await expect(input).toHaveAttribute("accept", "image/*,video/*");
  await expect(page.getByTestId("lab-actions-open").getByTestId("media-hint")).toHaveText(
    "Complete it to add a photo or video.",
  );

  // Happy path: inline status, path + upsert:false recorded by the fake Storage.
  await input.setInputFiles(photo);
  await expect(row.getByTestId("media-status").first()).toHaveText(/Photo uploading…|Photo added/);
  await expect(row.getByTestId("media-status").first()).toHaveText("Photo added");
  const upload = page.getByTestId("lab-upload").first();
  expect(await upload.getAttribute("data-path")).toMatch(new RegExp(`^${GAME_ID}/7/${UUID}\\.jpg$`));
  expect(JSON.parse((await upload.getAttribute("data-options"))!)).toEqual({
    contentType: "image/jpeg",
    upsert: false,
    cacheControl: "3600",
  });

  // Offline: three automatic tries, then a tap-to-retry line; back online, retry works.
  await page.getByTestId("lab-offline").click();
  await input.setInputFiles(photo);
  await expect(row.getByTestId("media-retry")).toHaveText("Upload failed — tap to retry", { timeout: 10_000 });
  await page.getByTestId("lab-offline").click();
  await row.getByTestId("media-retry").click();
  await expect(row.locator('[data-testid="media-status"][data-state="done"]')).toHaveCount(2);
  await expect(page.getByTestId("lab-upload")).toHaveCount(2);

  // Rejections show inline, without blocking anything.
  await row.getByTestId("add-media-library-input").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(row.getByTestId("media-rejection")).toContainText("That file type isn't supported");

  // Share: no share sheet in this context, so the invite link is copied.
  await row.getByTestId("share-group").click();
  await expect(row.getByTestId("share-feedback")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/g\/LABC2345$/);
  await expectNoHorizontalScroll(page);
  await context.close();
});

const STORY = [
  { position: 2, label: "Skyline Chili", completer: "Priya", color: "4", kind: "photo", uploader: "Jake" },
  { position: 2, label: "Skyline Chili", completer: "Priya", color: "4", kind: "photo", uploader: null },
  { position: 7, label: "Karaoke duet", completer: "Jake", color: "0", kind: "video", uploader: null },
  { position: 7, label: "Karaoke duet", completer: "Jake", color: "0", kind: "photo", uploader: "Priya" },
  { position: 18, label: "Sunrise photo", completer: "Sam", color: "6", kind: "photo", uploader: null },
];

test("recap: summary, story in board order, navigation, Save and Download all", async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true });
  });
  const page = await context.newPage();
  await openLab(page);
  await expect(page.getByTestId("lab-recap")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("lab-recap")).toHaveAttribute("data-video", "true");

  // Summary.
  const summary = page.getByTestId("recap-summary");
  await expect(summary).toContainText("Night recap");
  await expect(page.getByTestId("recap-count")).toHaveAttribute("data-count", "10");
  await expect(page.getByTestId("recap-count")).toContainText("/25");
  await expect(page.getByTestId("recap-lines")).toHaveText("2 bingo lines");
  await expect(summary).toContainText("Row 1, Column 3");
  const players = page.getByTestId("recap-player");
  await expect(players).toHaveCount(4);
  await expect(players.nth(0)).toContainText("Jake");
  await expect(players.nth(0)).toContainText("3 squares");
  await expect(players.nth(3)).toContainText("Lee");
  await expect(players.nth(3)).toContainText("0 squares");
  await expect(players.nth(1).getByTestId("color-chip")).toHaveAttribute("data-color", "4");
  await expect(page.getByTestId("recap-expiry")).toContainText(/available until/i);
  await expect(page.getByTestId("recap-expiry")).toContainText("November 16");
  await expect(summary).toContainText("Save before it's gone.");
  await expect(page.getByTestId("recap-download-note")).toContainText("iPhone");
  await expectNoHorizontalScroll(page);

  // Download all → a zip with every item, named in board order.
  const zipDownload = page.waitForEvent("download");
  await page.getByTestId("recap-download-all").click();
  const zipFile = await zipDownload;
  expect(zipFile.suggestedFilename()).toBe("lab-night-out-recap.zip");
  const zip = await JSZip.loadAsync(await readFile((await zipFile.path())!));
  expect(Object.keys(zip.files).sort()).toEqual([
    "03-skyline-chili-jake.jpg",
    "03-skyline-chili-priya-2.jpg",
    "08-karaoke-duet-jake.webm",
    "08-karaoke-duet-priya-2.jpg",
    "19-sunrise-photo-sam.jpg",
  ]);
  await expect(page.getByTestId("recap-download-status")).toHaveText("Downloaded.");

  // Story viewer.
  await page.getByTestId("recap-watch").click();
  const story = page.getByTestId("recap-story");
  await expect(story).toBeVisible();
  await expect(page.getByTestId("story-close")).toBeFocused();
  await expect(page.getByTestId("story-segment")).toHaveCount(STORY.length);
  await expectNoHorizontalScroll(page);

  for (const [i, expected] of STORY.entries()) {
    await expect(story).toHaveAttribute("data-index", String(i));
    await expect(story).toHaveAttribute("data-position", String(expected.position));
    await expect(story).toHaveAttribute("data-kind", expected.kind);
    await expect(page.getByTestId("story-label")).toHaveText(expected.label);
    await expect(page.getByTestId("story-completer")).toHaveText(expected.completer);
    await expect(page.getByTestId("story-player").getByTestId("color-chip")).toHaveAttribute("data-color", expected.color);
    if (expected.uploader) await expect(page.getByTestId("story-uploader")).toContainText(`by ${expected.uploader}`);
    else await expect(page.getByTestId("story-uploader")).toHaveCount(0);
    await expect(page.getByTestId("story-save")).toBeEnabled();
    if (expected.kind === "video") {
      const video = story.getByTestId("story-video").last();
      await expect(video).toBeVisible();
      expect(await video.evaluate((v: HTMLVideoElement) => [v.muted, v.loop, v.playsInline, v.autoplay])).toEqual([true, true, true, true]);
      const unmute = page.getByTestId("story-unmute");
      await expect(unmute).toHaveAttribute("aria-pressed", "false");
      await unmute.click();
      await expect(unmute).toHaveAttribute("aria-pressed", "true");
      expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    } else {
      await expect(story.getByTestId("story-photo").last()).toHaveCSS("object-fit", "contain");
    }
    if (i < STORY.length - 1) await page.getByTestId("story-next").click();
  }

  // Back with the left zone, keyboard, and a swipe.
  await page.getByTestId("story-prev").click();
  await expect(story).toHaveAttribute("data-index", "3");
  await page.keyboard.press("ArrowLeft");
  await expect(story).toHaveAttribute("data-index", "2");
  const stage = await page.getByTestId("story-next").boundingBox();
  await page.mouse.move(stage!.x + stage!.width / 2, stage!.y + stage!.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage!.x + 20, stage!.y + stage!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(story).toHaveAttribute("data-index", "3");

  // Photos advance on their own after 5 s.
  await expect(story).toHaveAttribute("data-index", "4", { timeout: 8_000 });

  // Per-item Save (no share sheet here → a download of the fetched blob).
  const itemDownload = page.waitForEvent("download");
  await page.getByTestId("story-save").click();
  expect((await itemDownload).suggestedFilename()).toBe("19-sunrise-photo-sam.jpg");
  await expect(page.getByTestId("story-save")).toHaveText("Saved");

  // Next on the last item, or Escape / close, returns to the summary.
  await page.getByTestId("story-close").click();
  await expect(story).toBeHidden();
  await expect(page.getByTestId("recap-watch")).toBeFocused();
  await context.close();
});

test("recap: reduced motion crossfades, and a game without media lists completed squares", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLab(page);
  await expect(page.getByTestId("lab-recap")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("recap-watch").click();
  const story = page.getByTestId("recap-story");
  await page.getByTestId("story-next").click();
  await expect(story).toHaveAttribute("data-index", "1");
  await page.keyboard.press("Escape");
  await expect(story).toBeHidden();

  await page.getByTestId("lab-recap-empty").click();
  await expect(page.getByTestId("recap-no-media")).toContainText("No photos or videos this time.");
  await expect(page.getByTestId("recap-watch")).toHaveCount(0);
  await expect(page.getByTestId("recap-download-all")).toHaveCount(0);
  const rows = page.getByTestId("recap-square-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.nth(0)).toContainText("High-five a stranger");
  await expect(rows.nth(0)).toContainText("Jake");
  await expect(rows.filter({ hasText: "Free space" })).toContainText("on the house");
  await expect(page.getByTestId("recap-expiry")).toContainText(/available until/i);
  await expectNoHorizontalScroll(page);
});
