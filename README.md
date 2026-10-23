# bty

A tool that can send control (And discord messages) to chrome via terminal. Drive a dedicated Chromium window from the terminal over the
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
No browser extension, no agent code injected into the page — the terminal is the
input device.

Works on any page. `bty msg` and `bty history` are purpose-built for Discord.

## Requirements

- **Node.js 22 or newer** — it uses the built-in `WebSocket` and `fetch`.
- **A Chromium-based browser** — Chrome, Chromium, Brave, or Edge.
- macOS, Linux, or Windows.

There are no dependencies. It is one file.

## Install

### Clone and link (recommended)

```sh
git clone https://github.com/Giathinh1234/bty.git ~/tools/bty
chmod +x ~/tools/bty/bty.mjs
mkdir -p ~/.local/bin
ln -sf ~/tools/bty/bty.mjs ~/.local/bin/bty
```

Make sure `~/.local/bin` is on your `PATH`. If `bty` is not found, add this to
your `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Check the install:

```sh
bty help
```

### Download the file

If you do not want a clone, download `bty.mjs` from
[Releases](https://github.com/Giathinh1234/bty/releases):

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/Giathinh1234/bty/releases/latest/download/bty.mjs \
  -o ~/.local/bin/bty
chmod +x ~/.local/bin/bty
```

### Windows

Download `bty.mjs`, then point it at your browser once (PowerShell):

```powershell
$env:BTY_BROWSER = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node C:\path\to\bty.mjs start
```

To get a `bty` command, save this as `bty.cmd` somewhere on your `PATH`:

```bat
@echo off
node "C:\path\to\bty.mjs" %*
```

## First run

```sh
bty start            # launches a dedicated Chromium window at discord.com/app
bty login            # opens Discord login in that window — log in there yourself
bty where            # confirm the channel
bty msg "hello"      # types into the composer and sends
```

`bty start` uses its own profile at `~/.bty/profile`, so this login is separate
from your everyday browser and only needs to be done once. The window is real
and visible; you can watch it, interrupt it, or take over by typing in it at any
time.

`bty start --app` opens a chromeless window instead: one URL, no tab strip, no
address bar.

## Why a separate window

`bty` launches Chromium with its own `--user-data-dir` and
`--remote-debugging-port`. That gives you:

- a window that is separate from your everyday browsing
- a stable login session an agent can reuse without touching your real profiles
- a visible window you can watch, interrupt, or type into at any moment

## Commands

### Browser

| Command | Description |
| --- | --- |
| `bty start [--url URL] [--app]` | Launch the window (default `discord.com/app`) |
| `bty stop` | Close the window (login persists) |
| `bty status` | Show pid, port, profile, pinned/locked target, page list |
| `bty tabs` | List page targets (`*` = pinned, `-` = other) |
| `bty newtab <url>` | Open a new tab and pin it |
| `bty use <targetId>` | Pin a specific tab |
| `bty lock [targetId]` | Lock to one tab; `use`/`newtab` are refused |
| `bty use --unlock` | Release the lock |
| `bty login [url]` | Open Discord login in the window |

### Page

| Command | Description |
| --- | --- |
| `bty open <url>` | Navigate the pinned tab |
| `bty focus <css>` | Focus an element |
| `bty type "text"` | Type into the focused element |
| `bty key <Key>` | Press a key (`Enter`, `Tab`, `Escape`, `ArrowUp`, ...) |
| `bty click <css>` | Click an element |
| `bty read [css]` | Print an element's visible text |
| `bty eval "<js>"` | Run JS in the page, print the JSON result |
| `bty shot [file]` | Screenshot to a PNG |
| `bty reload` | Reload the page |

### Discord

| Command | Description |
| --- | --- |
| `bty msg "text"` | Focus composer, type, press Enter (sends) |
| `bty msg --draft "text"` | Type but do not send |
| `bty msg --in "#chan" "text"` | Only send if the composer is in that channel |
| `bty msg --replace "text"` | Overwrite whatever is in the composer |
| `bty msg --append "text"` | Add to the existing composer text |
| `bty msg --replace ""` | Clear the composer without sending |
| `bty where` | Show the current channel / guild / page title |
| `bty history [n]` | Print the last n messages (default 20) |
| `bty history --all` | Load and print the entire channel history |
| `bty history --json` | Machine-readable output |
| `bty history --raw` | Message text only, no timestamps |

Flags combine: `bty msg --replace --in "#general" "hi"`.

## Reading history

Discord virtualises the message list: only a window of messages exists in the
DOM at any time, and older ones are fetched as you scroll up. `bty history`
therefore scrolls the list backwards with real mouse-wheel input, accumulates
what it sees, then restores the view.

`bty history --all` reloads the channel first. Discord caches the loaded history
per channel view, so without the reload a second `--all` in the same view stops
after a page or two. With it, the walk is repeatable — it reaches the first
message in the channel every time.

On a large channel `--all` takes minutes: the scroll-and-fetch cycle is limited
by Discord's own paging (20 messages per request).

`--json` emits:

```json
{
  "count": 2,
  "loaded": 2,
  "messages": [
    { "id": "...", "author": "thinhgia897", "ts": "2026-10-22T21:10:00.000Z",
      "edited": false, "text": "hello" }
  ]
}
```

## Safety behaviour

`bty msg` refuses to send in ambiguous situations:

- **Wrong channel** — with `--in`, a mismatch aborts before typing anything.
- **Non-empty composer** — aborts unless you pass `--replace` or `--append`, so
  you never silently clobber something the user wrote.

Multiline messages are sent as a single Enter. Newlines are inserted as literal
`\n` in the text payload, which produces the correct multi-line value in
Slate-based editors.

## Using it from an AI agent

`bty` is a plain CLI, so any agent with shell access can drive it. The
[`skill/SKILL.md`](skill/SKILL.md) file is an Agent Skill that documents the
workflow.

- **OpenCode:** copy it to `~/.config/opencode/skills/bty/SKILL.md`
  (or `~/.config/opencode/skill/bty/SKILL.md`).
- **Claude Code:** copy it to `~/.claude/skills/bty/SKILL.md`.
- **Anything else:** paste it into the system prompt, or point the agent at the
  file.

Guardrails worth keeping:

- Use `--draft` unless the user explicitly asked for the message to be sent.
- Always pass `--in` when the target channel is known.
- Read state before acting: `bty status`, `bty where`, `bty history 20`.
- `bty lock` prevents the agent from pointing commands at other tabs.

## Responsible use

`bty` types as you in a real browser session. On Discord, automating a user
account is against their Terms of Service — the same is true of most services
that offer no official automation API. Use it on your own account, keep the
window visible, and prefer `--draft` so a human presses Enter. And this tool
cannot be used as a way to mimic a real account using bots nor doing illegal things.
I dont intended to make this tools as a illegal tools to be used for scam, harassment,
etc.
I will not take any accountability nor responsibility that the user of this tools cause.

## Implementation notes

- Text is inserted with CDP `Input.insertText`, which dispatches real `input`
  events. React, Vue, and Slate all treat this as genuine typing.
- `Emulation.setFocusEmulationEnabled` is enabled per connection. Without it,
  Chrome silently drops synthesized key events when the browser window is not
  the OS-focused window — which breaks editors like Slate.
- Clearing a composer uses select-all via the Selection API followed by a real
  Backspace key event. A synthetic Meta+A does not select, and setting
  `innerHTML` directly desyncs Slate/React state.
- Discord renders the composer placeholder inside the editable as a
  `[data-slate-placeholder]` span, so it is stripped before reading the
  composer's text.
- Discord has two contenteditable elements in a channel view: the sidebar search
  box (`role="combobox"`) and the composer (`role="textbox"`). The focus logic
  always prefers `role="textbox"` and excludes navigation, so the search box is
  never typed into.
- The channel name is read from `[aria-label$="(channel)"]`, with
  `[aria-label^="Messages in"]` and the document title as fallbacks. Discord's
  header CSS class names change between releases; its aria-labels do not.
- Messages are extracted from `li[id^="chat-messages-"]`. Grouped messages omit
  the author element, so the author carries over from the previous message.
  Discord renders the composer placeholder and a visually-hidden timestamp
  inside the content, both of which are stripped.
- Scrolling to load history must use real wheel input. Assigning `scrollTop`
  fires no scroll event, so Discord never fetches; synthetic `WheelEvent`s are
  ignored by the compositor, so the list does not actually move.
  `Input.dispatchMouseEvent` with `type: "mouseWheel"` is what works.
- Progress is tracked by the id of the oldest message in the DOM. Discord
  prepends older messages as it loads them and unloads old ones as it scrolls
  away, so the message *count* in the DOM is not a usable signal.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BTY_PORT` | `9333` | Remote debugging port |
| `BTY_PROFILE` | `~/.bty/profile` | Chrome profile directory |
| `BTY_BROWSER` | auto | Path to the Chromium/Chrome binary |
| `BTY_KEYS` | unset | Type character by character instead of using `insertText` |

If the browser is not in the auto-detected list, set `BTY_BROWSER`:

```sh
export BTY_BROWSER="/Applications/Chromium.app/Contents/MacOS/Chromium"
```

## License

MIT
