# dsh-button-sample

![platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![language: JavaScript](https://img.shields.io/badge/language-JavaScript-F7DF1E)
![helper: PowerShell](https://img.shields.io/badge/helper-PowerShell-5391FE)
![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

[简体中文](README.md) ・ **English**

Three additions to the **DSH desktop GUI** (DeepSeek Harness Desktop) in one bundle, each
switchable on its own:

- **Floating power button** — draggable; snapping it to a side edge collapses it into a thin
  strip that re-expands on hover. Clicking opens a "Restart DSH / Quit DSH" menu.
- **Sidebar power icon** — sits in the sidebar's account row, left of the avatar, and opens the
  same menu.
- **Continue button** — a play triangle at the right of the composer. It appears when the last
  turn was **cut off by the length limit**, **stopped by hand**, or **ended with an error**, and
  one click carries on without typing anything.
- **Stop ring** — when "Stop generating" is pressed but the turn does not end immediately, a ring
  turns around the button to say "the click registered, it is stopping".

```
drag → snap to an edge → hover to expand → click → (confirm only if work is running) → restart or quit
truncated / stopped / failed → a ▶ appears beside the composer → click → the model carries on
press "Stop generating" → not instant → ring turns → gone once the turn settles
```

The desktop build has no in-window restart entry: the tray item only appears in development
builds, so a release build means quitting and reopening from the Start menu. This bundle covers
that gap, and the continue button covers the other one — a turn that stopped early and left you
with nothing to reply to.

- **Windows only**: the power half needs `taskkill`, WMI and the bundled Windows PowerShell 5.1.
  Continue is platform-neutral, but it ships in the same package, which therefore declares
  `os: win32`.
- **No dependencies**: plain JavaScript, importing no Harness client package.
- **No reading other plugins' DOM or styles**: all three seats are official slots
  (`sidebar.footer.action`, `conversation.input.right`, `plugins.bundle.config`). The stop ring is
  the single DOM observation, described below.

---

## Install

### As a profile bundle (recommended; verified on this machine)

```powershell
# 1) put it in the profile's vendor directory
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-button-sample"
git clone https://github.com/aeclic/dsh-button-sample.git $dst

# 2) teach the profile about it, in $env:USERPROFILE\.dsh\profiles\desktop\package.json:
#    - add "dsh-button-sample" to dsh.profile.bundles
#    - add "dsh-button-sample": "file:vendor/dsh-button-sample" to dependencies
```

Then enable **dsh-button-sample** under Settings → Plugins.

### Directly into node_modules

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-button-sample"
git clone https://github.com/aeclic/dsh-button-sample.git $dst
```

Equivalent to the above, minus the bundler's dependency bookkeeping; delete the directory before
upgrading.

**Restart DSH** afterwards. All three interfaces should be present: the power icon at the sidebar
foot, the continue button at the right of the composer (only while a turn can be continued), and
three switches on the bundle's own page.

---

## The three switches

The bundle's settings page has three independent rows, stored in `<profile>/dsh-button-sample.json`:

| Switch | Default | When off |
| --- | --- | --- |
| Floating power button | on | the floating control disappears; the sidebar icon is unaffected |
| Sidebar power icon | on | the sidebar icon disappears |
| Continue button | on | no play triangle beside the composer |

The plugin card's own switch governs the whole package; these three govern the interfaces inside it.

---

## When Continue is available

The button appears only when the last turn has finished AND still has something to continue. The
decision reads `reason.kind` of the newest `turn/end`:

| Ending | Button | What a click does |
| --- | --- | --- |
| `max-tokens` | yes | continues the cut-off sentence |
| `aborted` / `interrupted` (Stop) | yes | continues from where it stopped |
| `error` (rate limit, server error, timeout, transport loss, empty response, closed stream, …) | yes | continues from the break; re-answers if the turn produced no token at all |
| `blocked` (a step was refused by admission) | yes | starts that turn again |
| `forked` | yes | continues on the forked branch |
| `completed` | no | the turn reached its natural end |

The tooltip names which case applies. "Generate again" is the wording used when no assistant text
survived the turn — it is honest about being a re-answer rather than a continuation.

### Why an error can be continued

DSH's own `conversationContinuation` projection admits exactly six failure codes (`RATE_LIMIT`,
`SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `STREAM_CLOSED`). Every other failure — an
unclassified upstream 5xx, a tool activation failure, `UNKNOWN` — has no continue affordance in
the shipped logic. This bundle widens the test to "any ending that is not `completed`", because in
all of those cases the history still ends on a continuable prefix and the user's intent is the
same: carry on.

### How it works (without adding a character of prompt)

The constraint is absolute: the outgoing request must end on the **truncated assistant message**,
or the model answers afresh instead of continuing the prefix. Nothing new may be typed into the
prompt.

So the host queues one message whose `source.kind` is `runtime-context`. `AgentLoop.step()` uses
that kind only as a turn starter and deliberately does **not** append it to the session surface, so
`deriveMessages()` never sees it and the history the model receives is byte-identical to the one
that was cut off.

That alone is not enough: `agent/pre-step` is a waterfall, and the projection plugins
(time-context, plan-mode, instructions, session-reference) each may append their own user message
to `decision.messages` — and **those do land on the surface**. A single trailing user message turns
prefix continuation back into a fresh answer. This bundle therefore listens with
`{ prepend: true }`, wrapping the other listeners, and drops everything except its own nudge from
the assembled decision.

(If the user typed something in that same step, the batch is let through untouched: the intent
there is plainly to send an ordinary message.)

---

## The stop ring

"Stop generating" is **asynchronous**: the click hands a cancellation request to the Host, and the
turn settles only when the stream actually closes. For those few hundred milliseconds the button
looks exactly like one that did nothing, so people press it again.

This bundle draws nothing at press time and waits **350 ms**:

- If the turn settles inside that window (the common case — the composer swaps the button back to
  Send), **no ring is drawn**. It does not invent a wait that never happened.
- Otherwise a turning ring is parked around the button, following its rect, until the button goes
  away, its label stops being a Stop label, or a 15-second backstop fires.

So the ring says exactly one thing: "your click landed, it is still stopping".

Two deliberate choices in the implementation:

1. **The ring is a page-level `position: fixed` overlay, not a child of the button.** React owns
   that button's subtree, so an injected node gets swept away on the next reconciliation; and
   making the button `position: relative` to host an absolutely positioned child would mean
   mutating a control this plugin does not render. The overlay is positioned from the button's own
   `getBoundingClientRect()` and touches neither.
2. **The press is read in the CAPTURE phase on `document`.** Whatever the button's own React
   handler does — throw, no-op — cannot affect the ring, which is precisely the question being
   answered.

The Stop button carries no data attribute of its own, so the only stable handle is its
`aria-label`; the package lists the "stop generating" string from all eight locales DSH ships. A
new locale needs one more line there.

---

## Known limits

- **Windows only** (the whole package declares `os: win32`), because the power half needs
  `taskkill` / WMI / PowerShell 5.1.
- **Continue depends on the `runtime-context` internal convention.** It holds on 0.2.2-rc.5 as
  measured here. If upstream changes how `AgentLoop.step()` treats that kind, continuation degrades
  into a fresh answer — no error, just a worse outcome.
- **The 350 ms grace period is empirical.** On a slow link the ring appears sooner; on a very fast
  machine it may never be visible. Neither affects correctness.
- **The stop ring does not know custom language packs**: a translation not in the list leaves the
  Stop button unrecognised, and no ring appears. One line fixes it.

---

## Development

`lib/` is the **shipped artifact**; there is no build step. After a change:

```sh
node test/run.cjs
```

All five suites drive the real `lib/` files through hand-written doubles for the Cordis context,
the DOM and the clock:

| Suite | Covers |
| --- | --- |
| `bundle.test.cjs` | browser-half factory shape, slot registration, disposal |
| `guard.test.cjs` | the `agent/pre-step` purity guard across five shapes |
| `host.test.cjs` | the continue decision matrix, both routes, the trust fence, config writes |
| `continue-button.test.cjs` | visibility, per-ending copy, click, busy, failure, unmount |
| `stop-ring.test.cjs` | grace period, overlay geometry, following, four clear paths, backstop, disposal |

---

## Provenance and licence

MIT. This repository is **forked from
[WhichWitchWin/dsh-power-button](https://github.com/WhichWitchWin/dsh-power-button)** — the whole
power half, `lib/restart-helper.ps1` included, comes from upstream — and merges the continue
feature from `dsh-continue`. On top of that it makes two extensions: the continuable endings go
from three to six, and the stop ring is new.

Upstream's engineering notes remain in `docs/DESIGN.md`, which records the evidence and
measurements behind every counter-intuitive decision in the power half. The two fork-specific
features are documented above.
