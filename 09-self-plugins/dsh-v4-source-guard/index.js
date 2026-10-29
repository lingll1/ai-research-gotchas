/**
 * v4-source-guard — keep session format v4 healthy at the *write* boundary.
 *
 * WHY THIS EXISTS
 * Session format v4 retired the v3 message-source shape: the literal kind `plugin` carried next
 * to a `plugin` field. The validator (`dsh-session-format-v3-to-v4`) now requires a
 * producer-owned kind such as `"plugin:X"`, `"runtime-context"` or `"schedule"`, and it rejects
 * the bare `plugin` kind whenever a session artifact is validated or restored. Writers are not
 * checked, so a bare source is happily appended and only explodes later — surfacing as
 * "this run failed" right after the user sends a message.
 *
 * Every occurrence so far came from third-party plugins that emit v3-shaped sources
 * (graphflow, hindsight, upstream-radar …). The file-level fix (`D:\dsh\fix-v4-source-kind.py`)
 * rewrites those packages, but `dsh plugin add` / the plugin manager re-materialise them from
 * the pnpm store and silently undo the patch — this bug has already recurred four times.
 *
 * This plugin closes the hole where it cannot be closed by file edits: `Session.prototype.append`
 * is the single funnel every session event goes through (the agent loop appends pre-step
 * injected messages as `user/message` with `surfaceOp: "append"`, right there in
 * `dsh-agent-loop/lib/index.js`). We normalise the retired source shape immediately before the
 * original `append` snapshots and validates the event, so no matter which plugin produces the
 * message — freshly reinstalled, hot-loaded, or version-bumped — the log only ever receives
 * canonical v4 sources.
 *
 * WHAT IT DOES NOT DO
 * It cannot repair logs that are already poisoned: the reader validates before any plugin code
 * runs. Those need the artifact-level rewrite in `fix-v4-source-kind.py`.
 *
 * On startup this plugin also re-runs that file-level fixer in the background. A plugin
 * install/update re-materialises the offenders from the pnpm store and breaks their hardlinks,
 * so the launcher runs the fixer before the app starts and this self-heal repairs any later
 * install without a manual command.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const name = "v4-source-guard";

/** Wait for the store to exist before installing the patch. */
export const inject = ["sessions"];

/** Marks an `append` implementation (and the prototype holding it) as already wrapped. */
const PATCHED = Symbol.for("dsh-v4-source-guard/patched");

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Producer mapping copied verbatim from
 * `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` (migration of released v3 plugins).
 * Kept in sync deliberately: using a different mapping would rewrite a legacy source into a
 * kind the validator accepts but that no longer means what it used to.
 */
const RENAMED_PRODUCERS = Object.freeze({
  compact: "compact-checkpoint",
  "tools-code-mode": "ptc-mode",
  "tools-ptc": "ptc-mode",
  "dsh-compaction-basic": "compact-basic",
  "@deepseek-ai/dsh-system-prompt": "runtime-context",
});

/** First-party v3 plugin identities that intentionally keep their own name as the kind. */
const RELEASED_SAME_NAME_PRODUCERS = new Set([
  "agent-instructions",
  "session-reference",
  "team-message",
  "goal",
  "skill-invocation",
  "skill-catalog",
  "coordinator",
  "subagent-report",
  "subagent-settled",
  "webhook",
  "agent-message",
  "model-selection",
  "plan-mode",
  "time-context",
  "tmux-context",
  "user-approval",
  "repeat-tool-reminder",
  "tool-cordis",
  "cordis-host-runner",
  "tool-goal",
  "tool-jobs",
  "hooks-codex",
  "hooks-claude-code",
  "schedule",
  "dsh-session-title-llm",
]);

/** Resolve the v4 producer kind for one released v3 plugin string. */
function producerKind(plugin, role) {
  if (plugin === "@deepseek-ai/dsh-system-prompt" && role === "system") {
    return "system-prompt";
  }
  const renamed = RENAMED_PRODUCERS[plugin];
  if (renamed !== undefined) return renamed;
  if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin;
  return `plugin:${plugin}`;
}

/** The retired v3 source kind, spelled once so a naive source-kind grep stays clean. */
const RETIRED_KIND = "plugin";

/**
 * Rewrite one message source. Returns the input unchanged (identity) when there is nothing to
 * do, so the caller can skip reallocating.
 */
function normalizeSource(source, role) {
  if (!isRecord(source) || source.kind !== RETIRED_KIND) return source;
  const plugin = source.plugin;
  // Not a legacy plugin source: let the real validator complain about it.
  if (typeof plugin !== "string" || plugin.length === 0) return source;
  const { plugin: _retiredField, ...rest } = source;
  return { ...rest, kind: producerKind(plugin, role) };
}

function normalizeMessage(message) {
  if (!isRecord(message)) return message;
  const source = message.source;
  const next = normalizeSource(source, message.role);
  return next === source ? message : { ...message, source: next };
}

function normalizeMessageList(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((message) => {
    const normalized = normalizeMessage(message);
    if (normalized !== message) changed = true;
    return normalized;
  });
  return changed ? next : list;
}

/**
 * Apply the normalisation to exactly the slots that `mapEventMessages` in
 * `dsh-session-format-v3-to-v4` treats as message carriers. Anything else is passed through
 * untouched (and identity-equal), so unchanged appends keep their zero-copy behaviour.
 */
function normalizeEventData(type, data) {
  if (!isRecord(data)) return data;
  switch (type) {
    case "user/message":
      return normalizeMessage(data);
    case "developer/message":
    case "system/message":
    case "assistant/message":
    case "tool/result": {
      const message = normalizeMessage(data.message);
      return message === data.message ? data : { ...data, message };
    }
    case "agent/inbox/spliced": {
      const inserted = normalizeMessageList(data.inserted);
      return inserted === data.inserted ? data : { ...data, inserted };
    }
    case "session/title-llm-request": {
      const messages = normalizeMessageList(data.messages);
      return messages === data.messages ? data : { ...data, messages };
    }
    default:
      return data;
  }
}

/** Wrap one `append` implementation; idempotent. */
function wrapAppend(original) {
  if (typeof original !== "function" || original[PATCHED]) return original;
  const patched = function append(type, data, ...rest) {
    let next;
    try {
      next = normalizeEventData(type, data);
    } catch {
      // Never let the guard break an append; fall back to the caller's payload.
      next = data;
    }
    return original.call(this, type, next, ...rest);
  };
  Object.defineProperty(patched, "name", { value: "append" });
  Object.defineProperty(patched, PATCHED, { value: true });
  return patched;
}

/**
 * Patch `Session.prototype.append` once any live session is available. Returns whether the
 * prototype now carries the wrapper.
 */
function patchSessionPrototype(proto) {
  if (!proto || typeof proto !== "object") return false;
  if (proto[PATCHED] === true) return true;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "append");
  if (!descriptor || typeof descriptor.value !== "function") return false;
  const patched = wrapAppend(descriptor.value);
  if (patched === descriptor.value) return false;
  Object.defineProperty(proto, "append", { ...descriptor, value: patched });
  Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  return true;
}

/** Patch one session — via its prototype when possible, as an own property otherwise. */
function patchSession(session) {
  if (!session || typeof session !== "object") return false;
  if (patchSessionPrototype(Object.getPrototypeOf(session))) return true;
  if (session[PATCHED] === true) return true;
  const append = session.append;
  if (typeof append !== "function") return false;
  Object.defineProperty(session, "append", {
    value: wrapAppend(append),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(session, PATCHED, { value: true, configurable: true });
  return true;
}

/** stderr, because headless prints its answer on stdout. */
function log(message) {
  try {
    process.stderr.write(`[v4-source-guard] ${message}\n`);
  } catch {
    /* diagnostics must never fail the plugin */
  }
}

/**
 * Optional artifact-level fixer. Both paths are environment-driven: there is no
 * sensible default, because the repair script is site-specific and the profile
 * directory differs per user. Unset = the fixer is skipped, the plugin still
 * normalizes `Session.append` sources in memory.
 */
const FIX_SCRIPT = process.env.DSH_V4_FIX_SCRIPT ?? "";
const FIX_PROFILE = process.env.DSH_V4_PROFILE ?? "";
const FIX_TIMEOUT_MS = 60_000;
const FIX_DELAY_MS = 2_000;

/** Log only changes and problems; `[OK-ALREADY]` / `[ABSENT]` would flood the log. */
function reportFixerResult(error, stdout, stderr, label) {
  if (error) {
    log(`file-level fixer failed (${label}): ${error.message}`);
    const errorText = String(stderr ?? "").trim();
    if (errorText) log(`file-level fixer stderr: ${errorText.slice(0, 600)}`);
    return;
  }
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => /^\[(FIXED|PATTERN-MISSING)\]/.test(line));
  log(lines.length ? `file-level fixer: ${lines.join(" | ")}` : "file-level fixer: no change");
  const stderrText = String(stderr ?? "").trim();
  if (stderrText) log(`file-level fixer stderr: ${stderrText.slice(0, 600)}`);
}

/**
 * Run the Python fixer; fall back to the `py` launcher when `python` is not on PATH.
 * The callback never throws into the host and the child is bounded by FIX_TIMEOUT_MS.
 */
function runFixer(command, args, allowFallback = true) {
  execFile(
    command,
    args,
    { encoding: "utf8", timeout: FIX_TIMEOUT_MS, windowsHide: true },
    (error, stdout, stderr) => {
      if (error?.code === "ENOENT" && allowFallback) {
        runFixer("py", ["-3", ...args], false);
        return;
      }
      reportFixerResult(error, stdout, stderr, command);
    },
  );
}

/**
 * Repair the on-disk offenders shortly after boot; the runtime wrapper covers this boot.
 * Skipped silently when the fixer is not configured — the in-memory normalization is
 * the primary mechanism, this is only the cleanup pass for already-written sessions.
 */
function scheduleFilePatchSelfHeal(ctx) {
  if (!FIX_SCRIPT || !FIX_PROFILE) {
    return;
  }
  if (!existsSync(FIX_SCRIPT)) {
    log(`file-level fixer missing: ${FIX_SCRIPT} — skipped`);
    return;
  }
  const timer = setTimeout(() => {
    log(`file-level fixer: ${FIX_SCRIPT} --profile ${FIX_PROFILE}`);
    runFixer("python", [FIX_SCRIPT, "--profile", FIX_PROFILE]);
  }, FIX_DELAY_MS);
  timer.unref?.();
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => clearTimeout(timer));
  }
}

export function apply(ctx) {
  // File repair is independent of the session store and must also run when sessions are absent.
  scheduleFilePatchSelfHeal(ctx);

  const sessions = ctx.get("sessions");
  if (!sessions) {
    log("sessions service unavailable — guard inactive");
    return;
  }

  const restores = [];
  let live = 0;

  // 1. Sessions that already exist (plugin installed into a running host, HMR reload, …).
  try {
    for (const session of sessions.list() ?? []) {
      if (patchSession(session)) live += 1;
    }
  } catch (error) {
    log(`sessions.list() failed: ${error?.message ?? String(error)}`);
  }

  // 2. Sessions minted later. On a fresh boot no session exists yet, so the prototype cannot be
  //    patched up front; wrapping the store's factory methods lets us patch before the first
  //    append of every new / forked / restored session.
  const storeProto = Object.getPrototypeOf(sessions);
  for (const method of ["prepare", "fork"]) {
    const descriptor = storeProto && Object.getOwnPropertyDescriptor(storeProto, method);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      try {
        patchSession(result);
      } catch (error) {
        log(`patching a fresh session failed: ${error?.message ?? String(error)}`);
      }
      return result;
    };
    Object.defineProperty(wrapped, "name", { value: method });
    Object.defineProperty(storeProto, method, { ...descriptor, value: wrapped });
    restores.push(() => {
      try {
        Object.defineProperty(storeProto, method, descriptor);
      } catch {
        /* leave the wrapper in place rather than crash on unload */
      }
    });
  }

  // 3. Belt and braces: the first commit of any session we never met (restored in place, etc.).
  ctx.on("session/event", (session) => {
    try {
      patchSession(session);
    } catch {
      /* ignore */
    }
  });

  // 4. Undo the prototype edits when the plugin unloads, so an HMR reload re-applies cleanly.
  ctx.effect(() => () => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  log(`active — ${live} live session(s) patched, append normalised for every session`);
}
