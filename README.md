# URL Screenshot API

A lightweight webpage screenshot API and embeddable UI for Vercel's free (Hobby) tier, built on `puppeteer-core` + `@sparticuz/chromium`.

## Project structure

```
url-screenshot-api/
├── api/
│   └── screenshot.js      # Serverless function: GET /api/screenshot
├── lib/
│   ├── browser.js         # Chromium launcher (Vercel vs. local), warm-instance reuse
│   └── url-guard.js       # URL validation + SSRF protection
├── public/
│   └── index.html         # Embeddable UI (served at /)
├── scripts/
│   └── dev.mjs            # Local dev server, no Vercel login required
├── embed-snippet.html     # Copy-paste iframe code for GoHighLevel / OneCompiler
├── package.json
├── vercel.json            # Function timeout, Chromium file includes, iframe headers
└── .gitignore
```

## Versions (pinned on purpose)

`@sparticuz/chromium` must match the Chromium major version that `puppeteer-core` expects. These are pinned to a known-good pair:

| Package | Version | Chromium |
|---|---|---|
| `@sparticuz/chromium` | 153.0.0 | 153 |
| `puppeteer-core` | 25.11.0 | 153 |

When upgrading, bump both together (check https://pptr.dev/chromium-support). `@sparticuz/chromium` 153 requires Node 22.17+, which is why `engines.node` is `22.x`.

## API reference

`GET /api/screenshot?url=https://example.com`

| Param | Default | Notes |
|---|---|---|
| `url` | required | `https://` is added if missing |
| `width` | 1280 | 320–3840 |
| `height` | 800 | 240–2160 |
| `fullPage` | false | Whole page, capped at 10,000 px tall |
| `format` | png | `png`, `jpeg`, `webp` |
| `quality` | 80 | 1–100, jpeg/webp only |
| `delay` | 0 | Extra wait in ms after load (max 10000), useful for animations |
| `scale` | 1 | Device pixel ratio, 1 or 2 (retina) |
| `response` | image | `image` returns binary; `base64` returns JSON with a `dataUri` |
| `download` | false | `true` sends `Content-Disposition: attachment` |

Examples:

```
/api/screenshot?url=example.com
/api/screenshot?url=example.com&fullPage=true&format=jpeg
/api/screenshot?url=example.com&width=390&height=844&scale=2
/api/screenshot?url=example.com&response=base64
/api/screenshot?url=example.com&download=true
```

Because the endpoint returns a normal image, you can also use it directly in an `<img>` tag:

```html
<img src="https://YOUR-APP.vercel.app/api/screenshot?url=example.com" alt="Preview of example.com">
```

Response headers `X-Screenshot-Format` and `X-Screenshot-Truncated` tell you the final format (it may switch to JPEG to stay under Vercel's 4.5 MB response limit) and whether a full-page capture was cut at 10,000 px.

## 1. Test locally

Requirements: Node.js 22.17+ and Google Chrome installed.

```bash
cd url-screenshot-api
npm install
npm run dev
```

Open http://localhost:3000 for the UI, or test the API directly:

```bash
curl -o test.png "http://localhost:3000/api/screenshot?url=https://example.com"
```

Locally, the code uses your installed Chrome (the `@sparticuz/chromium` binary only runs on Linux serverless hosts). It checks the usual install paths on macOS, Windows and Linux. If Chrome lives somewhere else, point to it:

```bash
CHROME_PATH="/path/to/chrome" npm run dev          # macOS / Linux
set CHROME_PATH=C:\path\to\chrome.exe && npm run dev  # Windows cmd
```

Optional: `npm run dev:vercel` runs the real Vercel runtime locally (requires `npx vercel login` first).

## 2. Deploy to Vercel

Option A, via GitHub (recommended, auto-deploys on push):

1. Push this folder to a new GitHub repository.
2. In the Vercel dashboard, choose Add New → Project and import the repo.
3. Leave Framework Preset as "Other". No build command or environment variables are needed.
4. Click Deploy. Your UI is at `https://your-app.vercel.app/` and the API at `/api/screenshot`.

Option B, via the CLI:

```bash
npx vercel login
npx vercel          # preview deployment
npx vercel --prod   # production
```

After deploying, test it:

```bash
curl -o live.png "https://your-app.vercel.app/api/screenshot?url=https://example.com"
```

The first request after a quiet period is a cold start (Chromium decompresses, roughly 5–10 s). Warm requests reuse the running browser and typically return in 1–3 s.

## 3. Embed in GoHighLevel

1. Open your funnel or website page in the GHL builder.
2. Add an element: Custom JS/HTML (under "Custom Code" / "Code").
3. Paste the contents of `embed-snippet.html` and replace `YOUR-APP.vercel.app` with your domain.
4. Save and preview. The iframe resizes itself to fit the tool.

The UI accepts these URL parameters on the iframe `src`: `bg=transparent` to blend with your page, `theme=light` or `theme=dark` to force a theme, and `url=...&auto=1` to prefill and capture immediately.

## 4. Embed in OneCompiler

In OneCompiler's HTML editor, either paste the same iframe snippet, or copy `public/index.html` in and point it at your API:

- As an iframe: paste `embed-snippet.html` (simplest).
- As standalone HTML: paste `public/index.html` and load it with `?api=https://your-app.vercel.app`, or change the `API_BASE` line in the script to your domain. The API sends CORS headers, so cross-origin calls work.

## Iframe notes

`vercel.json` sets `Content-Security-Policy: frame-ancestors *`, so any site can embed the UI. To restrict embedding to your own sites, change the value, for example:

```
frame-ancestors 'self' https://*.leadconnectorhq.com https://*.gohighlevel.com https://yourdomain.com https://onecompiler.com
```

If you ever add a `sandbox` attribute to the iframe, include `allow-scripts allow-same-origin allow-downloads allow-popups` or the Download button won't work. The UI already falls back to opening the image in a new tab if a download is blocked.

## Free-tier limits and how this project handles them

| Limit (Hobby) | How it's handled |
|---|---|
| 250 MB unzipped function size | `@sparticuz/chromium` ships a Brotli-compressed Chromium (~65 MB); `puppeteer-core` doesn't download a browser |
| Function timeout | `maxDuration: 60`; navigation times out at 25 s and captures whatever rendered |
| 4.5 MB response body | Automatically steps down to JPEG at lower quality if the image is too large |
| Invocation/CPU quota | Identical requests are cached on Vercel's CDN for 1 hour (`s-maxage=3600`) |
| Cold starts | Browser instance is reused across warm invocations; GPU/graphics mode is disabled |

## Security

- Only `http` and `https` URLs are accepted.
- Requests to localhost, private networks (10.x, 192.168.x, 172.16–31.x), link-local and cloud metadata addresses (169.254.169.254) are blocked, both for the initial URL and for every redirect or sub-resource the page loads.
- The API is public. If abuse becomes a problem, add rate limiting (for example Upstash Redis with `@upstash/ratelimit`) or check the `Referer` header against your own domains in `api/screenshot.js`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No local Chrome found` | Install Chrome or set `CHROME_PATH` |
| Vercel error mentioning `libnss3.so` or missing `/tmp/chromium` | Make sure the Node version is 22.x in Project Settings → General, and that `includeFiles` is still in `vercel.json` |
| `504 FUNCTION_INVOCATION_TIMEOUT` | The site is very slow; retry, or use a smaller width without full page |
| Blank or half-loaded screenshots | Add `&delay=2000` for sites with animations or lazy loading |
| Bot-protection pages (Cloudflare, etc.) | Some sites block headless browsers; this isn't bypassable on the free tier |
