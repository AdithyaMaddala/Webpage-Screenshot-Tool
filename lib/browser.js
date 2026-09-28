import fs from "node:fs";
import puppeteer from "puppeteer-core";

const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);

// Common Chrome/Chromium locations for local development.
const LOCAL_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findLocalChrome() {
  const found = LOCAL_CHROME_PATHS.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      "No local Chrome found. Install Google Chrome or set CHROME_PATH to your Chrome/Chromium binary."
    );
  }
  return found;
}

async function launch() {
  if (IS_SERVERLESS) {
    const { default: chromium } = await import("@sparticuz/chromium");
    chromium.setGraphicsMode = false; // no WebGL/GPU needed; faster cold start
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({
        args: chromium.args,
        headless: "shell",
      }),
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }

  return puppeteer.launch({
    executablePath: findLocalChrome(),
    headless: true,
    args: ["--no-sandbox", "--hide-scrollbars", "--disable-dev-shm-usage"],
  });
}

// Keep one browser alive per warm function instance so repeat requests skip the launch cost.
let browserPromise = null;

export async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.connected) return browser;
    } catch {
      /* fall through and relaunch */
    }
  }
  browserPromise = launch();
  const browser = await browserPromise;
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}
