// The agent's screen. One Playwright persistent context for the whole machine, so the
// cookie jar and saved logins are shared and a handoff never starts with "sign in again".
// Each agent gets its own page in that context: its own screen, launched lazily.
// Screens are work surfaces, not a security boundary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page, CDPSession } from "playwright";
import { bus } from "./bus.js";
import { assertOutbound } from "./privacy.js";
import { log } from "./log.js";
import { insertMessage, getAgent } from "./db.js";
import { paths } from "./config.js";
import type { ToolCtx, ToolDef } from "./tools/registry.js";

export const VIEWPORT = { width: 1280, height: 800 };

let dataDir = "";
let headful = false;
let contextPromise: Promise<BrowserContext> | null = null;
const pages = new Map<string, Page>();

interface Cast {
  cdp: CDPSession | null;
  page: Page | null;
  subs: Set<(frame: string) => void>;
  last: string | null;
}
const casts = new Map<string, Cast>();

export function initScreens(o: { dataDir: string; headful: boolean }) {
  dataDir = o.dataDir;
  headful = o.headful;
}

/**
 * Chromium candidates, best first. Playwright's own build, then a configured path, then a
 * system Chrome or Edge, then any older Playwright Chromium already on disk. The last one
 * matters on OS versions a new Playwright no longer ships for (macOS 13, for example).
 */
function cachedChromiums(): string[] {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Caches/ms-playwright")
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
        : path.join(os.homedir(), ".cache/ms-playwright"));
  if (!fs.existsSync(root)) return [];
  const rel = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  return fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .flatMap((d) => rel.map((r) => path.join(root, d, r)))
    .filter((f) => fs.existsSync(f));
}

async function context(): Promise<BrowserContext> {
  contextPromise ??= (async () => {
    const { chromium } = await import("playwright");
    const base = { headless: !headful, viewport: VIEWPORT, args: ["--disable-blink-features=AutomationControlled"] };
    const attempts: { label: string; opts: Record<string, unknown> }[] = [];
    if (process.env.ANTS_CHROMIUM) attempts.push({ label: process.env.ANTS_CHROMIUM, opts: { executablePath: process.env.ANTS_CHROMIUM } });
    attempts.push({ label: "Playwright Chromium", opts: {} });
    attempts.push({ label: "Google Chrome", opts: { channel: "chrome" } });
    attempts.push({ label: "Microsoft Edge", opts: { channel: "msedge" } });
    for (const exe of cachedChromiums()) attempts.push({ label: exe, opts: { executablePath: exe } });

    const errors: string[] = [];
    for (const a of attempts) {
      try {
        const ctx = await chromium.launchPersistentContext(paths(dataDir).browser, { ...base, ...a.opts });
        log.info(`screens use ${a.label}`);
        ctx.on("close", () => {
          contextPromise = null;
          pages.clear();
        });
        // The persistent context opens with one blank tab. Nobody owns it.
        for (const p of ctx.pages()) await p.close().catch(() => {});
        return ctx;
      } catch (e: any) {
        const msg = String(e.message ?? e);
        // Only "no such browser" moves on to the next candidate. A real launch error is reported.
        if (!/Executable doesn't exist|is not found|not installed|ENOENT|Chromium distribution/i.test(msg)) {
          contextPromise = null;
          throw e;
        }
        errors.push(a.label);
      }
    }
    contextPromise = null;
    throw new Error(
      "No browser for the screen. Run `npx playwright install chromium` on the host, install Google Chrome, or set ANTS_CHROMIUM to a Chromium executable.",
    );
  })();
  return contextPromise;
}

export function hasScreen(agentId: string) {
  const p = pages.get(agentId);
  return !!p && !p.isClosed();
}

/** The agent's page, created on first use. Announces itself in the chat so the user can watch. */
export async function pageFor(agentId: string, thread?: string): Promise<Page> {
  const existing = pages.get(agentId);
  if (existing && !existing.isClosed()) return existing;
  const ctx = await context();
  const page = await ctx.newPage();
  adopt(agentId, page);
  const agent = getAgent(agentId);
  if (thread && agent) {
    // A worker announces its screen where the user can see it: the parent's chat.
    const where = agent.kind === "worker" && agent.parentThread ? agent.parentThread : thread;
    insertMessage({ thread: where, agentId, role: "event", content: `${agent.name} opened their screen`, meta: { screen: true } });
  }
  return page;
}

function adopt(agentId: string, page: Page) {
  pages.set(agentId, page);
  // A link that opens a new tab moves the agent's screen to it.
  page.on("popup", (p) => adopt(agentId, p));
  page.on("close", () => {
    if (pages.get(agentId) === page) pages.delete(agentId);
  });
  const cast = casts.get(agentId);
  if (cast?.subs.size) void startCast(agentId, cast);
}

export async function closeScreen(agentId: string) {
  const p = pages.get(agentId);
  pages.delete(agentId);
  await p?.close().catch(() => {});
}

export async function shutdownScreens() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  await ctx?.close().catch(() => {});
}

// ---------- live view ----------

async function startCast(agentId: string, cast: Cast) {
  const page = pages.get(agentId);
  if (!page || page.isClosed()) return;
  if (cast.page === page && cast.cdp) return;
  await stopCast(cast);
  cast.page = page;
  try {
    const cdp = await page.context().newCDPSession(page);
    cast.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: any) => {
      cast.last = f.data;
      for (const s of cast.subs) s(f.data);
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
    // Screencast only sends on change. Send the current picture right away.
    const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    if (shot) {
      cast.last = shot.toString("base64");
      for (const s of cast.subs) s(cast.last);
    }
  } catch (e: any) {
    log.warn("screencast failed", e.message);
  }
}

async function stopCast(cast: Cast) {
  const cdp = cast.cdp;
  cast.cdp = null;
  cast.page = null;
  if (cdp) {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

/** Watch an agent's screen. Leaving the view only unsubscribes; the work goes on. */
export function watchScreen(agentId: string, onFrame: (jpegBase64: string) => void): () => void {
  let cast = casts.get(agentId);
  if (!cast) casts.set(agentId, (cast = { cdp: null, page: null, subs: new Set(), last: null }));
  cast.subs.add(onFrame);
  if (cast.last) onFrame(cast.last);
  void startCast(agentId, cast);
  const c = cast;
  return () => {
    c.subs.delete(onFrame);
    if (!c.subs.size) void stopCast(c);
  };
}

// ---------- tools ----------

const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-ants-ref]').forEach(e => e.removeAttribute('data-ants-ref'));
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=true],summary';
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    if (r.bottom < -innerHeight || r.top > innerHeight * 3) continue;
    n++; el.setAttribute('data-ants-ref', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || el.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const type = el.type && tag === 'input' ? '[' + el.type + ']' : '';
    const where = r.top > innerHeight ? ' (below)' : r.bottom < 0 ? ' (above)' : '';
    out.push(n + ': ' + tag + type + ' ' + label + where);
    if (n >= 150) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n\\s*\\n+/g, '\\n\\n').slice(0, 8000);
  return { title: document.title, url: location.href, text, elements: out };
})()`;

async function snapshot(page: Page, textLimit = 8000) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  const s = (await page.evaluate(SNAPSHOT)) as { title: string; url: string; text: string; elements: string[] };
  return [
    `Title: ${s.title}`,
    `URL: ${s.url}`,
    "",
    "Interactive elements (use ref with screen_click / screen_type):",
    s.elements.join("\n") || "(none)",
    "",
    "Visible text:",
    s.text.slice(0, textLimit),
  ].join("\n");
}

function locate(page: Page, a: { ref?: number | string; selector?: string; text?: string }) {
  if (a.ref !== undefined && a.ref !== null && a.ref !== "") return page.locator(`[data-ants-ref="${String(a.ref)}"]`).first();
  if (a.selector) return page.locator(a.selector).first();
  if (a.text) return page.getByText(a.text, { exact: false }).first();
  throw new Error("Give a ref from screen_read, a CSS selector, or the visible text to target.");
}

async function pointAt(agentId: string, kind: string, loc: ReturnType<typeof locate>, text?: string) {
  const box = await loc.boundingBox({ timeout: 5000 }).catch(() => null);
  bus.send({
    type: "screen_action",
    agentId,
    kind,
    text,
    ...(box ? { x: (box.x + box.width / 2) / VIEWPORT.width, y: (box.y + box.height / 2) / VIEWPORT.height } : {}),
  });
}

const settle = (page: Page) =>
  Promise.race([page.waitForLoadState("domcontentloaded").catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).then(
    () => new Promise((r) => setTimeout(r, 400)),
  );

const target = {
  ref: { type: "integer", description: "Element ref from the last screen_read" },
  selector: { type: "string", description: "CSS selector, if no ref" },
  text: { type: "string", description: "Visible text to find, if no ref or selector" },
};

const consequential = {
  type: "boolean",
  description: "Set true if this action sends, buys, deletes, or posts as the user. It will wait for the user's approval.",
};

export function screenTools(): Omit<ToolDef, "plugin">[] {
  const pg = (ctx: ToolCtx) => pageFor(ctx.agent.id, ctx.thread);
  return [
    {
      name: "screen_open",
      description:
        "Open a URL on your own screen (a real browser). Cookies and logins are shared with the other agents on this machine. Returns the page's elements and text.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      async run({ url }, ctx) {
        const page = await pg(ctx);
        const u = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
        assertOutbound(u, { action: "screen_open", agentId: ctx.agent.id, agentName: ctx.agent.name });
        bus.send({ type: "screen_action", agentId: ctx.agent.id, kind: "navigate", text: u });
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settle(page);
        return snapshot(page);
      },
    },
    {
      name: "screen_read",
      description: "Read what is on your screen now: title, URL, numbered interactive elements, and visible text.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        return snapshot(await pg(ctx));
      },
    },
    {
      name: "screen_click",
      description: "Click an element on your screen.",
      parameters: { type: "object", properties: { ...target, consequential } },
      gate: { when: "consequential" },
      async run(a, ctx) {
        const page = await pg(ctx);
        const loc = locate(page, a);
        await pointAt(ctx.agent.id, "click", loc);
        await loc.click({ timeout: 10_000 });
        await settle(page);
        return snapshot(page, 3000);
      },
    },
    {
      name: "screen_type",
      description: "Type into a field on your screen. Replaces the field's content. Set submit to press Enter after.",
      parameters: {
        type: "object",
        properties: { ...target, value: { type: "string", description: "What to type" }, submit: { type: "boolean" }, consequential },
        required: ["value"],
      },
      gate: { when: "consequential" },
      async run(a, ctx) {
        const page = await pg(ctx);
        const loc = locate(page, a);
        await pointAt(ctx.agent.id, "type", loc, a.value);
        await loc.fill(a.value, { timeout: 10_000 });
        if (a.submit) await loc.press("Enter");
        await settle(page);
        return snapshot(page, 3000);
      },
    },
    {
      name: "screen_press",
      description: "Press a key on your screen, like Enter, Escape, Tab, or ArrowDown.",
      parameters: { type: "object", properties: { key: { type: "string" }, consequential }, required: ["key"] },
      gate: { when: "consequential" },
      async run({ key }, ctx) {
        const page = await pg(ctx);
        bus.send({ type: "screen_action", agentId: ctx.agent.id, kind: "key", text: key });
        await page.keyboard.press(key);
        await settle(page);
        return snapshot(page, 3000);
      },
    },
    {
      name: "screen_scroll",
      description: "Scroll your screen up or down.",
      parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] },
      async run({ direction }, ctx) {
        const page = await pg(ctx);
        bus.send({ type: "screen_action", agentId: ctx.agent.id, kind: "scroll", text: direction });
        await page.mouse.wheel(0, direction === "up" ? -600 : 600);
        await new Promise((r) => setTimeout(r, 400));
        return snapshot(page, 3000);
      },
    },
    {
      name: "screen_back",
      description: "Go back one page on your screen.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        const page = await pg(ctx);
        await page.goBack({ timeout: 15_000 }).catch(() => {});
        await settle(page);
        return snapshot(page, 3000);
      },
    },
    {
      name: "screen_capture",
      description: "Take a screenshot of your screen and show it in the chat.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        const page = await pg(ctx);
        const dir = paths(dataDir).shots(ctx.agent.id);
        fs.mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}.jpg`;
        await page.screenshot({ path: path.join(dir, file), type: "jpeg", quality: 75 });
        return { text: `Screenshot of ${page.url()} shown in the chat.`, image: file };
      },
    },
  ];
}
