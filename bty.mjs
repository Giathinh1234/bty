#!/usr/bin/env node
// bty — drive a dedicated Chromium window from the terminal over CDP.
// No browser extension, no browser-side agent code. Terminal in, keystrokes out.
//
//   bty start [--url URL]        launch the dedicated window (separate profile)
//   bty stop                     close it
//   bty status                   is it up, what is focused
//   bty open <url>               navigate the pinned page
//   bty tabs                     list page targets
//   bty use <targetId>           pin a specific tab (AI is then locked to it)
//   bty focus <css>              focus an element
//   bty type "text"              type into the focused element
//   bty key <Key>                press a key (Enter, Tab, ...)
//
//   bty msg "hello"              Discord: focus composer, type, send
//   bty msg --draft "hello"      Discord: type but do not send
//   bty click <css>              click an element
//   bty read <css>               print element text
//   bty eval "<js>"              run JS, print JSON result
//   bty shot [file]              screenshot to a PNG

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DIR = path.join(HOME, ".bty");
const STATE_FILE = path.join(DIR, "state.json");
const PROFILE = process.env.BTY_PROFILE || path.join(DIR, "profile");
const PORT = Number(process.env.BTY_PORT || 9333);

const BROWSER_CANDIDATES = [
  process.env.BTY_BROWSER,
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/opt/google/chrome/chrome",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge",
].filter(Boolean);

// ---------------------------------------------------------------- state

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  fs.mkdirSync(DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

const die = (msg, code = 1) => {
  console.error(`bty: ${msg}`);
  process.exit(code);
};

function findBrowser() {
  for (const bin of BROWSER_CANDIDATES) {
    if (fs.existsSync(bin)) return bin;
  }
  die("no Chromium-based browser found. Set BTY_BROWSER=/path/to/binary");
}

// ---------------------------------------------------------------- cdp

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Conn(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // The timer must be cleared on completion, otherwise a pending handle keeps
      // the event loop alive and the CLI hangs after every command.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) die(`browser not reachable on port ${PORT} (HTTP ${res.status})`);
  return res.json();
}

async function pickTarget() {
  const targets = (await listTargets()).filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!targets.length) die("no page targets found");
  const state = readState();
  // A locked tab wins over the pinned one: it cannot be changed by accident.
  const wanted = state.locked || state.targetId;
  if (wanted) {
    const found = targets.find((t) => t.id === wanted);
    if (found) return found;
    console.error(`bty: target ${wanted} is gone; falling back to ${targets[0].id}`);
  }
  return targets[0];
}

// Runs a function with a live connection to the target page.
async function withPage(fn, opts = {}) {
  const target = await pickTarget();
  const conn = await Conn.open(target.webSocketDebuggerUrl);
  try {
    // Without focus emulation, Chrome drops synthesized key events when the
    // browser window is not the OS-focused window (common with editors like
    // Slate, which swallow keys that arrive untrusted).
    try {
      await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch {
      // Not all targets support it; key events still work in most cases.
    }
    return await fn(conn, target);
  } finally {
    conn.close();
  }
}

async function evaluate(conn, expression, timeoutMs = 30000) {
  const { result, exceptionDetails } = await conn.send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    timeoutMs,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result.value;
}

// ---------------------------------------------------------------- typing

const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
};

async function pressKey(conn, name, modifiers = 0) {
  const spec = KEYS[name];
  if (!spec) die(`unknown key "${name}"`);
  // Shift+Enter should produce a newline, not a carriage return.
  const text = modifiers & 8 && spec.text === "\r" ? "\n" : spec.text;
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers,
  };
  await conn.send("Input.dispatchKeyEvent", {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    text,
    unmodifiedText: text,
  });
  await conn.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// Insert text as a real input event (React/Vue/Slate see it as user typing).
async function insertText(conn, text) {
  await conn.send("Input.insertText", { text });
}

// Fallback path: one keyDown/keyUp pair per character.
async function typeAsKeys(conn, text) {
  for (const ch of text) {
    await conn.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      unmodifiedText: ch,
      key: ch,
    });
    await conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

// Reads the current composer text (empty string when there is none).
// Slate renders the placeholder inside the editable as a
// [data-slate-placeholder] span, so it must be stripped before reading.
const DISCORD_COMPOSER_TEXT_JS = `(() => {
  const el = document.querySelector('form div[contenteditable="true"][role="textbox"]')
    || document.querySelector('div[contenteditable="true"][data-slate-editor="true"]')
    || document.querySelector('div[contenteditable="true"]');
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll('[data-slate-placeholder], [aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent || "").replace(/\\uFEFF/g, "").replace(/\\u200B/g, "").trim();
})()`;

// Clears a focused contenteditable using real key events (select-all via the
// Selection API, then Backspace). Setting innerHTML directly would desync
// Slate/React's internal state, and a synthetic Meta+A does not select.
async function clearComposer(conn) {
  await evaluate(
    conn,
    `(() => {
      const el = document.activeElement;
      if (!el || !el.isContentEditable) return false;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`,
  );
  await sleep(60);
  await pressKey(conn, "Backspace");
  await sleep(120);
}

// Harvests every message currently rendered in the channel.
//
// Discord virtualises the message list, so this only sees what is in the DOM.
// Older messages are pulled in by scrolling (see cmdHistory) and harvested
// again after each scroll.
//
// Returns an array of { id, author, ts, edited, text }.
const DISCORD_HARVEST_JS = `(() => {
  const list = document.querySelector('[data-list-id="chat-messages"]');
  if (!list) return [];

  const clean = (content) => {
    if (!content) return "";
    const c = content.cloneNode(true);
    // Discord renders a visually-hidden full timestamp inside the content.
    c.querySelectorAll('[class*="hiddenVisually"], [class*="visuallyHidden"]').forEach((n) => n.remove());
    // Code block header buttons (copy, expand) are not message text.
    c.querySelectorAll('button, [class*="copyButton"], [class*="codeBlock"] [role="button"]').forEach((n) => n.remove());
    // Custom emoji are images; their alt text is the real content.
    c.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt");
      if (alt && alt.trim()) {
        const s = document.createElement("span");
        s.textContent = ":" + alt.trim() + ":";
        img.replaceWith(s);
      }
    });
    return c.innerText.replace(/\\n{3,}/g, "\\n\\n").trim();
  };

  let lastAuthor = null;
  const out = [];
  for (const li of list.querySelectorAll('li[id^="chat-messages-"]')) {
    const userEl = li.querySelector('[id^="message-username-"]');
    const named = userEl ? userEl.querySelector("[data-text]") : null;
    if (named) lastAuthor = named.getAttribute("data-text");
    const timeEl = li.querySelector("time[datetime]");
    const content = li.querySelector('[id^="message-content-"]');
    out.push({
      id: li.id.replace(/^chat-messages-/, ""),
      author: lastAuthor,
      ts: timeEl ? timeEl.getAttribute("datetime") : null,
      edited: !!li.querySelector('[class*="edited"]'),
      text: clean(content),
    });
  }
  return out;
})()`;

// Geometry and scroll state of the message scroller.
const DISCORD_SCROLLER_JS = `(() => {
  const list = document.querySelector('[data-list-id="chat-messages"]');
  if (!list) return null;
  let scroller = null;
  for (let el = list; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") { scroller = el; break; }
  }
  if (!scroller) return null;
  const r = scroller.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    top: Math.round(scroller.scrollTop),
    height: Math.round(scroller.scrollHeight),
    client: scroller.clientHeight,
  };
})()`;

// ---------------------------------------------------------------- commands

const FOCUS_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: "no element for " + ${JSON.stringify(selector)} };
  el.scrollIntoView({ block: "center", inline: "nearest" });
  el.focus();
  if (el.isContentEditable) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return { ok: true, tag: el.tagName, contentEditable: !!el.isContentEditable };
})()`;

const DISCORD_FOCUS_JS = `(() => {
  const groups = [
    'form div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-slate-editor="true"][role="textbox"]',
    'form[aria-label="Send Message"] div[contenteditable="true"]',
  ];
  // The last-resort group must skip search boxes and other comboboxes, which
  // are also contenteditable and would otherwise swallow the message.
  const loose = 'div[contenteditable="true"]';

  const visible = (n) => n.offsetParent !== null;
  let el = null;
  for (const sel of groups) {
    const found = [...document.querySelectorAll(sel)].filter(visible);
    if (found.length) { el = found[found.length - 1]; break; }
  }
  if (!el) {
    const found = [...document.querySelectorAll(loose)].filter(
      (n) => visible(n) && !n.closest('nav') && !n.closest('[role="navigation"]'),
    );
    if (found.length) el = found[found.length - 1];
  }
  if (!el) return { ok: false, reason: "composer not found (not logged in, or wrong view)" };

  el.scrollIntoView({ block: "center" });
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return { ok: true, tag: el.tagName, label: el.getAttribute("aria-label"), role: el.getAttribute("role") };
})()`;

// Reads which channel/guild the composer currently belongs to, so a send can be
// verified against the expected destination.
//
// Discord's aria-labels are the most stable signal:
//   [aria-label$="(channel)"]   -> "ai (channel)"
//   [aria-label^="Messages in"] -> "Messages in ai"
//   [aria-label$="(server)"]    -> "My Guild (server)"
// The DOM classes Discord uses for the header change between releases, so they
// are only used as a fallback.
const DISCORD_CONTEXT_JS = `(() => {
  const aria = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute("aria-label") : null;
  };

  let channel = aria('[aria-label$="(channel)"]');
  if (channel) {
    channel = channel.replace(/\\s*\\((text\\s+)?channel\\)$/i, "").trim();
  }
  if (!channel) {
    const msgs = aria('[aria-label^="Messages in"]');
    if (msgs) channel = msgs.replace(/^Messages in\\s+/i, "").trim();
  }

  let guild = aria('[aria-label$="(server)"]');
  if (guild) guild = guild.replace(/\\s*\\(server\\)$/i, "").trim();

  // Fallback: Discord puts the channel in the document title, e.g.
  // "(935) Discord | #general | My Guild".
  const titleParts = (document.title || "").split("|").map((s) => s.trim());
  if (!channel) {
    const part = titleParts.find((s) => /^#/.test(s));
    if (part) channel = part.replace(/^#/, "").trim();
  }
  if (!guild) {
    const last = titleParts[titleParts.length - 1];
    if (last && !/^discord$/i.test(last) && !/^#/.test(last)) guild = last;
  }

  return {
    channel: channel || null,
    guild: guild || null,
    dm: channel && /\\((user|dm)\\)$/i.test(channel) ? channel : null,
  };
})()`;

async function cmdStart(args) {
  let url = "about:blank";
  let appMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url") url = args[++i];
    else if (args[i] === "--app") appMode = true;
  }
  if (url === "about:blank" && !appMode) url = "https://discord.com/app";

  const state = readState();
  if (state.pid && isAlive(state.pid)) {
    console.log(`bty: already running (pid ${state.pid})`);
    if (url && url !== "about:blank") await cmdOpen([url]);
    return;
  }

  const bin = findBrowser();
  fs.mkdirSync(PROFILE, { recursive: true });
  const args2 = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--window-size=1280,900",
    "--window-position=40,40",
  ];
  // --app renders a chromeless window: one URL, no address bar, no tabs.
  if (appMode) args2.push(`--app=${url}`);
  else args2.push(url);

  const child = spawn(bin, args2, { detached: true, stdio: "ignore" });
  child.unref();
  writeState({ pid: child.pid, port: PORT, profile: PROFILE, startedAt: Date.now() });

  // Wait for the debugging endpoint to come up.
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) {
        const targets = await listTargets();
        const page = targets.find((t) => t.type === "page");
        if (page) writeState({ targetId: page.id });
        console.log(`bty: launched ${bin} (pid ${child.pid}) on port ${PORT}`);
        console.log(`bty: profile ${PROFILE}`);
        console.log(`bty: window is open and visible — log in there once if needed`);
        return;
      }
    } catch {}
  }
  die("browser did not expose a debugging port in time");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStop() {
  const state = readState();
  if (!state.pid) {
    console.log("bty: nothing to stop");
    return;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}
  await sleep(400);
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {}
  }
  writeState({ pid: null, targetId: null });
  console.log("bty: stopped");
}

async function cmdStatus() {
  const state = readState();
  let targets = [];
  try {
    targets = (await listTargets()).filter((t) => t.type === "page");
  } catch {
    console.log("bty: browser not running");
    return;
  }
  console.log(`pid:     ${state.pid || "-"} (${state.pid && isAlive(state.pid) ? "alive" : "dead"})`);
  console.log(`port:    ${PORT}`);
  console.log(`profile: ${state.profile || PROFILE}`);
  console.log(`pinned:  ${state.targetId || "(none)"}`);
  console.log(`locked:  ${state.locked || "(no)"}`);
  console.log("pages:");
  for (const t of targets) {
    console.log(`${t.id === state.targetId ? "*" : "-"} ${t.id}  ${t.title}  ${t.url}`);
  }
}

async function cmdTabs() {
  const targets = (await listTargets()).filter((t) => t.type === "page");
  const pinned = readState().targetId;
  // Fixed columns: field 1 is always the marker, field 2 is always the id,
  // so `bty tabs | awk '$1=="*"{print $2}'` always works.
  for (const t of targets) {
    console.log(`${t.id === pinned ? "*" : "-"} ${t.id}  ${t.title}  ${t.url}`);
  }
}

async function cmdNewTab(args) {
  const url = args[0] || "about:blank";
  const state = readState();
  if (state.locked) die(`tab is locked to ${state.locked}. Unlock with "bty use --unlock" first.`);
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  if (!res.ok) die("browser not running");
  const { webSocketDebuggerUrl } = await res.json();
  const conn = await Conn.open(webSocketDebuggerUrl);
  try {
    const { targetId } = await conn.send("Target.createTarget", { url });
    writeState({ targetId });
    console.log(`bty: opened ${url} as ${targetId} (pinned)`);
  } finally {
    conn.close();
  }
}

async function cmdUse(args) {
  const unlock = args.includes("--unlock");
  const id = args.find((a) => !a.startsWith("--"));
  const state = readState();

  if (unlock) {
    writeState({ locked: false });
    console.log("bty: unlocked — tabs can be re-pinned");
    return;
  }
  if (!id) die("usage: bty use <targetId> | bty use --unlock");

  const targets = (await listTargets()).filter((t) => t.type === "page");
  const t = targets.find((x) => x.id === id || x.id.startsWith(id));
  if (!t) die(`no page target matching "${id}"`);

  if (state.locked && state.locked !== t.id) {
    die(`tab is locked to ${state.locked}. Run "bty use --unlock" to change it.`);
  }
  writeState({ targetId: t.id });
  console.log(`bty: pinned ${t.id} (${t.url})`);
}

async function cmdLock(args) {
  const id = args[0];
  const targets = (await listTargets()).filter((t) => t.type === "page");
  const t = id ? targets.find((x) => x.id === id || x.id.startsWith(id)) : targets[0];
  if (!t) die("no page target to lock");
  writeState({ targetId: t.id, locked: t.id });
  console.log(`bty: locked to ${t.id} (${t.url})`);
  console.log("bty: commands can no longer be pointed at another tab.");
  console.log("bty: unlock with: bty use --unlock");
}

async function cmdOpen(args) {
  const url = args[0];
  if (!url) die("usage: bty open <url>");
  await withPage(async (conn) => {
    await conn.send("Page.enable");
    await conn.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      const state = await evaluate(conn, "document.readyState");
      if (state === "complete") break;
    }
    console.log(`bty: opened ${url}`);
  });
}

async function cmdFocus(args) {
  const selector = args[0];
  if (!selector) die("usage: bty focus <css>");
  const out = await withPage((conn) => evaluate(conn, FOCUS_JS(selector)));
  console.log(JSON.stringify(out));
  if (!out?.ok) process.exit(1);
}

async function cmdType(args) {
  const text = args.join(" ");
  if (!text) die("usage: bty type \"text\"");
  await withPage(async (conn) => {
    if (process.env.BTY_KEYS) await typeAsKeys(conn, text);
    else await insertText(conn, text);
  });
  console.log(`bty: typed ${text.length} chars`);
}

async function cmdKey(args) {
  const name = args[0];
  if (!name) die("usage: bty key <Key>");
  await withPage((conn) => pressKey(conn, name));
  console.log(`bty: pressed ${name}`);
}

async function cmdClick(args) {
  const selector = args[0];
  if (!selector) die("usage: bty click <css>");
  const out = await withPage((conn) =>
    evaluate(conn, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "not found" };
      el.click();
      return { ok: true, tag: el.tagName };
    })()`),
  );
  console.log(JSON.stringify(out));
  if (!out?.ok) process.exit(1);
}

async function cmdRead(args) {
  const selector = args[0] || "body";
  const out = await withPage((conn) =>
    evaluate(conn, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.innerText : null;
    })()`),
  );
  console.log(out === null ? "(no element)" : out);
}

async function cmdEval(args) {
  const js = args.join(" ");
  if (!js) die("usage: bty eval \"<js>\"");
  const out = await withPage((conn) => evaluate(conn, js));
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}

async function cmdShot(args) {
  const file = args[0] || path.join(DIR, "shot.png");
  const { data } = await withPage(async (conn) => {
    const { data } = await conn.send("Page.captureScreenshot", { format: "png" });
    return { data };
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(file);
}

async function cmdMsg(args) {
  const draft = args.includes("--draft");
  const replace = args.includes("--replace");
  const append = args.includes("--append");
  let expect = null;
  const expectIdx = args.indexOf("--in");
  if (expectIdx !== -1) {
    expect = args[expectIdx + 1];
    args.splice(expectIdx, 2);
  }
  const text = args.filter((a) => !["--draft", "--replace", "--append"].includes(a)).join(" ");
  if (!text && !(replace && !draft)) {
    die('usage: bty msg "message" | --draft | --replace | --append | --in "#chan"');
  }

  const result = await withPage(async (conn) => {
    const focused = await evaluate(conn, DISCORD_FOCUS_JS);
    if (!focused?.ok) {
      throw new Error(
        `${focused?.reason || "focus failed"} — open the Discord window, log in, and open the channel you want.`,
      );
    }
    const ctx = await evaluate(conn, DISCORD_CONTEXT_JS);
    const where = ctx?.dm || ctx?.channel || ctx?.guild || "(unknown)";
    if (expect && !where.toLowerCase().includes(expect.toLowerCase().replace(/^#/, ""))) {
      throw new Error(`wrong destination: composer is in "${where}", expected "${expect}". Nothing sent.`);
    }

    const existing = await evaluate(conn, DISCORD_COMPOSER_TEXT_JS);
    if (existing && !replace && !append) {
      throw new Error(
        `composer already contains "${existing}" — pass --replace to overwrite it or --append to add to it. Nothing sent.`,
      );
    }
    if (existing && replace) {
      await clearComposer(conn);
    }
    // An empty message with --replace simply clears the composer.
    if (!text) {
      return { where, existing, cleared: true };
    }

    // Discord's composer is a contenteditable; insertText fires the input event Slate expects.
    // A literal "\n" inside insertText produces a real line break, whereas a
    // synthetic Shift+Enter does not reach the editor's key handler reliably.
    await insertText(conn, text);
    if (!draft) {
      await sleep(150);
      await pressKey(conn, "Enter");
    }
    return { where, existing };
  });

  console.log(
    result.cleared
      ? `bty: cleared the composer in "${result.where}"`
      : draft
        ? `bty: drafted ${text.length} chars in "${result.where}" (not sent)`
        : `bty: sent ${text.length} chars in "${result.where}"`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdLogin(args) {
  const url = args[0] || "https://discord.com/login";
  await withPage(async (conn) => {
    await conn.send("Page.enable");
    await conn.send("Page.navigate", { url });
  });
  console.log(`bty: opened ${url}`);
  console.log("bty: log in in that window (QR code in Discord mobile app is easiest).");
  console.log("bty: the session persists in ~/.bty/profile — you only do this once.");
}

async function cmdWhere() {
  const ctx = await withPage((conn) => evaluate(conn, DISCORD_CONTEXT_JS));
  console.log(`channel: ${ctx?.channel || "(unknown)"}`);
  console.log(`guild:   ${ctx?.guild || "(unknown)"}`);
  console.log(`title:   ${await withPage((conn) => evaluate(conn, "document.title"))}`);
}

function formatStamp(iso) {
  if (!iso) return "?".padEnd(16);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?".padEnd(16);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function cmdReload() {
  await withPage(async (conn) => {
    await conn.send("Page.enable");
    await conn.send("Page.reload", { ignoreCache: false });
  });
  console.log("bty: reloaded");
}

async function cmdHistory(args) {
  const all = args.includes("--all");
  const asJson = args.includes("--json");
  const raw = args.includes("--raw");
  const numArg = args.find((a) => /^\d+$/.test(a));
  const limit = all ? Infinity : numArg ? Number(numArg) : 20;

  const result = await withPage(async (conn) => {
    // Discord caches the loaded history per channel view, so a second --all in
    // the same view stops early. Reloading resets that state and makes the
    // walk start from the bottom of a fresh view every time.
    if (all) {
      await conn.send("Page.enable");
      await conn.send("Page.reload", { ignoreCache: false });
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        try {
          const ready = await evaluate(
            conn,
            `!!document.querySelector('[data-list-id="chat-messages"] li[id^="chat-messages-"]')`,
          );
          if (ready) break;
        } catch {
          // The execution context is replaced during the reload; retry.
        }
      }
    }

    const seen = new Map();
    const harvest = async () => {
      const msgs = await evaluate(conn, DISCORD_HARVEST_JS);
      for (const m of msgs) if (!seen.has(m.id)) seen.set(m.id, m);
    };

    const start = await evaluate(conn, DISCORD_SCROLLER_JS);
    if (!start) throw new Error("no message list (are you in a channel?)");

    await harvest();

    // Discord only fetches older messages in response to a real upward scroll,
    // so drive genuine wheel input over the scroller rather than assigning
    // scrollTop (assigning it fires no scroll event and loads nothing).
    //
    // If enough messages are already rendered, do not scroll at all: that keeps
    // the reader's view untouched for the common case.
    let rounds = 0;
    let stalled = 0;
    const MAX_ROUNDS = 400;
    const needsScroll = all || seen.size < limit;

    if (needsScroll) {
      // Progress signal: the id of the oldest message in the DOM. Discord
      // fetches a page of older messages for each upward scroll and prepends
      // them, and that is the only thing that reliably indicates it loaded
      // something. Counting messages does not work, because Discord unloads
      // old messages from the DOM as it scrolls, so the count goes up and down.
      let oldestId = null;
      const oldest = async () => {
        const msgs = await evaluate(conn, DISCORD_HARVEST_JS);
        return msgs.length ? msgs[0].id : null;
      };
      oldestId = await oldest();

      while ((all || seen.size < limit) && rounds++ < MAX_ROUNDS) {
        // Small increments, the way a person scrolls. Large jumps can skip the
        // positions Discord's scroll handler watches for, and then it never
        // fires the "fetch older messages" request.
        for (let i = 0; i < 10; i++) {
          await conn.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: start.x,
            y: start.y,
            deltaX: 0,
            deltaY: -300,
          });
          await sleep(100);
        }
        await sleep(1200);
        await harvest();

        const nowOldest = await oldest();
        if (nowOldest && nowOldest !== oldestId) {
          oldestId = nowOldest;
          stalled = 0;
          if (all) process.stderr.write(`\rbty: loaded ${seen.size} messages...   `);
        } else {
          // No older message appeared: Discord has nothing more to give.
          if (++stalled >= 3) break;
        }
      }
      if (all) process.stderr.write("\r                    \r");

      // Scrolling up left the view in the past. Return to the newest messages:
      // that is the natural resting state, and it makes Discord re-render the
      // latest chunk so the next command starts from a consistent DOM.
      await evaluate(
        conn,
        `(() => {
          const list = document.querySelector('[data-list-id="chat-messages"]');
          for (let el = list; el; el = el.parentElement) {
            const oy = getComputedStyle(el).overflowY;
            if (oy === 'auto' || oy === 'scroll') { el.scrollTop = el.scrollHeight; break; }
          }
        })()`,
      );
      await sleep(400);
      await harvest();
    }

    const messages = [...seen.values()].sort((a, b) => {
      const at = a.ts ? Date.parse(a.ts) : 0;
      const bt = b.ts ? Date.parse(b.ts) : 0;
      return at - bt || a.id.localeCompare(b.id);
    });
    return { messages, rounds, loaded: seen.size };
  });

  let messages = result.messages;
  if (!all && messages.length > limit) messages = messages.slice(-limit);

  if (asJson) {
    console.log(
      JSON.stringify({ count: messages.length, loaded: result.loaded, messages }, null, 2),
    );
    return;
  }

  if (!messages.length) {
    console.log("(no messages)");
    return;
  }

  if (raw) {
    for (const m of messages) {
      console.log(m.text);
      console.log("");
    }
    return;
  }

  for (const m of messages) {
    const stamp = formatStamp(m.ts);
    const edited = m.edited ? " (edited)" : "";
    const body = m.text.replace(/\n/g, "\n" + " ".repeat(18));
    console.log(`[${stamp}] ${m.author || "?"}${edited}: ${body}`);
  }
  console.log("");
  console.log(
    `-- ${messages.length} message(s)` +
      (all ? ` (loaded ${result.loaded})` : result.loaded > messages.length ? ` (loaded ${result.loaded})` : ""),
  );
}

// ---------------------------------------------------------------- cli

const HELP = `bty — drive a dedicated Chromium window from the terminal (CDP)

Browser
  bty start [--url URL] [--app]   launch the window (default: discord.com/app)
  bty stop                        close it
  bty status                      show state and pages
  bty tabs                        list page targets
  bty newtab <url>                open a new tab and pin it
  bty use <targetId>              pin a tab (all later commands act on it)
  bty lock [targetId]             lock to one tab; cannot be re-pinned
  bty use --unlock                unlock
  bty login [url]                 open Discord login in the window

Page
  bty open <url>                  navigate
  bty focus <css>                 focus an element
  bty type "text"                 type into focused element
  bty key <Key>                   press a key
  bty click <css>                 click
  bty read [css]                  print element text
  bty eval "<js>"                 run JS, print JSON
  bty where                       show the current Discord channel/guild
  bty shot [file]                 screenshot
  bty reload                      reload the page

Discord
  bty msg "text"                  focus composer, type, send
  bty msg --draft "text"          focus composer, type, do not send
  bty msg --in "#chan" "text"     only send if the composer is in that channel
  bty history [n]                 print the last n messages (default 20)
  bty history --all               load and print the whole channel history
  bty history --json              machine-readable output
  bty history --raw               message text only, no timestamps
`;

const COMMANDS = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  tabs: cmdTabs,
  use: cmdUse,
  lock: cmdLock,
  newtab: cmdNewTab,
  open: cmdOpen,
  focus: cmdFocus,
  type: cmdType,
  key: cmdKey,
  click: cmdClick,
  read: cmdRead,
  eval: cmdEval,
  where: cmdWhere,
  reload: cmdReload,
  shot: cmdShot,
  msg: cmdMsg,
  history: cmdHistory,
  login: cmdLogin,
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(0);
}
const fn = COMMANDS[cmd];
if (!fn) die(`unknown command "${cmd}". Try: bty help`);
try {
  await fn(args);
} catch (err) {
  console.error(`bty: ${err.message}`);
  process.exit(1);
}
// Exit explicitly: the CDP socket and any stray handles would otherwise keep
// the event loop alive and hang the shell.
process.exit(0);
