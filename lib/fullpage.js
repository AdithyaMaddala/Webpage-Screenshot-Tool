// Helpers that make "whole page" captures work on pages that don't scroll
// the normal way, e.g. apps and email previews whose content lives inside an
// inner scrolling box or an <iframe>, so the page itself is only one screen tall.

// Runs inside the page. Finds the main inner scroll box (if any) and removes the
// height/overflow limits on it and its parents so all content lays out at full height.
function unlockScrollContainers() {
  const root = document.documentElement;
  const body = document.body;
  if (!body) return 0;

  const relax = (el) => {
    const s = getComputedStyle(el);
    if (s.position === "fixed" || s.position === "absolute") {
      el.style.setProperty("position", "relative", "important");
      el.style.setProperty("inset", "auto", "important");
    }
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("overflow", "visible", "important");
  };

  // Pages that lock the whole document (html/body { height:100%; overflow:hidden }).
  [root, body].forEach((el) => {
    el.style.setProperty("overflow", "visible", "important");
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("max-height", "none", "important");
  });

  const wide = window.innerWidth * 0.5;
  const scrollers = [...body.querySelectorAll("*")].filter((el) => {
    if (el.clientWidth < wide) return false;
    if (el.scrollHeight <= el.clientHeight + 20) return false;
    return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
  });
  if (!scrollers.length) return 0;

  // The biggest scroller is almost always the page's real content area.
  scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
  const main = scrollers[0];
  for (let el = main; el && el !== root; el = el.parentElement) relax(el);
  return main.scrollHeight;
}

function documentHeight() {
  const b = document.body;
  return Math.max(
    document.documentElement.scrollHeight,
    b ? b.scrollHeight : 0,
    b ? b.getBoundingClientRect().height : 0
  );
}

/**
 * Prepares a page for a whole-page screenshot and returns its full height in px.
 */
export async function prepareFullPage(page, maxHeight) {
  const viewport = page.viewport();

  // 1. Grow large iframes (like email previews) to the height of their content.
  for (const handle of await page.$$("iframe")) {
    try {
      const box = await handle.boundingBox();
      if (!box || box.width < viewport.width * 0.5) continue;
      const frame = await handle.contentFrame();
      if (!frame) continue;
      await frame.evaluate(unlockScrollContainers).catch(() => {});
      const inner = await frame.evaluate(documentHeight).catch(() => 0);
      if (inner > box.height + 20) {
        await handle.evaluate((el, h) => {
          el.style.setProperty("height", `${h}px`, "important");
          el.style.setProperty("max-height", "none", "important");
          el.setAttribute("scrolling", "no");
        }, Math.min(inner, maxHeight));
      }
    } catch {
      /* one odd iframe shouldn't break the capture */
    }
    await handle.dispose().catch(() => {});
  }

  // 2. Unlock inner scroll boxes in the page itself (after iframes grew).
  await page.evaluate(unlockScrollContainers).catch(() => {});

  // 3. Scroll through the page so lazy-loaded images actually load, then return to the top.
  await page
    .evaluate(async (limit) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const end = Math.min(document.documentElement.scrollHeight, limit);
      for (let y = 0; y < end; y += window.innerHeight) {
        window.scrollTo(0, y);
        await wait(120);
      }
      window.scrollTo(0, 0);
      const pending = [...document.images].filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.map((img) => new Promise((r) => { img.onload = img.onerror = r; }))),
        wait(3000),
      ]);
    }, maxHeight)
    .catch(() => {});

  return page.evaluate(documentHeight);
}
