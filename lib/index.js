/**
 * dsh-button-sample — host half.
 *
 * Two independent feature families live here, both served over loopback-only
 * routes the browser half calls.
 *
 * POWER (restart / quit), forked from `dsh-power-button`:
 *
 * - `GET  /api/dsh-button-sample/status` reports whether this Host runs as the
 *   child of a DSH desktop shell, i.e. whether restart/quit can work at all. The
 *   browser half renders nothing when it answers `supported: false`, so a
 *   terminal `dsh web` session never shows a button that cannot act.
 * - `POST /api/dsh-button-sample/action` accepts `{ action: "restart" | "quit" }`,
 *   starts the helper, and answers once the helper's bootstrap phase has
 *   reported success. The helper is what kills the shell and (for a restart)
 *   launches it again.
 *
 * Why a helper process instead of doing the work here: this Host process is a
 * child of the Electron main process (spawned over IPC at
 * `dsh-desktop-host/lib/index.js`). Killing the shell therefore kills this
 * process too, so the kill must be issued by something outside the shell's
 * process tree that also survives long enough to relaunch it. This module
 * starts that helper and the helper re-creates its real work through WMI, whose
 * children are parented to `WmiPrvSE.exe` and are therefore unreachable by
 * `taskkill /T`; see `lib/restart-helper.ps1` for the exact sequence and for
 * why a detached `spawn` alone does not escape the tree.
 *
 * The shell owns `app.relaunch()`, but no IPC channel exposes it to plugins
 * (`preload-app.cjs` publishes only browser/deviceInfo/keyboard/shortcuts/
 * updates), so a plugin can only reproduce a relaunch from the outside. The
 * relaunch reuses the shell's own recorded command line, so a development
 * launch with arguments restarts the same way it was started.
 *
 * CONTINUE, merged from `dsh-continue`:
 *
 * - `GET  /api/dsh-button-sample/continue-state?sessionId=` reports whether the
 *   last turn of that Session can be resumed with zero new prompt text.
 * - `POST /api/dsh-button-sample/continue` queues the transparent turn starter
 *   that performs the resume.
 *
 * The whole trick: the outgoing request must end with the *truncated assistant
 * message*, so the provider continues the prefix instead of answering anything
 * new. To get there without inserting a single character of new prompt text we
 * queue one message whose `source.kind` is `runtime-context`: `AgentLoop.step()`
 * uses that kind only as a turn starter and deliberately does NOT append it to
 * the session surface, so `deriveMessages()` never sees it and the history the
 * model receives is byte-identical to the one that was cut off.
 *
 * `agent/pre-step` then acts as a purity guard. That event runs as a waterfall:
 * every projection plugin (time-context, plan-mode, instructions,
 * session-reference) may append its own user message to `decision.messages`,
 * and those DO land on the session surface. A single trailing user turn is
 * enough to turn the provider's prefix continuation back into a fresh answer,
 * so on a continue round everything except our own nudge is dropped.
 *
 * @module dsh-button-sample
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Cordis plugin name; matches the `name` of the `insert` row in cordis.patch.yml
 * (that row's `id` is `ui-button-sample`, which is a different field). */
const name = "dsh-button-sample"

/** Services required by this plugin. */
const inject = ["webServer", "connection", "agents"]

/** Route paths, exact matches under the Host's origin. */
const ROUTE_STATUS = "/api/dsh-button-sample/status"
const ROUTE_ACTION = "/api/dsh-button-sample/action"
const ROUTE_CONFIG = "/api/dsh-button-sample/config"
const ROUTE_CONTINUE_STATE = "/api/dsh-button-sample/continue-state"
const ROUTE_CONTINUE = "/api/dsh-button-sample/continue"

/**
 * Per-interface visibility switches, with defaults.
 *
 * This plugin ships two independent interfaces — the floating draggable button
 * and the sidebar-foot power icon — and the plugin manager's own switch governs
 * the whole package rather than either interface. These two flags are therefore
 * what makes the interfaces separately hideable, and they are stored by this
 * Host so the choice survives a restart. Both default to on, so a first run
 * before any settings file exists shows both.
 */
const DEFAULT_UI_CONFIG = { floating: true, sidebar: true, continueButton: true }

/** Default JSON response headers. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
}

/**
 * How long the bootstrap may take before it is treated as failed.
 *
 * WMI creation is fast (the log shows bootstrap and worker start in the same
 * second); the latency a user sees is PowerShell's own cold start, which is
 * seconds at worst. This bound exists so a HUNG helper cannot leave the request
 * unanswered and the one-shot gate claimed forever.
 */
const BOOTSTRAP_TIMEOUT_MS = 30000

/**
 * Exit code the helper uses for a refusal it made before touching anything.
 *
 * Distinct from 1 (a failure mid-flight) on purpose: the caller may release the
 * one-shot gate for this code and must NOT for any other non-zero code, because
 * a mid-flight failure may still have killed the tree.
 */
const EXIT_REFUSED = 3

/** Largest accepted action body; the only valid body is a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/**
 * Business failure code for a second action while one is already running.
 *
 * Restart and quit kill the process tree, so a second request started while the
 * first is still being set up would put two workers on the same shell: the
 * second would find a half-dead pid, or both would race the relaunch. The
 * button disables itself while busy, but a second tab, a double submit or a
 * retry can still arrive here, so the guard belongs on the Host.
 */
const ALREADY_RUNNING = "already-running"

/**
 * Tunables accepted from the loader entry's `config` block, with defaults.
 *
 * These are the two timings that depend on the machine rather than on the code:
 * how long to let the HTTP response reach the browser before the shell dies
 * with it, and how long to wait for the shell to actually disappear. A slow or
 * heavily loaded machine may need larger values than these.
 */
const DEFAULT_CONFIG = { settleMs: 500, waitForExitSeconds: 20 }

/** Clamp one integer option to `[lo, hi]`, falling back on anything invalid. */
function intOption(value, lo, hi, fallback) {
  return Number.isInteger(value) && value >= lo && value <= hi ? value : fallback
}

/**
 * Resolve the effective config from a loader entry's `config` block.
 *
 * Read directly rather than through a schema service: the loader hands the
 * block over as plain data, and every option has a safe default, so an absent
 * or malformed block must not be able to stop the plugin from loading.
 *
 * @param raw - the loader entry's `config` value, normally undefined.
 * @returns the effective `{ settleMs, waitForExitSeconds }`.
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_CONFIG }
  return {
    settleMs: intOption(raw.settleMs, 0, 30000, DEFAULT_CONFIG.settleMs),
    waitForExitSeconds: intOption(raw.waitForExitSeconds, 1, 300, DEFAULT_CONFIG.waitForExitSeconds),
  }
}

/** Absolute path of the PowerShell helper shipped beside this module. */
const HELPER_PATH = fileURLToPath(new URL("./restart-helper.ps1", import.meta.url))

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  const parts = v4.split(".")
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === "::1") return true
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 *
 * The desktop shell reaches the Host through its own `dsh-app://app` protocol
 * handler, which strips `origin` and `sec-fetch-site` before forwarding and
 * authenticates with the Host cookie, so both paths below accept it.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== "string") return false
  let hostUrl
  try {
    hostUrl = new URL("http://" + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers["sec-fetch-site"] === "cross-site") return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a bounded JSON request body; undefined on malformed input. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/**
 * The desktop shell owning this Host, or undefined when this is not a desktop
 * launch.
 *
 * Three facts together identify the desktop topology, and each is required:
 * the process runs under the Electron binary in Node mode
 * (`ELECTRON_RUN_AS_NODE`), its entry is the desktop Host
 * (`dsh-desktop-host/lib/index.js`), and its parent is the Electron main
 * process. A terminal `dsh web` fails the first two; the packaged `dsh.cmd`
 * launcher also runs the Electron binary in Node mode but fails the second.
 *
 * `logDir` is resolved here and passed to the helper explicitly: a
 * WMI-created worker inherits neither this process's environment nor its
 * console, so it cannot work out `%DSH_HOME%` for itself.
 *
 * @returns `{ mainPid, hostPid, exePath, logDir }` or undefined.
 */
function desktopShell() {
  if (process.platform !== "win32") return undefined
  if (typeof process.versions.electron !== "string") return undefined
  const entry = process.argv[1] ?? ""
  if (!/dsh-desktop-host[\\/]lib[\\/]index\.js$/i.test(entry)) return undefined
  const mainPid = process.ppid
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return undefined
  return { mainPid, hostPid: process.pid, exePath: process.execPath, logDir: logDirectory() }
}

/**
 * Directory the helper writes its log to: `$DSH_HOME/logs`, else the temp dir.
 *
 * `DSH_HOME` is normally absent from the desktop Host's environment even though
 * the profile it was started from lives under `$DSH_HOME`. Relying on it alone
 * sent the log to `%TEMP%` on a real install, which is not where the README says
 * to look, so the profile path is used as a second source: the Host always
 * receives its profile directory as an argument, and that profile sits directly
 * under `$DSH_HOME\profiles`.
 *
 * @returns the absolute log directory, or `.` when nothing can be resolved.
 */
function logDirectory() {
  const home = process.env.DSH_HOME
  if (typeof home === "string" && home.trim() !== "") return `${home}\\logs`
  const derived = homeFromProfileArgument()
  if (derived !== undefined) return `${derived}\\logs`
  const temp = process.env.TEMP ?? process.env.TMP
  return typeof temp === "string" && temp !== "" ? temp : "."
}

/**
 * Recover `$DSH_HOME` from the Host's own profile argument.
 *
 * The profile directory is `<DSH_HOME>\profiles\<name>`, so walking two levels up
 * from it yields `$DSH_HOME` without guessing a default location.
 *
 * @returns the `$DSH_HOME` path, or undefined when it cannot be derived.
 */
function homeFromProfileArgument() {
  const profileDir = profileDirectory()
  if (profileDir === undefined) return undefined
  const cut = profileDir.lastIndexOf("\\")
  if (cut < 0) return undefined
  const home = profileDir.slice(0, cut).replace(/[\\/]profiles$/i, "")
  return home === "" || home === profileDir ? undefined : home
}

/** Windows PowerShell 5.1, present on every supported Windows release. */
function powershellPath() {
  const root = process.env.SystemRoot
  if (typeof root === "string" && root !== "") {
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }
  return "powershell.exe"
}

/**
 * Path of the helper's refusal marker, beside its log.
 *
 * @param logDir - the directory the helper logs to.
 * @returns the absolute marker path.
 */
function refusalMarkerPath(logDir) {
  return `${logDir}\\restart-button.refused`
}

/**
 * Whether the last launch recorded a refusal, and why.
 *
 * The marker is written only by a helper that stopped BEFORE touching any
 * process, and the launch path deletes it first, so its presence means "the most
 * recent attempt killed nothing and a retry is safe". This is what makes a
 * WORKER-phase refusal observable: the Host can only see the bootstrap's exit
 * code, and the identity guards run after the bootstrap has already exited 0.
 *
 * @param logDir - the directory the helper logs to.
 * @returns the recorded reason, or undefined when there was no refusal.
 */
function readRefusal(logDir) {
  try {
    const reason = readFileSync(refusalMarkerPath(logDir), "utf8").trim()
    return reason === "" ? "the helper refused the action" : reason
  } catch {
    return undefined
  }
}

/**
 * The launching environment's `DSH_*` variables, as a base64 JSON blob.
 *
 * The worker is created through WMI, which does not inherit this process's
 * environment, and it relaunches with `Start-Process`, which inherits the
 * WORKER's environment. Anything that existed only in the environment DSH was
 * started with is therefore lost across a restart.
 *
 * That matters: `DSH_HOME` is often set by whatever launched DSH and is not
 * written to the registry (measured on this machine: User and Machine both
 * empty, while the running process has it). Losing it silently moves the new
 * instance to a different profile root, which the user experiences as "my
 * sessions and settings are gone".
 *
 * Only `DSH_*` names are captured, and only name/value pairs: this is a
 * launcher-environment handoff, not a dump of the environment, and no other
 * variable is either needed or forwarded.
 *
 * @returns base64 of the JSON object, or an empty string when there is nothing
 *   to carry.
 */
function environmentBlob() {
  const captured = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("DSH_")) continue
    if (typeof value !== "string" || value === "") continue
    captured[key] = value
  }
  if (Object.keys(captured).length === 0) return ""
  return Buffer.from(JSON.stringify(captured), "utf8").toString("base64")
}

/**
 * Run the bootstrap that starts the restart/quit worker and wait for it.
 *
 * The helper has two phases (`lib/restart-helper.ps1`): this call runs the
 * BOOTSTRAP phase, which re-creates itself as a WORKER through
 * `Win32_Process.Create` and exits. Only the worker performs the kill, and
 * because a WMI-created process reports `WmiPrvSE.exe` as its parent it sits
 * outside the application's process tree, where `taskkill /T` cannot reach it.
 *
 * A detached `child_process.spawn` is deliberately not relied on here. It was
 * measured to work, but it does NOT escape: `detached` only starts a new
 * process group, the child still reports this process as its parent, and a
 * `taskkill /T` on the tree was measured to terminate it as well. Since the
 * helper's whole job is to kill the tree that contains this process, a
 * detached child would kill itself. `Win32_Process.Create` was measured to
 * parent the child to `WmiPrvSE.exe` instead, survive its creator's exit, and
 * finish its work.
 *
 * The bootstrap is awaited because its exit is what reports whether the WMI
 * call succeeded: without that the browser would be told "restarting" while
 * nothing had been started. It returns within a few hundred milliseconds.
 *
 * @param shell - resolved desktop shell facts.
 * @param action - `restart` or `quit`.
 * @param config - effective timings from the loader entry.
 * @returns `{ ok: true }` or `{ ok: false, error }`.
 */
function launchWorker(shell, action, config) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    HELPER_PATH,
    "-MainPid",
    String(shell.mainPid),
    "-HostPid",
    String(shell.hostPid),
    "-Mode",
    action,
    "-ExePath",
    shell.exePath,
    "-LogDir",
    shell.logDir,
    "-SettleMs",
    String(config.settleMs),
    "-WaitSeconds",
    String(config.waitForExitSeconds),
    "-EnvB64",
    environmentBlob(),
  ]
  // Clear the refusal marker first, so what is read afterwards can only have
  // been written by THIS launch.
  const marker = refusalMarkerPath(shell.logDir)
  try {
    unlinkSync(marker)
  } catch {
    /* absent is the normal case */
  }
  return new Promise((resolve) => {
    let child
    let settled = false
    let watchdog = null
    const finish = (outcome) => {
      if (settled) return
      settled = true
      if (watchdog !== null) clearTimeout(watchdog)
      resolve(outcome)
    }
    try {
      // Not detached: the bootstrap must be waited on, and it exits by itself
      // once the WMI worker exists. Its stdio is piped so a failure is logged.
      child = spawn(powershellPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Bounded: a hung PowerShell would otherwise never emit `close`, leaving the
    // request unanswered and -- because the gate is claimed before this call --
    // the UI permanently unable to try again. Nothing has been created yet, so a
    // retry is safe.
    watchdog = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, retryable: true, error: `bootstrap timeout after ${BOOTSTRAP_TIMEOUT_MS}ms` })
    }, BOOTSTRAP_TIMEOUT_MS)
    // A timeout is a normal outcome, not a reason to keep the process alive.
    if (typeof watchdog.unref === "function") watchdog.unref()
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2048)
    })
    child.stdout?.resume()
    child.once("error", (error) => {
      finish({ ok: false, retryable: true, error: error.message })
    })
    // The helper uses a dedicated exit code for the refusals it makes BEFORE it
    // touches anything (see `restart-helper.ps1`). Only that code, a spawn
    // failure and the timeout above mark the failure as safely retryable: any
    // other non-zero exit means the helper may already have killed the tree, and
    // clearing the gate there could start a second restart over the first.
    child.once("close", (code) => {
      if (code === 0) finish({ ok: true })
      else {
        finish({
          ok: false,
          retryable: code === EXIT_REFUSED,
          error: `bootstrap exit ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
        })
      }
    })
  })
}

/**
 * One-shot gate for the destructive actions.
 *
 * Once an action is accepted the process is going away, so the gate is never
 * released on success: it only clears if the worker could not be started at
 * all, which is the one case where a retry is meaningful.
 */
function createActionGate() {
  return { action: null, failed: false }
}

/** Accept only a real boolean, so a malformed body cannot flip a switch. */
function boolOption(value, fallback) {
  return typeof value === "boolean" ? value : fallback
}

/**
 * The profile directory this Host was started with, from its own arguments.
 *
 * The desktop Host is spawned as
 * `<entry> <dshRoot> <profileDir> <runtime> <pnpm> <bin>`, so the profile is the
 * FIRST argument shaped like `<something>\profiles\<name>`. It is located by
 * shape rather than by a fixed index on purpose: the launcher has inserted
 * arguments before (`--inspect` is added in development), and an index that is
 * off by one points at `dshRoot` — inside `app.asar`, which is a FILE, so every
 * write silently fails and the log lands in `%TEMP%`.
 *
 * @returns the absolute profile directory, or undefined when absent.
 */
function profileDirectory() {
  for (const argument of process.argv.slice(1)) {
    if (typeof argument !== "string") continue
    const normalized = argument.replace(/[\\/]+$/, "")
    if (/[\\/]profiles[\\/][^\\/]+$/i.test(normalized)) return normalized
  }
  return undefined
}

/**
 * The settings file holding the two interface switches.
 *
 * Kept beside the plugin's other host-side state under the profile directory the
 * Host was started with, so it is per-profile and removed with the profile.
 *
 * @returns the absolute path, or undefined when no profile directory is known.
 */
function configFilePath() {
  const profileDir = profileDirectory()
  if (profileDir === undefined) return undefined
  return `${profileDir}\\dsh-button-sample.json`
}

/**
 * Load the interface switches, falling back to the defaults.
 *
 * A missing, unreadable or malformed file yields the defaults rather than an
 * error: the switches are a convenience, and a broken file must never hide both
 * interfaces with no way back.
 *
 * @returns the effective `{ floating, sidebar, continueButton }`.
 */
function loadUiConfig() {
  const path = configFilePath()
  if (path === undefined) return { ...DEFAULT_UI_CONFIG }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_UI_CONFIG }
    return {
      floating: boolOption(parsed.floating, DEFAULT_UI_CONFIG.floating),
      sidebar: boolOption(parsed.sidebar, DEFAULT_UI_CONFIG.sidebar),
      continueButton: boolOption(parsed.continueButton, DEFAULT_UI_CONFIG.continueButton),
    }
  } catch {
    return { ...DEFAULT_UI_CONFIG }
  }
}

/** Persist the interface switches; returns the values now in force. */
function saveUiConfig(next) {
  const path = configFilePath()
  if (path === undefined) return next
  try {
    const dir = path.slice(0, path.lastIndexOf("\\"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  } catch {
    /* read-only profile: the switches apply to this session but do not persist */
  }
  return next
}

/**
 * Whether any agent is working right now, subagents included.
 *
 * `ctx.agents` is the process-wide agent registry, and a subagent is created
 * through the SAME registry as its parent (`ctx.agents.create({ parentAgent })`),
 * so `list()` returns both and no recursion is needed to include them. `status`
 * is the authoritative bit and already normalises the maintenance phase to
 * `idle`; a turn that is parked waiting for an approval or an answer still
 * reports `running`, which is exactly the case that must not be interrupted
 * silently.
 *
 * The read is deliberately defensive: the service is optional in the sense that
 * a Host build without it must still be able to restart, and an unreadable
 * registry must not be reported as "nothing is running". It returns `undefined`
 * for "cannot tell", which the browser treats as "ask the user", because
 * restarting during unseen work is the expensive mistake.
 *
 * @param ctx - the host plugin context.
 * @returns true/false, or undefined when the registry cannot be read.
 */
function agentsWorking(ctx) {
  try {
    const list = ctx.agents?.list?.()
    if (!Array.isArray(list)) return undefined
    return list.some((agent) => agent?.status === "running")
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* continue: session inspection                                        */
/* ------------------------------------------------------------------ */

/**
 * Turn endings that leave a resumable prefix (or at least a resumable prompt)
 * behind.
 *
 * The first three are the original `dsh-continue` set:
 *
 * - `max-tokens` is the real truncation.
 * - `aborted` / `interrupted` are the user pressing Stop mid-stream — the loop
 *   settles the partial text as an `assistant/message` with `interrupted: true`,
 *   so the very same prefill is sitting there.
 *
 * The next three extend the affordance to every *passive* stop, which is what
 * this fork exists for. They all settle the turn without the user asking for it:
 *
 * - `error` is a provider or transport failure (`RATE_LIMIT`, `SERVER`,
 *   `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `STREAM_CLOSED`, and anything else
 *   that surfaces as `LlmFailure`). The built-in `conversationContinuation`
 *   projection only admits six of those codes, so a failed turn outside that
 *   list would otherwise have no continue affordance at all.
 * - `blocked` is a pre-step rejection: nothing was generated because a gate
 *   refused the step. Continuing is still the user's call — the gate may have
 *   cleared by now.
 * - `forked` closes a turn that was copied into a branch.
 *
 * `completed` is deliberately absent: the turn reached its natural end and
 * there is nothing to resume.
 */
const CONTINUABLE_KINDS = new Set(["max-tokens", "aborted", "interrupted", "error", "blocked", "forked"])

/**
 * `MessageSourceMap` kind recognised by `AgentLoop.step()` as "starts a step,
 * never enters the surface". Using it is what keeps the outgoing request ending
 * on the truncated assistant message.
 */
const TRANSPARENT_KIND = "runtime-context"

/** Id prefix that marks the nudge as ours while it sits in the inbox. */
const NUDGE_PREFIX = "dsh-button-sample-"

/** Whether one queued inbox message is a continue nudge from this plugin. */
function isNudge(message) {
  return typeof message?.id === "string" && message.id.startsWith(NUDGE_PREFIX)
}

/**
 * When the last nudge was queued. A nudge normally gets claimed within
 * milliseconds; if the agent stays idle with one still pending (a wedged
 * wakeup), the button must come back instead of hanging hidden forever.
 */
let lastNudgeAt
const NUDGE_STALE_MS = 15_000

/** Committed events of one live agent's Session, newest API first. */
function eventsOf(agent) {
  try {
    if (typeof agent?.session?.snapshotEvents === "function") {
      const events = agent.session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    /* fall through */
  }
  try {
    if (Array.isArray(agent?.session?.events)) return agent.session.events
  } catch {
    /* ignore */
  }
  return []
}

/** The newest `turn/end` event and its index, or undefined. */
function lastTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/end") return { event: events[index], index }
  }
  return undefined
}

/** True while one of our nudges is still queued and not yet claimed by a step. */
function nudgeQueued(agent) {
  try {
    const inbox = agent?.inbox
    if (inbox === undefined || inbox === null) return false
    const queues = [inbox.nextTurn, inbox.nextStep]
    for (const queue of queues) {
      if (Array.isArray(queue) === false) continue
      for (const message of queue) if (isNudge(message)) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** A nudge that is still queued long after it was sent is not going to run. */
function nudgeStale() {
  if (lastNudgeAt === undefined) return false
  return Date.now() - lastNudgeAt > NUDGE_STALE_MS
}

/**
 * Did the turn leave assistant text behind? With text the next request ends on
 * that assistant message and the model continues the sentence. Without text
 * (an error before the first token, or Stop pressed before the first token) the
 * request ends on the user turn instead, which simply re-answers — still zero
 * new prompt text, just a resume rather than a prefill.
 */
function hasTrailingAssistant(events, endIndex) {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === "assistant/message") return true
    if (type === "turn/start") return false
  }
  return false
}

/** Whether the inbox still holds input this continue would collide with. */
function inboxPending(agent) {
  try {
    const inbox = agent?.inbox
    if (inbox === undefined || inbox === null) return false
    if (typeof inbox.hasPending === "function") return inbox.hasPending() === true
    if (typeof inbox.hasPending === "boolean") return inbox.hasPending
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Whether the continue affordance applies to one live agent.
 *
 * The button is meant to show exactly while the *finished* turn can still be
 * resumed: nothing generating, nothing queued, and a turning ending that left
 * something to continue. `queued` keeps a double click from stacking a second
 * nudge during the few milliseconds before the turn starts — but only while
 * that nudge is still fresh, so a wedged wakeup cannot hide the button.
 *
 * @param agent - the live agent, or undefined when the Session is not mounted.
 * @returns the facts both routes and the browser half read.
 */
function inspectContinue(agent) {
  if (agent === undefined || agent === null) {
    return {
      live: false, status: "absent", pending: false, canContinue: false,
      reason: undefined, turn: undefined, prefill: false,
    }
  }
  const events = eventsOf(agent)
  const found = lastTurnEnd(events)
  const end = found?.event
  const raw = end?.data?.reason
  const kind = typeof raw?.kind === "string" ? raw.kind : undefined
  const status = typeof agent.status === "string" ? agent.status : "unknown"
  const pending = inboxPending(agent)
  const queued = nudgeQueued(agent) && !nudgeStale()
  const resumable = kind !== undefined && CONTINUABLE_KINDS.has(kind)
  const canContinue = status === "idle" && pending === false && queued === false && resumable
  const reason = kind === undefined ? undefined : { kind }
  if (kind === "error" && raw?.error !== undefined && raw.error !== null) {
    /* Surface only what the browser can show; the failure text can be long. */
    reason.code = typeof raw.error.code === "string" ? raw.error.code : undefined
    reason.message = typeof raw.error.message === "string" ? raw.error.message.slice(0, 400) : undefined
  }
  return {
    live: true,
    status,
    pending,
    nudgeQueued: queued,
    resumable,
    reason,
    turn: typeof end?.data?.turn === "number" ? end.data.turn : undefined,
    canContinue,
    /* true → the model continues the sentence; false → it answers again. */
    prefill: resumable && found !== undefined && hasTrailingAssistant(events, found.index),
  }
}

/**
 * A message that starts a turn but is never written to the transcript.
 * Content is irrelevant (it is not appended and not serialized); it only has
 * to satisfy the inbox's shape assumptions.
 */
function transparentNudge() {
  return {
    id: `${NUDGE_PREFIX}${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: " " }],
    source: { kind: TRANSPARENT_KIND, form: "snapshot", sections: [] },
  }
}

/**
 * Queue the transparent turn starter for one agent.
 *
 * @param agent - the live agent to resume.
 * @returns `{ ok: true }` or `{ ok: false, error }` with a readable cause.
 */
function triggerContinue(agent) {
  if (agent === undefined || agent === null) return { ok: false, error: "session is not live" }
  const state = inspectContinue(agent)
  if (!state.canContinue) {
    return {
      ok: false,
      error: `nothing to continue (status=${state.status}, reason=${state.reason?.kind ?? "none"})`,
    }
  }
  try {
    agent.followup(transparentNudge())
    lastNudgeAt = Date.now()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

/**
 * The purity guard for a continue round.
 *
 * `agent/pre-step` runs as a waterfall: every projection plugin may append its
 * own user message to `decision.messages`, and those DO land on the session
 * surface. A single trailing user turn is enough to turn the provider's prefix
 * continuation back into a fresh answer, so on a continue round everything
 * except our own nudge is dropped. `prepend: true` places us before the other
 * listeners so our `next()` call wraps them and we observe the assembled
 * decision.
 *
 * @param ctx - the host plugin context.
 */
function installPurityGuard(ctx) {
  ctx.on(
    "agent/pre-step",
    async (_payload, next) => {
      const decision = await next()
      if (decision?.kind !== "enter") return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      const nudge = messages.find(isNudge)
      if (nudge === undefined) return decision
      /* The user typed something too: let the ordinary turn run. */
      const human = messages.some((message) => message !== nudge && message?.source?.kind === "user")
      if (human) return decision
      if (messages.length === 1) return decision
      return { ...decision, messages: [nudge] }
    },
    { prepend: true },
  )
}

/**
 * Build the restart-button route family.
 *
 * @param ctx - the host plugin context (its `connection` is read per request).
 * @param shell - lazily resolved desktop shell facts.
 * @param gate - shared one-shot action gate.
 * @param config - effective timings from the loader entry.
 * @param uiConfig - live interface switches; read on GET, mutated on POST.
 * @returns the exact routes to register on `webServer`.
 */function makeRoutes(ctx, shell, gate, config, uiConfig) {
  /**
   * The Host's own trust fence, applied before anything else.
   *
   * An EXACT route is dispatched before the `/api` PREFIX table, so these routes
   * would otherwise SHADOW the authentication the Host puts on every other
   * `/api` endpoint — measured: without a cookie `/api/session/list` answers 401
   * while this plugin's routes answered 200. `requestRejection` is the Host's own
   * authority (Host/Origin fence plus the browser auth cookie, and on the desktop
   * build whatever the shell injects), so reusing it keeps this plugin inside the
   * same permission model instead of beside it.
   *
   * The service is read from the LIVE context on every request rather than
   * captured once, matching the Host's own `connectionOf(ctx)` helper: a
   * reference taken at mount time could outlive a service restart.
   *
   * @returns true when the request was rejected and a response was sent.
   */
  const rejected = (req, res) => {
    const status = ctx.connection?.requestRejection?.(req)
    if (status === undefined || status === null) return false
    writeJson(res, status, {
      ok: false,
      code: status === 401 ? "unauthenticated" : "forbidden",
    })
    return true
  }

  /**
   * The gate every route passes before it does anything.
   *
   * All three routes need the same four steps in the same order — method
   * discipline, the Host's own trust fence, the loopback fence, and only then the
   * work — and each was written out separately. Three copies of an authorization
   * sequence is three chances for one of them to be edited into a hole, and the
   * order is load-bearing: the fence must come before the loopback check, or a
   * request the Host would have refused is answered by the loopback branch instead.
   *
   * @param req - the incoming request.
   * @param res - the response to answer on.
   * @param methods - exact methods this route accepts.
   * @returns true when the request was already answered and the handler must stop.
   */
  const fenced = (req, res, methods) => {
    if (!methods.includes(req.method)) {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
      res.end("method not allowed")
      return true
    }
    if (rejected(req, res)) return true
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: "forbidden" })
      return true
    }
    return false
  }

  const handleStatus = (req, res) => {
    if (fenced(req, res, ["GET"])) return
    const facts = shell()
    writeJson(res, 200, {
      ok: true,
      supported: facts !== undefined,
      platform: process.platform,
      ...(gate.action !== null ? { busy: gate.action } : {}),
      ...(facts === undefined ? { reason: "not-desktop" } : {}),
      // A refusal the worker recorded but the Host could not observe at launch time.
      //
      // DIAGNOSTIC, not a UI channel: the browser half deliberately does not read it,
      // because the user learns the reason where it matters — on the retry, whose 500
      // carries the same text as `reason` and is shown in the menu. Emitting it here
      // still earns its place: it makes the stranded state visible to an operator (or
      // a future UI) BEFORE a click, which is the difference between "the button does
      // nothing" and "the button is blocked, here is why".
      ...(facts === undefined ? {} : { refused: readRefusal(facts.logDir) }),
      // Whether the extra confirmation is warranted, i.e. whether any agent
      // (subagents included) is working. This is a REPORT, not a policy: the menu
      // decides what to do with it, and the Host deliberately does not refuse the
      // action on it — a user may still mean to restart while work is running, and
      // the confirmation is what gives them the chance to say so.
      working: agentsWorking(ctx),
    })
  }

  /**
   * Read or write the interface switches.
   *
   * Deliberately independent of the desktop check: the switches describe which
   * interfaces to draw, and they must stay readable and writable even where the
   * power actions cannot run, otherwise the configuration page would be dead on
   * a terminal launch.
   */
  const handleConfig = async (req, res) => {
    if (fenced(req, res, ["GET", "POST"])) return
    if (req.method === "GET") {
      writeJson(res, 200, { ok: true, ...uiConfig.value })
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined || body === null || typeof body !== "object") {
      writeJson(res, 400, { ok: false, code: "bad-config" })
      return
    }
    // A patch: only the keys actually present are changed.
    const next = {
      floating: boolOption(body.floating, uiConfig.value.floating),
      sidebar: boolOption(body.sidebar, uiConfig.value.sidebar),
      continueButton: boolOption(body.continueButton, uiConfig.value.continueButton),
    }
    uiConfig.value = saveUiConfig(next)
    writeJson(res, 200, { ok: true, ...uiConfig.value })
  }

  const handleAction = async (req, res) => {
    if (fenced(req, res, ["POST"])) return
    const facts = shell()
    if (facts === undefined) {
      writeJson(res, 409, { ok: false, code: "unsupported", reason: "not-desktop" })
      return
    }
    const body = await readJsonBody(req)
    const action = body?.action
    if (action !== "restart" && action !== "quit") {
      writeJson(res, 400, { ok: false, code: "bad-action" })
      return
    }
    // Claim the gate before doing any work, so two near-simultaneous requests
    // cannot both get past this point: Node runs this handler to its first
    // await above, and the check-then-set below has no await between them.
    if (gate.action !== null && !gate.failed) {
      // Self-healing for a WORKER-phase refusal.
      //
      // The identity and relaunch-target guards run in the worker, after the
      // bootstrap has already exited 0 -- so the Host cannot see them when it
      // decides whether to release the gate. The worker records such a refusal
      // in a marker file instead, and it is read HERE, when the user tries again:
      // by then the worker has long since finished, so the answer is stable.
      //
      // This ordering is deliberate. Checking at launch time would mean waiting
      // for the worker, and the whole point of the bootstrap handshake is that
      // the HTTP response returns immediately -- the page must survive long
      // enough to receive it before the shell dies.
      const refusal = readRefusal(facts.logDir)
      if (refusal !== undefined) {
        gate.action = null
        gate.failed = true
        writeJson(res, 500, { ok: false, code: "refused", reason: refusal })
        return
      }
      writeJson(res, 409, { ok: false, code: ALREADY_RUNNING, reason: gate.action })
      return
    }
    gate.action = action
    gate.failed = false
    const launched = await launchWorker(facts, action, config)
    if (!launched.ok) {
      // Release the gate only when a retry is provably safe. `retryable` is set
      // for a spawn failure, a bootstrap timeout and the helper's dedicated
      // refusal code -- all of which happen before anything is killed. A failure
      // AFTER the kill keeps the gate claimed, because the process is already
      // going away and a second attempt would race the first.
      if (launched.retryable) {
        gate.action = null
        gate.failed = true
      }
      writeJson(res, 500, { ok: false, code: "spawn-failed", reason: launched.error })
      return
    }
    writeJson(res, 200, { ok: true, action })
  }

  /**
   * Report whether one Session's last turn can be resumed.
   *
   * A dead `sessionId` is not an error: the browser polls this per mounted
   * Session, and "this Session is gone" is the same answer as "nothing to
   * continue" — the button simply stays hidden.
   */
  const handleContinueState = (req, res) => {
    if (fenced(req, res, ["GET"])) return
    const url = new URL(req.url ?? ROUTE_CONTINUE_STATE, "http://127.0.0.1")
    const sessionId = url.searchParams.get("sessionId") ?? ""
    const agent = sessionId.length > 0 ? ctx.agents?.get?.(sessionId) : undefined
    const state = inspectContinue(agent)
    writeJson(res, 200, {
      ok: true,
      sessionId,
      enabled: uiConfig.value.continueButton !== false,
      ...state,
    })
  }

  /**
   * Queue the transparent turn starter.
   *
   * 409 for "nothing to continue" on purpose: it is a state conflict rather than
   * a malformed request, and the browser half uses that to fade the button back
   * instead of showing a failure.
   */
  const handleContinue = async (req, res) => {
    if (fenced(req, res, ["POST"])) return
    const body = await readJsonBody(req)
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
    if (sessionId.length === 0) {
      writeJson(res, 400, { ok: false, code: "bad-session", reason: "sessionId is required" })
      return
    }
    const agent = ctx.agents?.get?.(sessionId)
    const result = triggerContinue(agent)
    const state = inspectContinue(agent)
    writeJson(res, result.ok ? 200 : 409, {
      ...result,
      ...(result.ok ? {} : { code: "not-continuable" }),
      sessionId,
      state,
    })
  }

  return [
    { kind: "exact", path: ROUTE_STATUS, handler: handleStatus },
    { kind: "exact", path: ROUTE_ACTION, handler: handleAction },
    { kind: "exact", path: ROUTE_CONFIG, handler: handleConfig },
    { kind: "exact", path: ROUTE_CONTINUE_STATE, handler: handleContinueState },
    { kind: "exact", path: ROUTE_CONTINUE, handler: handleContinue },
  ]
}


/**
 * Mount the power control routes and the continue routes.
 *
 * @param ctx - host plugin context carrying the web server and connection.
 * @param rawConfig - the loader entry's optional `config` block.
 */
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const gate = createActionGate()
  const uiConfig = { value: loadUiConfig() }
  const routes = makeRoutes(ctx, desktopShell, gate, config, uiConfig)
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, "button-sample: control routes")

  installPurityGuard(ctx)
}

export { apply, inject, name }
