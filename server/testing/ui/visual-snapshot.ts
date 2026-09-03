import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";

// Browser-side Canvas decoding keeps this narrow visual gate independent of a
// second test runner or image package. Keep serialized callbacks self-contained:
// tsx's helper symbols do not exist inside Playwright's browser evaluation.
const SNAPSHOT_DIR = fileURLToPath(new URL("./snapshots/", import.meta.url));
const UPDATE_SNAPSHOTS = process.env.MIRAFOLD_UPDATE_UI_SNAPSHOTS === "1";
const ARTIFACT_DIR = path.resolve(
  process.env.MIRAFOLD_UI_ARTIFACT_DIR ?? path.join(os.tmpdir(), "mirafold-ui-visual"),
);

// Small rendering noise is ignored per channel; a changed border, word, gap,
// or control still exceeds this deliberately tight total-pixel allowance.
const CHANNEL_THRESHOLD = 12;
const MAX_DIFF_RATIO = 0.0005;
const SCREENSHOT_OPTIONS = {
  animations: "disabled" as const,
  caret: "hide" as const,
  scale: "css" as const,
  style: `
    *, *::before, *::after {
      animation-delay: 0s !important;
      animation-duration: 0s !important;
      caret-color: transparent !important;
      transition-delay: 0s !important;
      transition-duration: 0s !important;
    }
    body, button, input, textarea { font-family: "Liberation Sans", sans-serif !important; }
    .agent-picker-card, .agent-picker-card *, .settings-card, .settings-card *,
    .status-bar, .status-bar *, .prompt-box, .prompt-box *, .rc, .rc * {
      font-family: "Liberation Mono", monospace !important;
    }
    .agent-picker-title, .agent-picker-sub { font-family: "Liberation Sans", sans-serif !important; }
  `,
};

type PixelComparison = {
  expectedWidth: number;
  expectedHeight: number;
  actualWidth: number;
  actualHeight: number;
  differingPixels: number;
  totalPixels: number;
  largestChannelDelta: number;
  diffPng?: string;
};

async function comparePngs(
  browser: Browser,
  expected: Buffer,
  actual: Buffer,
): Promise<PixelComparison> {
  const decoder = await browser.newPage();
  try {
    return await decoder.evaluate(
      async ({ expectedBase64, actualBase64, channelThreshold, maxDiffRatio }) => {
        const expectedImage = new Image();
        const actualImage = new Image();
        const loaded = Promise.all([
          new Promise<void>((resolve, reject) => {
            expectedImage.onload = () => resolve();
            expectedImage.onerror = () => reject(new Error("could not decode expected PNG"));
          }),
          new Promise<void>((resolve, reject) => {
            actualImage.onload = () => resolve();
            actualImage.onerror = () => reject(new Error("could not decode actual PNG"));
          }),
        ]);
        expectedImage.src = `data:image/png;base64,${expectedBase64}`;
        actualImage.src = `data:image/png;base64,${actualBase64}`;
        await loaded;
        const dimensions = {
          expectedWidth: expectedImage.naturalWidth,
          expectedHeight: expectedImage.naturalHeight,
          actualWidth: actualImage.naturalWidth,
          actualHeight: actualImage.naturalHeight,
        };
        if (
          dimensions.expectedWidth !== dimensions.actualWidth ||
          dimensions.expectedHeight !== dimensions.actualHeight
        ) {
          return {
            ...dimensions,
            differingPixels: Number.POSITIVE_INFINITY,
            totalPixels: dimensions.expectedWidth * dimensions.expectedHeight,
            largestChannelDelta: 255,
          };
        }

        const width = dimensions.expectedWidth;
        const height = dimensions.expectedHeight;
        const expectedCanvas = document.createElement("canvas");
        const actualCanvas = document.createElement("canvas");
        const diffCanvas = document.createElement("canvas");
        for (const canvas of [expectedCanvas, actualCanvas, diffCanvas]) {
          canvas.width = width;
          canvas.height = height;
        }
        const expectedContext = expectedCanvas.getContext("2d", { willReadFrequently: true })!;
        const actualContext = actualCanvas.getContext("2d", { willReadFrequently: true })!;
        const diffContext = diffCanvas.getContext("2d")!;
        expectedContext.drawImage(expectedImage, 0, 0);
        actualContext.drawImage(actualImage, 0, 0);
        const expectedPixels = expectedContext.getImageData(0, 0, width, height).data;
        const actualPixels = actualContext.getImageData(0, 0, width, height).data;
        const diff = diffContext.createImageData(width, height);

        let differingPixels = 0;
        let largestChannelDelta = 0;
        for (let offset = 0; offset < expectedPixels.length; offset += 4) {
          let pixelDelta = 0;
          for (let channel = 0; channel < 4; channel += 1) {
            pixelDelta = Math.max(
              pixelDelta,
              Math.abs(expectedPixels[offset + channel] - actualPixels[offset + channel]),
            );
          }
          largestChannelDelta = Math.max(largestChannelDelta, pixelDelta);
          if (pixelDelta > channelThreshold) {
            differingPixels += 1;
            diff.data.set([226, 40, 124, 255], offset);
          } else {
            const gray = Math.round(
              (expectedPixels[offset] + expectedPixels[offset + 1] + expectedPixels[offset + 2]) /
                3,
            );
            diff.data.set([gray, gray, gray, 96], offset);
          }
        }
        diffContext.putImageData(diff, 0, 0);
        return {
          ...dimensions,
          differingPixels,
          totalPixels: width * height,
          largestChannelDelta,
          ...(differingPixels > Math.floor(width * height * maxDiffRatio)
            ? { diffPng: diffCanvas.toDataURL("image/png").split(",", 2)[1] }
            : {}),
        };
      },
      {
        expectedBase64: expected.toString("base64"),
        actualBase64: actual.toString("base64"),
        channelThreshold: CHANNEL_THRESHOLD,
        maxDiffRatio: MAX_DIFF_RATIO,
      },
    );
  } finally {
    await decoder.close();
  }
}

async function writeFailureArtifacts(
  name: string,
  actual: Buffer,
  comparison: PixelComparison,
): Promise<string> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, `${name}.actual.png`), actual);
  if (comparison.diffPng) {
    await writeFile(
      path.join(ARTIFACT_DIR, `${name}.diff.png`),
      Buffer.from(comparison.diffPng, "base64"),
    );
  }
  return ARTIFACT_DIR;
}

export async function assertVisualSnapshot(
  browser: Browser,
  page: Page,
  name: string,
  selector?: string,
): Promise<void> {
  assert.match(name, /^[a-z0-9-]+$/, "snapshot names must be safe lowercase file stems");
  const baseline = path.join(SNAPSHOT_DIR, `${name}.ubuntu-24.04-chromium.png`);
  await page.evaluate(() => document.fonts.ready);
  const actual = selector
    ? await page.locator(selector).screenshot(SCREENSHOT_OPTIONS)
    : await page.screenshot(SCREENSHOT_OPTIONS);

  if (UPDATE_SNAPSHOTS) {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(baseline, actual);
    return;
  }

  let expected: Buffer;
  try {
    expected = await readFile(baseline);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      assert.fail(
        `missing visual baseline ${baseline}; run yarn test:ui:update-snapshots on Ubuntu 24.04`,
      );
    }
    throw error;
  }

  const comparison = await comparePngs(browser, expected, actual);
  const allowedPixels = Math.floor(comparison.totalPixels * MAX_DIFF_RATIO);
  const dimensionsMatch =
    comparison.expectedWidth === comparison.actualWidth &&
    comparison.expectedHeight === comparison.actualHeight;
  if (dimensionsMatch && comparison.differingPixels <= allowedPixels) return;

  const artifacts = await writeFailureArtifacts(name, actual, comparison);
  assert.fail(
    dimensionsMatch
      ? `${name} differs in ${comparison.differingPixels}/${comparison.totalPixels} pixels ` +
          `(allowed ${allowedPixels}, largest channel delta ${comparison.largestChannelDelta}); ` +
          `actual/diff: ${artifacts}`
      : `${name} changed size from ${comparison.expectedWidth}x${comparison.expectedHeight} to ` +
          `${comparison.actualWidth}x${comparison.actualHeight}; actual: ${artifacts}`,
  );
}
