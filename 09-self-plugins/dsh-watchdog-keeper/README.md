# dsh-watchdog-keeper

Watch the local dsh watchdog's heartbeat from inside the dsh server.

## Default: monitor only, and unconfigured by default

`keepalive` is **off by default**, and so is the plugin itself: there is no
heartbeat path that is correct for every machine, so `heartbeatPath` ships
empty. Until you set it, the plugin stays loaded and idle and logs exactly one
line:

```
[watchdog-keeper] no heartbeatPath configured; keeper is idle
```

A probe pointed at a path that never existed would report "dead" forever, which
is worse than admitting it is unconfigured. Set it in the plugin config:

```yaml
# cordis.patch.yml
- insert:
    - id: watchdog-keeper
      name: 'dsh-watchdog-keeper'
      config:
        heartbeatPath: 'D:\dsh\watchdog.heartbeat'
```

With a path set, it probes on an interval, logs only transitions (fresh →
stale, stale → fresh) — a line every two minutes saying "still fine" would bury
the one line that matters — and exposes the probe at:

```
GET /watchdog-keeper/status
```

Example:

```json
{
  "name": "dsh-watchdog-keeper",
  "keepalive": false,
  "heartbeatPath": "<absolute path to your heartbeat file>",
  "staleSeconds": 60,
  "checkSeconds": 120,
  "alive": true,
  "ageSeconds": 12.4,
  "checkedAt": "2026-10-18T10:05:00.000Z"
}
```

It never starts a process in this mode.

## Keepalive is opt-in, and needs two settings

```yaml
# cordis.patch.yml
- insert:
    - id: watchdog-keeper
      name: 'dsh-watchdog-keeper'
      config:
        heartbeatPath: 'D:\dsh\watchdog.heartbeat'
        script: 'D:\dsh\ensure-watchdog.ps1'
        keepalive: true
```

`keepalive: true` without a `script` degrades to monitor-only and logs why —
passing `-File ""` to powershell would just produce an error nobody reads.

Why it is off by default: auto-reviving a process hides the fact that it keeps
dying. If the watchdog crashes every 40 minutes because of a plugin conflict,
keepalive turns that into a restart loop and you lose the evidence. Watch the
transitions in the log first; enable keepalive once you know *why* it dies.

Only enable it in a profile that actually runs that watchdog script; a profile
that never writes the heartbeat will always look dead.

## The same probe without this plugin

`dsh-ops-health` exposes the heartbeat as `GET /ops/watchdog`, so a profile
that only needs the monitoring half can skip this plugin entirely.

## Config

| key | default | meaning |
| --- | --- | --- |
| `heartbeatPath` | *(empty)* | **required**; file whose mtime is the watchdog's pulse |
| `staleSeconds` | `60` | older than this = dead/wedged |
| `checkSeconds` | `120` | probe interval |
| `firstDelaySeconds` | `15` | settle time before the first probe |
| `keepalive` | `false` | opt-in: run the start script when stale |
| `script` | *(empty)* | script used by the opt-in keepalive path; required for keepalive |

## Tests

```powershell
npm test
```

The pure probe (`probeHeartbeat`) is tested without a server; a missing file
counts as not alive, never as an exception.
