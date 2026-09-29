import { getBrowser } from "../lib/browser.js";
import { validateTargetUrl, isHostAllowed } from "../lib/url-guard.js";
import { prepareFullPage } from "../lib/fullpage.js";

/**
 * GET /api/screenshot?url=https://example.com
 *
 * Query params (all optional except url):
 *   width      viewport width in px        (320–3840, default 1280)
 *   height     viewport height in px       (240–2160, default 800)
 *   fullPage   capture the whole page      (true|false, default false)
 *   format     png | jpeg | webp           (default png)
 *   quality    1–100, jpeg/webp only       (default 80)
 *   delay      extra wait after load, ms   (0–10000, default 0)
 *   scale      device pixel ratio          (1–2, default 1)
 *   response   image | base64 | json       (default image)
 *   download   true → Content-Disposition: attachment
 */

const NAV_TIMEOUT_MS = 25_000;
const MAX_FULLPAGE_HEIGHT = 10_000; // keeps memory + response size sane
// Vercel functions cap response bodies at 4.5 MB; leave headroom.
const MAX_BINARY_BYTES = 4_200_000;
const MAX_BASE64_SOURCE_BYTES = 3_100_000; // base64 inflates ~33%

const clamp = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());

function parseOptions(q) {
  const format = ["png", "jpeg", "jpg", "webp"].includes(String(q.format).toLowerCase())
    ? String(q.format).toLowerCase().replace("jpg", "jpeg")
    : "png";
  const response = ["base64", "json"].includes(String(q.response).toLowerCase()) ? "base64" : "image";
  return {
    width: clamp(q.width, 320, 3840, 1280),
    height: clamp(q.height, 240, 2160, 800),
    fullPage: bool(q.fullPage ?? q.fullpage ?? q.full),
    format,
    quality: clamp(q.quality, 1, 100, 80),
    delay: clamp(q.delay, 0, 10_000, 0),
    scale: clamp(q.scale, 1, 2, 1),
    response,
    download: bool(q.download),
  };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Screenshot-Format, X-Screenshot-Truncated");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function capture(page, opts, format, quality, fullHeight) {
  const shot = { type: format, captureBeyondViewport: true };
  if (format !== "png") shot.quality = quality;

  let truncated = false;
  if (opts.fullPage && fullHeight > opts.height) {
    truncated = fullHeight > MAX_FULLPAGE_HEIGHT;
    shot.clip = { x: 0, y: 0, width: opts.width, height: Math.min(fullHeight, MAX_FULLPAGE_HEIGHT) };
  }
  const buffer = Buffer.from(await page.screenshot(shot));
  return { buffer, truncated };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Use GET." });
  }

  const query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  const opts = parseOptions(query);

  let target;
  try {
    target = await validateTargetUrl(query.url);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: opts.scale });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
    );

    // Re-check every host the page tries to reach, so redirects or embedded
    // resources can't be pointed at internal addresses.
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (request.isInterceptResolutionHandled()) return;
      try {
        const { protocol, hostname } = new URL(request.url());
        if (protocol === "data:" || protocol === "blob:") return request.continue();
        if (!["http:", "https:"].includes(protocol) || !(await isHostAllowed(hostname))) {
          return request.abort("blockedbyclient");
        }
        return request.continue();
      } catch {
        return request.abort("failed").catch(() => {});
      }
    });

    try {
      await page.goto(target.href, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      // Pages with endless polling/analytics never go idle. If something rendered, capture anyway.
      if (err?.name !== "TimeoutError") throw err;
    }
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));

    // Measure the real content height (handles inner scroll boxes, iframes and lazy images).
    const fullHeight = opts.fullPage ? await prepareFullPage(page, MAX_FULLPAGE_HEIGHT) : 0;

    // Capture, stepping down to JPEG if the result would exceed Vercel's response limit.
    const limit = opts.response === "base64" ? MAX_BASE64_SOURCE_BYTES : MAX_BINARY_BYTES;
    let format = opts.format;
    let quality = opts.quality;
    let { buffer, truncated } = await capture(page, opts, format, quality, fullHeight);
    for (const q of [75, 55, 35]) {
      if (buffer.length <= limit) break;
      format = "jpeg";
      quality = Math.min(quality, q);
      ({ buffer, truncated } = await capture(page, opts, format, quality, fullHeight));
    }
    if (buffer.length > limit) {
      throw Object.assign(
        new Error("The screenshot is too large to return. Try turning off full page or lowering the width."),
        { status: 413 }
      );
    }

    const ext = format === "jpeg" ? "jpg" : format;
    const mime = `image/${format}`;
    const filename = `screenshot-${target.hostname.replace(/[^a-z0-9.-]/gi, "")}-${Date.now()}.${ext}`;

    res.setHeader("X-Screenshot-Format", format);
    res.setHeader("X-Screenshot-Truncated", String(truncated));
    // Let Vercel's CDN cache identical requests for an hour — saves invocations on the free tier.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");

    if (opts.response === "base64") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(
        JSON.stringify({
          url: target.href,
          format,
          truncated,
          bytes: buffer.length,
          filename,
          dataUri: `data:${mime};base64,${buffer.toString("base64")}`,
        })
      );
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${opts.download ? "attachment" : "inline"}; filename="${filename}"`
    );
    return res.end(buffer);
  } catch (err) {
    console.error("[screenshot]", target?.href, err);
    const message =
      err.status
        ? err.message
        : /ERR_NAME_NOT_RESOLVED/.test(err.message)
          ? "That domain couldn't be found. Check the spelling."
          : /ERR_SSL|ERR_CERT/.test(err.message)
            ? "The site's secure connection failed. Try the http:// version of the address."
          : /ERR_CONNECTION|ERR_ADDRESS|ERR_TIMED_OUT/.test(err.message)
            ? "The site didn't respond. It may be down or blocking automated visits."
            : "The page couldn't be captured. Try again, or add a delay for slow-loading sites.";
    return sendJson(res, err.status || 500, { error: message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
