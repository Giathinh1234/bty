---
name: bty
description: Drive a dedicated Chromium window from the terminal over CDP. Use when the user wants to type into a browser from the terminal, send Discord messages, fill web forms, or let the AI act in one specific browser tab in its own window.
---

# bty — terminal-driven browser control

`bty` drives a dedicated Chromium window over the Chrome DevTools Protocol.
No extension, no browser-side agent code. It is a CLI, so any agent with shell
access can use it.

Binary: `bty` on your `PATH` (this machine: `~/.local/bin/bty` → `~/tools/bty/bty.mjs`)
Profile: `~/.bty/profile` — a separate Chrome profile, so the session is
isolated from the user's everyday browsing.

## Quick start

Most work is one of these five commands:

```sh
bty status                        # is it running? which tab is pinned?
bty lock                          # pin that tab for the rest of the session
bty history 20                    # read the last 20 messages
bty where                         # confirm which channel the composer is in
bty msg --in "#ai" "text"         # send
```

If `bty status` says it is not running, run `bty start` and ask the user to log
in (`bty login`). Never ask for their password or 2FA code.

## Setup (once)

```sh
bty start          # launches the dedicated window at discord.com/app
bty login          # opens Discord login in that window; log in there manually
```

The Discord session persists in `~/.bty/profile`, so login is a one-time step.
The user must complete it themselves — never ask for their password or 2FA code.

## Locking the AI to one tab

```sh
bty lock           # lock to the current tab
bty status         # shows the locked target
bty use --unlock   # release the lock
```

While locked, `bty use <other>` and `bty newtab` are refused, so the agent
cannot wander to another tab. Use `bty start --app` for a chromeless window
that holds exactly one URL with no tab strip at all.

## Sending Discord messages

```sh
bty msg "hello"                     # focus composer, type, press Enter (sends)
bty msg --draft "hello"             # type but do NOT send
bty msg --in "#general" "hello"     # only send if the composer is in #general
bty msg --replace "hello"           # overwrite whatever is in the composer
bty msg --append " more"            # add to existing composer text
bty msg --replace ""                # clear the composer without sending
```

Safety rules for `bty msg`:

- Always pass `--in "<channel>"` when you know the target channel. If the
  composer is in a different channel the command refuses and sends nothing.
- If the composer already has text, the command refuses unless you pass
  `--replace` or `--append`. Never blindly `--replace` — the user may have
  written something.
- Prefer `--draft` when the user is not explicitly asking to send. Let them
  review before it goes out.

## Reading before writing

```sh
bty where                            # which channel/guild the tab is in
bty history                          # last 20 messages
bty history 50                       # last 50 messages
bty history --all                    # entire channel history (slow: minutes)
bty history --json                   # machine-readable
bty history --raw                    # text only, no timestamps
bty eval "document.title"            # run JS, get JSON back
bty read "body"                      # print visible text
bty read "#some-selector"
bty shot /tmp/shot.png               # screenshot (read it to verify visually)
bty status                           # list pages, show the pinned target
```

Always verify state before sending. `bty status` shows which tab is pinned and
`bty where` shows which Discord channel the composer is in.

`bty history` walks backwards by scrolling the message list, because Discord
only renders part of a channel at a time. It restores the view afterwards.
`--all` reloads the channel first (Discord caches history per view) and takes
several minutes on a large channel.

## General page control

```sh
bty open "https://example.com"   # navigate the pinned tab
bty focus "#input"                # focus an element
bty type "some text"              # type into the focused element
bty key Enter                     # press a key
bty click "button.submit"         # click
bty newtab "https://example.com"  # open a new tab and pin it (blocked while locked)
bty use <targetId>                # pin a specific tab (see bty tabs)
```

## Notes and gotchas

- `bty start` pins one tab. `bty tabs` lists all page targets; `bty use <id>`
  re-pins. Keep commands pointed at the tab the user cares about.
- Text is inserted with CDP `Input.insertText`, which fires real `input`
  events — React, Vue, and Slate editors all see it as genuine typing.
- Newlines in a message are inserted as literal `\n` inside the insertText
  payload. This produces the correct multi-line value in Slate-based editors.
- The window is real and visible on screen. The user can watch and intervene
  at any time, and can take over by typing in it.
- `bty stop` closes the dedicated window. The profile and login persist.
- `bty tabs` output is column-stable: field 1 is the marker (`*` pinned,
  `-` other), field 2 is the target id.
