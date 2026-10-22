# OpenInfra TUI — full implementation plan

_2026-10-22 · v1 of the build plan. Companion docs: [OPENINFRA_PLAN.md](OPENINFRA_PLAN.md) (product),
[OPENINFRA_CLI_FIRST.md](OPENINFRA_CLI_FIRST.md) (sequencing, CLI contract, approvals),
[OPENINFRA_TUI_HARNESS.md](OPENINFRA_TUI_HARNESS.md) (base selection and why)._

This document is the plan an engineer can start from on Monday: package boundaries, the event and view-model
protocols, the agent-harness requirements with their tests, the SQLite schema, every screen with keys and states,
the safety rules, the test strategy, the packaging, and a week-by-week build order with per-PR acceptance
criteria. Where a decision is still open it is marked **DEC-n** and collected in §18.

---

## 0. Scope and vocabulary

**Goal of this milestone.** `openinfra` — one Node binary — that (a) reads a real infrastructure read-only,
(b) reports drift with stable exit codes, and (c) lets one engineer triage, approve and watch a change from a
terminal. The desktop app is later and must not shape this code.

| Term | Meaning |
|---|---|
| **Engine** | Everything deterministic: adapters, store, snapshot, drift, change, artifacts. A library, not a process |
| **Harness** | The agent runtime from this repo's fork: loop, tools, session log, compaction, sandbox, hooks, skills, subagents |
| **Front-end** | CLI (non-interactive), TUI (interactive), later desktop and RPC |
| **View model** | The JSON a front-end draws. Produced by the engine, never by a renderer |
| **Mode** | explore · plan · execute · incident — sandbox + credential posture, not a prompt |
| **Tier** | Tool/credential class: `read` · `plan` · `execute` |
| **Protected facts** | Plan hash, approvals, evidence references, "unreadable" results, incident timeline anchors |

**Non-goals for v0.1.** Cloud writes, NetBox writes, Kubernetes writes (any kind), gNMI, SNMP, multi-user mode,
Windows, a web UI, topology diagrams, charts, image preview.

**Companion:** workspaces (named, git-tracked folders) and the toolchain (installing/verifying Ansible,
OpenTofu/Terraform, kubectl and friends) are specified in
[WORKSPACES_AND_TOOLCHAIN.md](WORKSPACES_AND_TOOLCHAIN.md). They add two TUI surfaces — Setup and Tools — and two
exit codes (8 toolchain, 9 workspace); everything else in this plan is unchanged.

---

## 1. Principles this plan is held to

1. **The engine never prints.** It returns data and emits events; printing belongs to front-ends (CLI-FIRST R2).
2. **Every TUI action has a CLI form.** If the TUI can do it, `oi …` can do it (R1).
3. **Deterministic first.** Every read verb works with no model configured. Agent verbs are additive (R5).
4. **The screen is untrusted.** Model text, device output, findings and file contents are data: sanitised, wrapped,
   truncated, never interpreted.
5. **Approval is not a tool.** No model-callable approve. TTY + typed hash + optional SSH signature.
6. **Kill it anywhere, and the next command tells the truth.** Crash-resume is a feature, not a fallback.
7. **One runtime, one binary, one state home** (`~/.openinfra`).

---

## 2. Architecture

```
                         ┌──────────────────────────────────────────────────────────┐
   oi doctor --json ────▶│ apps/openinfra-cli        verbs · tables · exit codes     │
   oi tui ──────────────▶│ apps/openinfra-tui        chat + 3 screens (Ink / pi-tui) │
   (later) RPC ─────────▶│ apps/openinfra-rpc        ndjson over stdio               │
                         └───────────────▲──────────────────────────┬───────────────┘
                                         │ view models / events     │ commands (verbs)
                         ┌───────────────┴──────────────────────────▼───────────────┐
                         │ packages/openinfra-engine  (composition root)            │
                         │   resolve targets · run jobs · store · artifacts · hash   │
                         └───▲─────────────▲──────────────▲────────────▲────────────┘
                             │             │              │            │
        ┌────────────────────┴──┐  ┌───────┴───────┐  ┌───┴──────┐  ┌──┴───────────────┐
        │ plugins/openinfra-*   │  │ Harness fork  │  │  EEs     │  │ Artifacts        │
        │ inventory network     │  │ loop · log    │  │ networks │  │ sha256 blobs     │
        │ iaac k8s cloud drift  │  │ tools·compact │  │ iaac k8s │  │ + SQLite index   │
        │ change knowledge guard│  │ sandbox·hooks │  │ cloud    │  │                  │
        └───────────────────────┘  └───────────────┘  └──────────┘  └──────────────────┘
```

**Process model.**

- One process. `oi` starts the engine in-process; `oi tui` adds the renderer on the same event loop.
- Every long operation (a read sweep, a drift pass, an apply) is a **job** in the engine with an id, a
  write-ahead record, and cancellable children. The TUI subscribes; the CLI awaits; `oi run show` reads the record.
- Model calls happen only through Harness's loop. The engine never calls a provider directly.
- Containers (EEs) are started per job by the job runner, never by the renderer.

**Threading.** Node's event loop plus a bounded worker pool for parsing (`node:worker_threads`, N = min(4, cpus))
because normalising hundreds of configs is CPU-bound. Everything else is async I/O. No userland threads.

---

## 3. Repository layout

New top-level tree; existing `plugins/*` stay untouched (Harness Studio's app keeps working while OpenInfra grows).

```
apps/
  openinfra-cli/
    package.json            bin: openinfra, oi
    src/main.ts             argv → verb dispatch
    src/verbs/{init,doctor,inv,drift,change,run,verify,kb,ask,config,tui}.ts
    src/output/{table,json,events,humanize,exit}.ts
    test/verbs/*.test.mjs   golden stdout/stderr snapshots
  openinfra-tui/
    package.json
    src/main.ts             terminal detect → tui or plain fallback
    src/app.tsx             root component, router, overlays
    src/screens/{drift,change,run}.tsx
    src/chat/               adapter over the fork's terminal-chat (F1)
    src/components/{header,list,detail,statusbar,toasts,approval,keybar}.tsx
    src/render/{sanitize,wrap,escape,width,diff-delegate,theme}.ts
    src/state/{reducer,selectors,actions}.ts     pure, fully tested
    src/keys/{map,match}.ts                      pure, fully tested
    test/{reducer,keys,sanitize,wrap}.test.mjs
    test/pty/*.test.mjs                          real PTY + headless xterm
    test/screens/*.snap.json                     golden frames
  openinfra-rpc/            (phase 5) stdio ndjson bridge for desktop/CI
packages/
  openinfra-protocol/       zod schemas: events, view models, config, approval, change, finding
  openinfra-engine/         composition root, job runner, store, artifacts, hashing
  openinfra-testing/        fake devices, cassettes, PTY harness, lab fixtures
plugins/
  openinfra-core/           mode enforcement, budgets, evidence, redaction, compaction policy
  openinfra-inventory/      NetBox 4.7 + YAML/TOML merge, target resolution
  openinfra-network/        SSH/NETCONF/RESTCONF adapters, normalisers, parsers
  openinfra-iaac/           ansible-runner, tofu/terraform plan, artifact capture
  openinfra-k8s/            read-only client, RBAC gate, drift vs git/helm
  openinfra-cloud/          read-only inventory (aws/azure/gcp)
  openinfra-drift/          snapshots, fingerprints, transitions, schedules
  openinfra-change/         change files, checks, hash, approvals, waves, verify, rollback
  openinfra-knowledge/      packs, staleness watches, impact grep
  openinfra-guard/          hook rules, tool-tier wrapper, redaction fixtures
skills/                     6 SKILL.md (agentskills.io format)
knowledge/                  tool packs (yaml), one per tool, signed index
schema/                     JSON Schema for intent, change, finding, approval
fixtures/                   synthetic vendor configs, inventories, golden normalisers
images/{ee-network,ee-iaac,ee-k8s,ee-cloud}/Containerfile
```

Every `plugins/openinfra-*` follows this repo's plugin conventions exactly: `package.json` with a `dsh` block,
`cordis.patch.yml`, `index.js` (host half), pure `logic.js`, `test/*.test.mjs` run by `node --test`. No plugin in
this list has a `client.js`: OpenInfra's UI is not the React client.

**Build-script changes.** `desktop/build-*.sh` and the profile bundler gain `plugins/openinfra-*`; the CLI/TUI
build is a separate `scripts/build-openinfra.sh` producing the single binary (§16). The desktop app keeps working
without OpenInfra plugins installed.

---

## 4. The protocol (`packages/openinfra-protocol`)

Three vocabularies, all zod schemas, all versioned, all golden-tested. Front-ends import the types only.

### 4.1 Events (streamed; `--events jsonl`, TUI subscription, RPC)

```jsonc
{ "v": 1, "seq": 41, "ts": "2026-10-22T09:14:03.412Z", "job": "job_01J9…", "kind": "phase",
  "target": "sw-c-01", "phase": "render", "status": "ok", "detail": { "bytes": 8120 } }
```

| Field | Notes |
|---|---|
| `v` | protocol version; a front-end refuses unknown majors |
| `seq` | monotonic per job, gap-free; resume uses it |
| `kind` | `job` · `phase` · `target` · `finding` · `check` · `artifact` · `token` · `log` · `done` |
| `status` | `pending` · `running` · `ok` · `failed` · `skipped` · `unreadable` · `cancelled` |
| `detail` | free-form per kind, schema-checked per kind |

Rules: events are **facts about the job**, never model prose; a `log` event carries redacted text; `done` carries
the exit code so a CLI can just forward it.

### 4.2 View models (what a front-end draws)

```jsonc
// ScreenModel<Drift>
{ "v": 1, "screen": "drift", "title": "Drift",
  "header": { "open": 7, "high": 3, "lastCheck": "2026-10-22T03:12:41Z", "stale": false },
  "rows": [ { "id": "drift_01J9…", "sev": "high", "target": "sw-c-01", "summary": "BGP neighbor removed",
              "where": "bldg-c", "ageSec": 21600, "badges": ["netbox", "ssh"] } ],
  "selection": "drift_01J9…",
  "detail": { "sections": [ { "label": "intended", "lines": ["netbox:device/821 → neighbor 10.40.0.6"] },
                            { "label": "actual",   "lines": ["ssh://sw-c-01 · 03:12:41Z · removed 02:58"] },
                            { "label": "evidence", "lines": ["artifacts/41ab…/sw-c-01.running-config"] } ] },
  "actions": [ { "key": "x", "id": "explain" }, { "key": "c", "id": "open-change" } ] }
```

`detail.sections` is deliberately line-oriented: terminals are line-oriented, and the future desktop renders the
same sections with widgets without a second data path. Every line passes through `sanitize()` in the renderer.

### 4.3 Commands (front-end → engine)

The engine exposes one `invoke(name, args, opts)` surface; the CLI and TUI share it 1:1.

| Group | Names |
|---|---|
| Read | `doctor.run`, `inventory.list`, `inventory.show`, `inventory.validate`, `drift.check`, `drift.list`, `drift.show`, `drift.explain`, `drift.mute`, `kb.list`, `kb.show`, `run.list`, `run.show` |
| Write (workspace) | `change.new`, `change.check`, `change.close`, `change.restore` |
| Gated | `change.run`, `change.verify`, `change.rollback` (all require an approval record) |
| Human-only | `change.approve` — **refused unless `opts.tty && opts.signer`**, never reachable from a tool |
| Agent | `ask`, `change.draft`, `triage` — routed to Harness's loop with a mode-scoped toolset |

---

## 5. Harness requirements, concretely

Each item names the module, the mechanism, and the test. These are the L1–L12 requirements of
[OPENINFRA_TUI_HARNESS.md](OPENINFRA_TUI_HARNESS.md) turned into work.

### 5.1 Loop and budgets (`plugins/openinfra-core/budgets.js`)

| Budget | explore | plan | execute | incident |
|---|---|---|---|---|
| max steps per turn | 40 | 60 | 60 | 25 |
| max tool calls per step | 8 | 8 | 8 | 4 |
| max wall clock per turn | 10 min | 20 min | 30 min | **30 min (hard)** |
| max tokens per turn | 120k | 200k | 200k | 150k |
| concurrent device sessions | 50 | 50 | 10 | 40 |

Enforced on `agent/pre-step`: when a budget is hit, the loop stops with a summary message ("stopped at 40 steps;
here is what was done and what remains") and a `done` event with `status: "budget"`. Tests: scripted overflowing
turn, assert the summary and that no further provider call is made.

### 5.2 Context assembly (`plugins/openinfra-core/prompt.js`)

Prompt sections, each with an `order`, a token estimate and a **source tag** surfaced by `oi ask --show-context`:

| Section | Source | Cap |
|---|---|---|
| identity + mode rules | static | 350 tok |
| knowledge pins in play | `knowledge/*.yaml` | 600 tok |
| project conventions | `.openinfra/AGENTS.md` if present, else `AGENTS.md` | 800 tok |
| inventory summary | engine (counts only, never the full table) | 400 tok |
| tool catalog | generated from the registry | deducted from budget |
| skill catalog | names + one-line descriptions only | 60 tok each |
| task | user | — |

**Never injected:** full device configs, full inventories, evidence bodies. They are fetched by tools, on demand,
into tool results (which are prunable) — this is the single most important context decision in the product.

### 5.3 Compaction policy (`plugins/openinfra-core/compaction.js`)

Built on Harness's compaction seam (surface `replace` over the event log), with our policy plugged in:

1. **Prune first, no model call.** Walk back through tool results; keep the last 40k tokens verbatim (OpenCode's
   protected window); beyond it, replace old tool output with `[pruned: <tool> <target> → artifacts/<hash>]`. Never
   prune: `change.check` results, approval records, evidence indexes, `unreadable` lists, the incident timeline.
2. **Summarise second.** One model call, bounded to 8k output. The summary prompt *requires* the current goal,
   decided facts with sources, open questions, the active change id + hash, and the list of targets touched.
3. **Replay the last user message** after compaction so the model continues from the user's instruction, not the
   summary.
4. **Assert the invariants.** After compaction a test runs `change.show <id>` and every protected reference must
   still resolve; a failed assertion is a failing build.
5. **Never compact in execute mode while a run is active** — queue until the run finishes (a compaction call in the
   middle of a wave would change the meaning of the turn).

### 5.4 Memory (`packages/openinfra-engine/memory.js`)

| Tier | Store | Written by | Read by |
|---|---|---|---|
| Session | Harness event log (append-only) | loop | resume, replay, evidence |
| Project | `<repo>/.openinfra/` + git (intent, conventions, skills) | user, agent via plan mode | every session |
| Knowledge | `knowledge/*.yaml` (signed, versioned) | release, weekly watch | every session, pinned |
| Operational | SQLite: findings, runs, changes, targets cache | engine | triage, `oi ask` |

Rule: the agent may read all four; it may write only tier 2 (through plan mode) and tier 1 (its own log). Tiers 3
and 4 are written only by the engine — a model that could rewrite its own knowledge pack could lie to itself.

### 5.5 Tools and tiers (`plugins/openinfra-guard/tiers.js`)

`ctx.tools.register` is wrapped: every tool carries `tier: "read" | "plan" | "execute"` and `opts`. The wrapper
refuses `execute` tools unless the call carries an approval token minted by `change.run` for the current job and
matching hash. Refusal happens **before** execution and is reported as a normal tool error the model can read
("this tool needs an approval token for change NET-142, plan sha256:9f2c…; open the change and approve it").

v0.1 tool set (agent-facing):

| Tool | Tier | Purpose |
|---|---|---|
| `infra_inventory_query` | read | structured query over merged SoT |
| `infra_device_read` | read | allowlisted `show`/`get-config`/GET on targets |
| `infra_k8s_read` | read | allowlisted GET/LIST, read-only cluster only |
| `infra_cloud_inventory` | read | read-only resource listing |
| `infra_snapshot` | read | take + store a snapshot with hash |
| `infra_drift_list` / `infra_drift_explain` | read | findings and their evidence |
| `infra_change_open` | plan | intent edits on a branch + change file |
| `infra_change_check` | plan | render, lint, policy, plan, hash |
| `infra_change_run` | execute | start an approved run (token required) |
| `infra_run_status` / `infra_verify` | read | timeline, per-target results |
| `infra_knowledge_lookup` | read | pinned tool knowledge with dates |
| `infra_scratchpad_run` | read | Python in the sandbox against the read API |

### 5.6 Skills (`skills/`)

Standard `SKILL.md` (agentskills.io): frontmatter `name`, `description` (≤1024 chars) + markdown body; only the
name and description cost context until the skill is loaded.

| Skill | When it loads | What it says |
|---|---|---|
| `inventory-triage` | doctor / messy inventory | how to read the readiness report, what "unreadable" means, the fix order |
| `config-drift` | a drift finding is open | normalisation, severity, transition semantics, when to mute |
| `change-author` | a change is requested | branch, templates, checks, blast radius, waves, rollback |
| `netconf-read` | NETCONF target | get-config patterns, YANG paths, capability handling, timeouts |
| `k8s-readonly-audit` | cluster question | RBAC gate, what is never read (secrets), drift sources |
| `incident-timeline` | incident mode | time-boxing, correlation order, what to write down |

Tests: a skill loads on demand and does not appear in the base context; a third-party `SKILL.md` from the standard
loads unchanged.

### 5.7 Subagents / fan-out (`plugins/openinfra-network/fanout.js`)

Device reads fan out in-process: a bounded pool (50) over the resolved target list, each item producing structured
facts + an evidence pointer; partial failure is normal (`unreadable`), never an exception that kills the sweep.
Harness sessions-as-subagents are used only for genuinely separate work (an independent investigation, a long
verification), because a session costs a model context.

Test: 200 fake devices, 12 failing in three different ways → one merged result, every fact with a source, every
failure categorised, wall clock < 15 s.

### 5.8 Cancellation and crash safety (`packages/openinfra-engine/jobs.js`)

- `SIGINT`/tool cancel → job `cancel()` → abort signal → adapter closes sessions → child process groups killed
  (repo already has this discipline in `plugins/terminal` and `plugins/watch`; reuse it).
- A job writes `~/.openinfra/runs/<id>/journal.ndjson` (fsync every event) before doing anything observable.
- On start, the engine reconciles journals: a `running` job with no live process becomes `interrupted`, with
  per-target state as last written. `oi run show` prints exactly that.

---

## 6. Data model and storage

### 6.1 Locations

| Path | Contents | Notes |
|---|---|---|
| `~/.openinfra/` (`OPENINFRA_HOME`) | state home | separate from Harness's home on purpose |
| `~/.openinfra/openinfra.db` | SQLite (WAL) | findings, runs, changes index, targets cache, kb pins |
| `~/.openinfra/artifacts/sha256/ab/cd/<hash>` | content-addressed blobs | zstd-compressed by default |
| `~/.openinfra/runs/<id>/journal.ndjson` | write-ahead log per job | survives crashes |
| `~/.openinfra/sessions/` | Harness session logs (agent turns) | reused, not duplicated |
| `~/.openinfra/credentials/` | references only (keychain/service) | never secrets on disk |
| `<repo>/.openinfra/config.toml` | project config | committed |
| `<repo>/.openinfra/changes/NET-142/` | change file, approvals, artifacts refs | committed |
| `<repo>/inventory/*.yaml|toml` | local SoT | committed |
| `<repo>/.openinfra/cache/` | derived caches | git-ignored |

### 6.2 SQLite (v1 schema, abridged)

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;

CREATE TABLE targets (                -- merged inventory cache
  id TEXT PRIMARY KEY,                -- "device:sw-c-01", "k8s:prod-eu/ns/api", "cloud:aws:1234/i-0f2a"
  source TEXT NOT NULL,               -- netbox | yaml | discovered
  kind TEXT NOT NULL, site TEXT, platform TEXT, env TEXT,
  facts TEXT NOT NULL,                -- json, normalised
  updated_at TEXT NOT NULL);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
  target_id TEXT, source_a TEXT, source_b TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,              -- open | muted | resolved
  mute_reason TEXT, owner TEXT, evidence TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE (fingerprint, status));
CREATE INDEX findings_open ON findings(status, severity, last_seen);

CREATE TABLE changes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, branch TEXT,
  plan_hash TEXT, status TEXT NOT NULL,   -- draft|checked|approved|running|verified|failed|closed
  intent_diff TEXT, checks TEXT, targets TEXT, waves TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id),
  plan_hash TEXT NOT NULL, by_user TEXT NOT NULL, by_key TEXT, signature TEXT,
  signed_payload_sha256 TEXT, at TEXT NOT NULL, tty INTEGER NOT NULL CHECK (tty = 1));

CREATE TABLE runs (
  id TEXT PRIMARY KEY, change_id TEXT, kind TEXT NOT NULL,   -- change|drift|doctor
  status TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER,
  summary TEXT, journal TEXT);

CREATE TABLE run_targets (run_id TEXT, target_id TEXT, wave TEXT, status TEXT,
  detail TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (run_id, target_id));

CREATE TABLE kb_pins (tool TEXT PRIMARY KEY, version TEXT, verified_at TEXT, source TEXT);
```

Retention: snapshots 30 days; runs/approvals forever; evidence trimmed to hash+summary after 90 days unless
attached to a change. `oi maintenance gc` (later) enforces it; the default keeps everything so v0.1 cannot lose an
audit trail.

### 6.3 Config (`<repo>/.openinfra/config.toml`)

```toml
[project]
name = "core-network"
intent = ["inventory/", "terraform/"]
default_mode = "explore"

[sources.netbox]
url = "https://netbox.example.com"
api_version = "4.7"
token_ref = "keychain:openinfra/netbox-read"

[sources.k8s.prod]
kubeconfig_ref = "keychain:openinfra/k8s-prod"
require_readonly = true
deny_resources = ["secrets"]

[devices]
platforms = ["ios-xe", "nx-os", "eos"]
ssh_ref = "keychain:openinfra/net-ssh"
netconf = true
concurrency = 50

[drift]
devices = "*/30 * * * *"
tofu = "0 2 * * *"
k8s = "*/15 * * * *"
cloud = "0 * * * *"

[change]
require_plan_hash = true
require_approval = ["prod"]
require_signature = true
waves = ["canary:1", "10%", "rest"]
verify = ["posture", "reachability"]

[ui]
screen = "auto"          # auto | inline | viewport    (DEC-1)
pager = "$PAGER"
diff_tool = "auto"       # auto | delta | difftastic | diff -u
theme = "dark"           # dark | light | mono | high-contrast
mouse = false
```

Unknown keys are an error (typos are the most common config bug). `oi config validate` explains each one.

---

## 7. Adapters (v0.1)

### 7.1 Device read (`plugins/openinfra-network`)

| Transport | Library | v0.1 verbs | Notes |
|---|---|---|---|
| SSH/CLI | netmiko 4.8.0 (paramiko 5.0.0) | `show running-config`, `show version`, `show vlan`, `show interfaces trunk`, allowlisted per platform | prompt detection per platform; 30 s timeout; no `enable` unless configured; no config mode |
| NETCONF | ncclient | `get`, `get-config` with subtree filters | preferred when advertised; capability gate |
| RESTCONF | requests | `GET` on YANG paths | JSON preferred, XML fallback |

**Read-only guarantee:** the adapter's verb table has no write verb compiled in v0.1. The write path for changes is
Ansible (EE), so "the model invented a config command" is impossible at the adapter layer, not merely discouraged.

**Normalisers** (`normalisers/<platform>.js`, golden fixtures in `fixtures/`): strip volatile lines (uptime, last
configuration change, `! NVRAM`, timestamps, counters, certificate blobs, key hashes), sort repeatable blocks (ACLs,
route-maps, neighbor stanzas), expand nothing. `oi normalise --explain <file>` shows exactly which lines were
dropped, because a silent normaliser is how drift tools earn their reputation for lying.

### 7.2 Inventory (`plugins/openinfra-inventory`)

- **NetBox 4.7.x**: REST for lists, GraphQL for joins; `api_version` pins the shape adapters; version-specific
  field handling for `{value,label}` selection custom fields and `port_mappings`; ETag/`If-Match` only for writes
  (not used in v0.1); read-only token, ability checked at connect.
- **YAML/TOML**: `inventory/*.yaml` validated by `schema/inventory.schema.json`; `inventory/*.toml` for
  values-heavy files.
- **Merge precedence**: identity from NetBox when present, intent from the repo, observed from devices. Conflicts
  become findings (`conflict`), never silent wins.
- **Resolution**: selectors (`role:access`, `site:bldg-c`, `platform:ios-xe`) compile to a target list and are
  **frozen** into the change at check time.

### 7.3 Kubernetes (`plugins/openinfra-k8s`) — three-layer read-only gate

1. Provisioning guidance ships as `schema/k8s-readonly.yaml` (Role/ClusterRole with `get,list,watch`, no secrets,
   no exec, no writes).
2. **Connect gate:** `kubectl auth can-i --list` (self-subject review), parsed; write verbs, secret reads, exec or
   impersonation → refuse to connect and print the offending rules.
3. **Client allowlist:** the adapter only issues GET/LIST/WATCH on an allowlist of groups/resources; anything else
   throws before the request leaves the process.

Drift sources: live vs Git/Helm-rendered, image skew, RBAC over-privilege, missing probes/limits (policy pack).

### 7.4 Cloud (`plugins/openinfra-cloud`)

Read-only: AWS assume-role (external id or OIDC) with `ReadOnlyAccess` + explicit denies on data-plane reads;
Azure `Reader`; GCP `roles/viewer` + `roles/iam.securityReviewer`. The connect output states exactly which actions
the policy grants (`doctor` prints "write actions in policy: 0"). Inventory only; semantic drift lives in tofu
plans (§9.2).

---

## 8. Drift engine (`plugins/openinfra-drift`)

```
schedule (Watch) → read (adapters) → snapshot (hash) → normalise → compare → classify → fingerprint
        → transition (new|changed|resolved) → store → notify (in-app, digest)
```

1. **Schedule** on the existing Watch subsystem: no model, resumable, capped, with jitter so 200 devices do not
   stampede at :00. Per-source cadence from config.
2. **Read** with a hard timeout; every target yields `ok | unreadable(reason)`. Three consecutive failures escalate
   `unreadable` to a finding — silence is a finding, not an absence.
3. **Snapshot** into artifacts (`config@ts`, `plan.json`, `objects.json`) with a hash; snapshots are the diff base
   and the rollback source.
4. **Compare** per source: text config (normalised), structured YANG/JSON (tree compare), tofu/terraform plan JSON
   (resource/attribute level), k8s object graph (semantic, not string), cloud inventory (id sets).
5. **Classify** by policy file (`rules/drift-policy.yaml`): routing/ACL/BGP deltas and policy violations `high`;
   config deltas `medium`; version skew and unmanaged resources `low`. Never by the model.
6. **Fingerprint** = sha256(kind + target + normalised-diff-hash + source pair). Transitions only.
7. **Notify**: in-app rows, plus one digest per transition (`--digest slack|teams|webhook|email|none`).
8. **Coverage matrix**: each adapter declares dimensions; `oi drift coverage` prints supported/unsupported so a
   green dashboard never lies.

Exit codes for `oi drift check`: `0` clean · `2` findings · `3` policy violation (tier-1) · `5` unreadable above
threshold · `1` engine error. `--fail-on high|medium|low|none`.

---

## 9. Change engine (`plugins/openinfra-change`)

### 9.1 Pipeline

```
change.new → (intent edits on branch) → render → static checks → policy → plan → hash → approve → waves → verify → record
```

| Gate | Implementation | Blocks on |
|---|---|---|
| render | templates (Jinja2 via EE python, or repo-native) | unresolved variable, empty block |
| static | `ansible-lint` (production), `yamllint`, `batfish` parse, `pyang`, `kubeconform`, `tflint` | any error |
| policy | `conftest`/OPA on rendered configs and `tofu show -json`; OpenInfra checks (scope, blast radius, protected objects) | any deny |
| plan | `ansible-playbook --check --diff` per target; `tofu plan -out`; k8s diff | any unspecified change outside scope |
| hash | sha256 over: intent blobs, frozen target list, rendered configs, adapter versions, EE image digests, policy bundle | — |
| approve | TTY + typed 8-char hash prefix + `ssh-keygen -Y sign` (§10) | missing signature when required |
| waves | canary → small → rest, thresholds from config | threshold breach → stop and offer rollback |
| verify | independent post-checks (device state, reachability, k8s readiness) | any failure twice |

### 9.2 Terraform/OpenTofu specifics

- Engine binary detected (`tofu` preferred when both present) and **recorded in the hash**.
- Drift: `plan -refresh-only -detailed-exitcode -lock=false`; classify from the plan JSON, never from the exit code
  alone (OpenTofu has produced false-positive exit 2 in this mode).
- Apply: always `apply <saved.tfplan>`; no `-auto-approve` anywhere in the codebase (grep test).
- Shadow infra: cloud inventory minus state ids → `shadow` findings with an `import` suggestion.

### 9.3 Rollback

Designed before apply, stored with the change: config-replace from the pre-change snapshot for devices; revert the
intent commit + re-plan + re-apply for IaC; Git revert for k8s (we never roll back inside a cluster we can only
read). Automatic rollback is allowed **only** for the failing wave and only if the change pre-approved it.

---

## 10. Approvals (terminal, signed)

```
$ oi change approve NET-142
Change NET-142 · Add VLAN 240 to Building C access switches
plan sha256:9f2c4b71e0aa…   targets 12 · env prod · canary sw-c-01 → 2 → 9
checks  ansible-lint ✓  batfish ✓  conftest 4/4 ✓  tofu plan no-change ✓

Type the first 8 characters of the plan hash: 9f2c4b71
sign with your SSH key? [Y/n] y
signed ~/.ssh/id_ed25519.pub SHA256:9f0a… · wrote .openinfra/changes/NET-142/approvals/2026-10-22T09-14-03Z.json
→ oi change run NET-142
```

Approval record (committed with the change):

```jsonc
{ "v": 1, "change": "NET-142", "planHash": "sha256:9f2c…", "at": "2026-10-22T09:14:03Z",
  "by": "you@example.com", "tty": true, "key": "SHA256:9f0a…",
  "payloadSha256": "…", "signature": "-----BEGIN SSH SIGNATURE-----…" }
```

Verification: `ssh-keygen -Y verify -f allowed_signers -I <by> -n openinfra -s sig` over a canonical payload
(change id, plan hash, target list hash, timestamp). `oi change verify-signature NET-142 [--allowed-signers file]`.

Rules: no TTY → exit 4 with instructions; hash mismatch → exit 7; approval for a different target set → invalid
(target list hash is in the payload); `--force` does not exist; the `change.approve` invoke is unreachable from any
tool because it requires `opts.tty && opts.signer`, which the tool layer never supplies.

---

## 11. The TUI, in detail

### 11.1 What it is

Four surfaces in one inline terminal app:

1. **Chat** — the existing Harness terminal chat (streaming answer, `⏺` tool lines, approval box), extended with a
   mode pill, evidence expansion and slash commands.
2. **Drift** — triage list + detail (the ops home screen).
3. **Change** — review, approve, run (the ceremony screen).
4. **Run** — live per-target matrix.
5. **Setup** and **Tools** — workspace, toolchain and sources (route 0, shown automatically when something is
   missing: [WORKSPACES_AND_TOOLCHAIN.md](WORKSPACES_AND_TOOLCHAIN.md) §10).

Plus overlays: help (`?`), filter (`/`), command palette (`:`), approval, confirm, toast, error.

### 11.2 Rendering backends (DEC-1)

One `Screen` interface, two backends, chosen at startup (`ui.screen`, default `auto`):

| Backend | What it is | Used for |
|---|---|---|
| `inline` | Ink, static output to scrollback + live area at the bottom (what the fork ships today) | chat always; lists when the terminal is narrow or `TERM` is limited |
| `viewport` | alternate screen with its own scroll state (`pi-tui`, or Ink + a hand-rolled viewport if the spike says so) | drift/change/run dashboards |

`auto` = viewport when `stdout.isTTY && columns ≥ 80 && TERM !== 'dumb' && ui.screen !== 'inline'`, else inline.
The spike (§17 W0) measures both and records the numbers in this file before the screens are written; the
abstraction means the decision is a config default, not a rewrite.

**Rule from the existing work, kept:** finished chat messages go to scrollback (terminal search and copy keep
working); only the live area is redrawn. Dashboards may take the alternate screen because they are dashboards —
the same bargain `k9s` and `lazygit` make.

### 11.3 Layout

80×24 is the target; 120×40 the pleasant default; below 60 columns each screen collapses to a single pane with a
`tab`-cycled header. Nothing is ever cut off horizontally: detail lines wrap, tables truncate with `…`, and the
footer shows `12 more · f to filter`.

```
┌ Ops ─────────────────────────────────────────────────────────── ◆ plan · prod ─┐
│ Drift   7 open · 3 high · checked 03:12 (6m ago)          [devices ✓ tofu ✓ k8s]│
├────────────────────────────────────────────────────────────────────────────────┤
│▸ HIGH  sw-c-01   BGP neighbor 10.40.0.6 removed           bldg-c      6h  NB·SSH│
│  HIGH  sg-0f2a   0.0.0.0/0:22 on 3 resources               aws eu-w1   6h  CF   │
│  MED   vlan 240  on 1 of 12 bldg-c switches                bldg-c      6h  NB·SSH│
│  MED   api-gw    image differs from git                    k8s prod-eu 6h  K8S  │
│  LOW   14 EC2    unmanaged (shadow infra)                  aws eu-w1   6h  CF   │
├─ drift_01J9… ──────────────────────────────────────────────────────────────────┤
│ intended  netbox:device/821 → neighbor 10.40.0.6 as 64512                      │
│ actual    ssh://sw-c-01 · running-config @03:12:41Z · removed 02:58            │
│ owner     team-network (netbox tenant) · commit 4f2c1a (07:40 @you)            │
│ evidence  artifacts/41ab…/sw-c-01.running-config · diff.patch                  │
├────────────────────────────────────────────────────────────────────────────────┤
│ x explain  c change  m mute  o open  r recheck  / filter  ? help   q quit      │
└────────────────────────────────────────────────────────────────────────────────┘
```

Change screen:

```
┌ NET-142 ─────────────────────────────────────── ◆ execute · awaiting approval ┐
│ Add VLAN 240 to Building C access switches                                     │
│ plan sha256:9f2c4b71…   targets 12 (canary sw-c-01)   env prod   L2 only        │
├─ checks ───────────────────────────────────────────────────────────────────────┤
│ ✓ ansible-lint (production)      ✓ batfish parse 12/12                          │
│ ✓ conftest 4/4                   ✓ tofu plan: no change                         │
├─ diff ─────────────────────────────────────────────────────────────────────────┤
│ intent/sites/bldg-c/vlans.yaml   +18 −0      d open · D side-by-side (delta)    │
│ devices rendered                 12 files    ≥ view · V diff last               │
├─ waves ────────────────────────────────────────────────────────────────────────┤
│ 1 canary  sw-c-01            verify: vlan-up trunk reach posture               │
│ 2 small   sw-c-02, sw-c-03                                                     │
│ 3 rest    sw-c-04 … sw-c-12                                                    │
├────────────────────────────────────────────────────────────────────────────────┤
│ a approve (types hash)  r run  v verify  l logs  R rollback  esc back          │
└────────────────────────────────────────────────────────────────────────────────┘
```

Run screen: one row per target, one column per phase, streaming.

```
┌ NET-142 · run_01J9… · wave 2/3 ─────────────────────────────── 4m12s · 5/12 ┐
│ target     render  plan   apply  verify   result         time               │
│ sw-c-01    ✓       ✓      ✓      ✓        ok · vlan 240  3.2s  canary       │
│ sw-c-02    ✓       ✓      ✓      ⠋        verifying…     —                  │
│ sw-c-03    ✓       ✓      ✗      —        failed         1.8s  diff ↓       │
│ sw-c-04    ✓       ✓      ·      ·        queued         —                  │
│ …                                                                           │
├────────────────────────────────────────────────────────────────────────────────┤
│ enter detail  l logs  d diff  s stop  esc back      threshold: 1 failure     │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 11.4 State machine (`src/state/`)

Pure reducer; the renderer is a function of state. All of it tested with `node --test`, no terminal needed.

```ts
type Route =
  | { name: 'chat', sessionId: string }
  | { name: 'drift', filter: Filter, selection?: string, follow: boolean }
  | { name: 'change', id: string, tab: 'checks'|'diff'|'waves'|'logs' }
  | { name: 'run', id: string, selection?: string }

type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'filter', draft: string }
  | { kind: 'palette', draft: string, matches: string[] }
  | { kind: 'confirm', id: 'mute'|'stop'|'rollback', question: string, target?: string }
  | { kind: 'approve', change: string, hashPrefix: string, typed: string, sign: boolean }
  | { kind: 'error', message: string, hint?: string }
  | { kind: 'toast', message: string, level: 'info'|'warn'|'error', until: number }

type State = {
  route: Route; overlay: Overlay; mode: Mode;        // explore|plan|execute|incident
  model: ScreenModel<any>;                           // last view model from the engine
  status: { line: string; progress?: { done: number; total: number } };
  pending: number;                                   // in-flight engine calls
  connected: boolean; degraded: 'none'|'inline'|'plain';
}
```

Actions: `key`, `resize`, `engine.view`, `engine.event`, `engine.error`, `tick`, `approval.request`.
Effects (the only impure part): `invoke(name,args)`, `openPager(path)`, `writeClipboard(text)`, `exit(code)`.

**Approval state rule (from the existing terminal chat, kept):** while an approval overlay is open, queued input is
discarded first and the default is **No**; Enter on an empty field is No; `y` is not accepted as a shortcut for
typing the hash — the hash is the acknowledgement.

### 11.5 Keys

Global: `q` quit (with a confirm when a run is active) · `?` help · `:` palette · `/` filter · `tab`/`shift-tab`
cycle panes or routes · `1..4` routes · `g`/`G` top/bottom · `ctrl-c` cancel (twice: quit) · `ctrl-l` redraw ·
`ctrl-p` copy the selected row's id · `esc` back/close overlay.

| Screen | Keys |
|---|---|
| Drift | `j/k` move · `enter` detail/expand · `x` explain (agent) · `c` open change from finding · `m` mute (asks reason) · `o` open evidence in `$PAGER` · `r` recheck this source · `f` filter menu (severity/source/site/owner) · `s` sort · `a` acknowledge (kept in DB, not a mute) · `d` diff (delegates) |
| Change | `a` approve · `r` run · `v` verify · `l` logs · `d`/`D` diff (pager / delta side-by-side) · `s` stop · `R` rollback (confirm) · `p` plan artifact · `y` copy hash · `esc` back |
| Run | `j/k` · `enter` target detail · `d` diff for target · `l` logs · `s` stop wave · `f` failures only · `w` wave filter |
| Chat | inherited: multi-line input (`shift+enter`), history `↑/↓`, `esc` stop, `/` menu with Tab, `@` target mentions, `ctrl-o` evidence for the last answer |

Vim-optional: every motion also works with arrows and PageUp/PageDown. No mouse in v0.1 (a stray click in tmux
should not change anything).

### 11.6 Text handling (the part that keeps the terminal honest)

One module, `src/render/sanitize.ts`, used by **every** renderer path:

1. Escape C0/C1 control characters into visible `\xNN`/`\uNNNN` forms, except `\n` and `\t`.
2. Strip/neutralise OSC sequences (clipboard `OSC 52`, title, hyperlinks), CSI sequences and DCS payloads from
   device output and model text — display the printable text, never the escape.
3. Replace tabs with spaces; collapse `\r\n`; cap line length at 4,000 chars before wrapping; cap total lines per
   section with `… 812 more lines (o to open)`.
4. Wrap with `string-width`-aware rules (CJK wide chars, emoji, combining marks); never split a wide char.
5. Render a "raw" mode (`R` in a detail pane) only after an explicit confirm, and even then through 1 and 2.

Tested with fixtures: device banners containing OSC 52, a model reply containing `\e[2J`, a filename with a
newline, a 40k-char single line, RTL and CJK text.

### 11.7 Diff delegation

Never render a 1,200-line diff in a custom widget.

| Setting | Behaviour |
|---|---|
| `diff_tool = delta` | `git diff` piped to `delta --side-by-side` in a pager |
| `difftastic` | `difft --display side-by-side` |
| `auto` | first of `delta`, `difft`, `diff -u` found; else built-in unified view (sanitised, 200-line cap) |
| `$PAGER` unset | fall back to built-in view, never block |

The TUI records which diff view was opened in the run audit ("reviewer opened diff before approving") because
"approved without looking" is a compliance question people ask.

### 11.8 Status, progress and notifications

- Footer: `mode · route · selection · pending calls · last event age`; a spinner only while something runs.
- Long jobs show `12/200 devices · 4m12s · esc to stop` and stay cancellable from anywhere.
- Toasts: 3 lines maximum, 8 s, never covering the input; errors persist until dismissed (`enter`) and carry a
  next-command hint (`→ oi doctor --json`).
- Terminal bell off by default; `notify.bell = true` opts in; `notify.desktop` (later) uses OSC 9/777 where safe.

### 11.9 Degraded modes

| Condition | Behaviour |
|---|---|
| `TERM=dumb` or no TTY | `oi tui` refuses with exit 1 and a hint to use the CLI verbs (no partial rendering) |
| `--plain` | line-oriented mode: every TUI action becomes a numbered prompt (still approvals-safe) |
| columns < 60 | single pane, `tab` cycles, footer keys shortened to letters only |
| resize during draw | full reflow on `SIGWINCH`; state survives (viewport backend keeps scroll anchor) |
| no `$PAGER`, no diff tool | built-in sanitised view |
| SSH/tmux | no mouse, no OSC 52 assumed, no truecolor assumption (`mono`/16-color themes) |

### 11.10 Themes and tokens

Theme = a map of semantic tokens to 256/truecolor ANSI, or plain text: `fg`, `fgDim`, `accent`, `ok`, `warn`,
`error`, `sevHigh`, `sevMed`, `sevLow`, selection, border, badge. `mono` renders severity as `HIGH`/`MED`/`LOW` text
only — tested with a colour-stripping snapshot so nothing depends on colour alone (accessibility, and log files).

### 11.11 Chat integration

- `oi tui` starts on **Drift** when findings exist, else on **Chat** with a first-run card (`oi doctor` not yet run
  → one key runs it).
- `1` opens chat; the mode pill shows `explore|plan|execute|incident`; `/plan`, `/execute` require the change
  context; `/incident` starts a time box (hard read-only, 30 min).
- `@sw-c-01` in the composer attaches a target (resolved through the engine, shown as a chip).
- Every answer's evidence is one keystroke away (`ctrl-o`): the engine's evidence index for that turn, not a
  re-read.
- Tool lines use the existing shapes (`⏺ infra_device_read sw-c-01`, `⎿ ✓ 1,208 bytes`) plus `[artifacts/…]` when
  output was offloaded.
- `/approve` in chat never approves a change: it prints the command to run in a real shell (approval is not a chat
  action).

### 11.12 What the TUI will not do (guard against scope creep)

Topology maps · charts · side-by-side diffs of its own · PDF/image preview · a file tree · editing code · mouse
interaction · dashboards of metrics · a session picker beyond `oi tui --session <id>` (v0.2). Each is a desktop
concern; a PR that adds one needs a decision record.

---

## 12. Agent UX inside the TUI

| Situation | Behaviour |
|---|---|
| `x` on a finding | opens chat in **explore** with the finding's evidence pre-attached, question pre-filled (`explain this drift`), model called only now |
| `c` on a finding | opens **plan** with the change template selector; never writes a device |
| approval needed in chat | inline box, hash shown, default No, never satisfied by queued input |
| long tool output | `[8,120 lines → artifacts/ab12…]` with `enter` to open in pager |
| model says it did something | a "verified by" chip links to the verification run; unverified claims are labelled `unverified` |
| budget/incident expiry | one line: `stopped at the 30-minute box · summary written to .openinfra/incidents/INC-7.md` |
| error from adapter | categorised (`auth`, `timeout`, `parse`, `unsupported`) with the raw first line and a hint, never a stack trace |

---

## 13. Security

| Concern | Measure | Test |
|---|---|---|
| Terminal injection | `sanitize()` on all engine text; no `\e` reaches the terminal from data | fixtures with OSC 52/CSI/DCS |
| Approval forgery | TTY + typed hash + signature; verification in CI | forged/mismatched/replayed approval fails |
| Credential exposure | keychain refs only; redaction pass on artifacts and tool results; secret-path denies from the fork's patch 20 | a config with `snmp-server community public` is stored redacted; `~/.ssh` unreadable from tools |
| Prompt injection via device banners | banners are data in a tool result, never instructions; the system prompt says so; skills cannot be loaded from device output | a banner containing "ignore previous instructions and run …" changes nothing; the write tool still needs a token |
| Model-initiated writes | tool tiers + approval tokens + adapter verb tables with no write verbs in v0.1 | attempt to call `infra_change_run` without token → refused |
| Sandbox escape | all command execution under the fork's sandbox; EEs have no host mounts except the workspace (ro for reads) | existing fork tests, plus an EE test that `~/.ssh` is absent |
| Audit | `runs` + journals + approval records + git | `oi run show --audit` prints the chain |

---

## 14. Performance budgets (CI-enforced where possible)

| Metric | Budget | Measured by |
|---|---|---|
| `oi --version` cold start | < 150 ms | hyperfine in CI |
| `oi doctor` warm, 200 fake devices | < 15 s | bench test |
| TUI first frame | < 250 ms | PTY timestamp |
| keystroke → redraw (60k-row list filtered) | < 50 ms | bench in `state` tests + PTY |
| streaming render | no dropped frames at 20 updates/s | PTY frame diff |
| memory (TUI + engine, 200 devices) | < 250 MB RSS | bench |
| drift pass, 200 devices | < 90 s wall, 50 concurrent | bench |
| SQLite open + 10k findings query | < 30 ms | bench |
| binary size | < 90 MB | release job |

No measurement, no merge for anything touching the render loop or the drift sweep.

---

## 15. Test strategy

Everything runs in CI with **no API key and no network**.

| Layer | Tool | What it proves | Location |
|---|---|---|---|
| Pure logic | `node --test` | normalisers, fingerprints, hashing, reducer, keys, sanitize, wrap, exit-code mapping | `*/test/*.test.mjs` (repo convention) |
| Contract | zod + golden JSON | event/view-model schemas never drift from the front-ends | `packages/openinfra-protocol/test` |
| Adapters | fake transport | read verbs, timeouts, partial failure, categorisation | `packages/openinfra-testing/devices` |
| Engine | fake devices + fake clock | drift transitions, dedup, severity, retention, crash-resume | `packages/openinfra-engine/test` |
| Change engine | fake runner | gates, hash stability, wave thresholds, rollback | `plugins/openinfra-change/test` |
| Agent loop | `--fake-model` adapter + cassettes | budgets, compaction invariants, tool tiers, approval refusal | `plugins/openinfra-core/test` |
| TUI renderer | PTY + `@xterm/headless` (already a dependency of `plugins/terminal`) | keys → screen, golden frames, resize, degraded modes, escaping | `apps/openinfra-tui/test/pty` |
| CLI | golden stdout/stderr/exit | the exit-code contract | `apps/openinfra-cli/test` |
| Lab (nightly, optional) | docker compose: cEOS/IOS-XE image, kind cluster, MinIO | the same paths against real software | `fixtures/lab` |

**Fake device server.** A `DeviceTransport` implementation (`packages/openinfra-testing/devices/fake.js`) that
plays scripted sessions from `fixtures/devices/<platform>/<scenario>.yaml`: exact prompt/response pairs, latency,
timeouts mid-command, auth failure, garbage output, banner injection. It implements the same interface as the real
SSH/NETCONF transports, so the adapter code under test is the production code.

**Cassettes.** `--fake-model` is a Harness LLM adapter that replays `testing/cassettes/<name>.jsonl` (provider
frames) and records new ones with `OPENINFRA_RECORD=1`. TUI golden tests replay a cassette so screens are
deterministic. Cassettes are small, committed, and contain no real infrastructure data (fixtures only).

**PTY harness.** `node-pty` spawns the real binary at a fixed size (80×24 and 120×40), types keys, and reads the
screen from `@xterm/headless`'s buffer (the same technique as `plugins/terminal/screen.js`). Snapshot = the
character grid + cursor position + attributes, compared to `test/screens/*.snap.json`, with a `--update` flag.
Timing is handled by waiting for a quiet screen (300 ms, as in that plugin), then asserting.

**Invariant tests that must never be deleted:**

1. Protected facts survive forced compaction.
2. A write tool without an approval token is refused before any adapter call.
3. `oi change run` with a mismatched hash exits 7 and writes nothing.
4. Piped stdin can never approve (exit 4).
5. Control characters from device output never reach the terminal as escapes.
6. `grep -R "auto-approve" apps packages plugins` returns nothing.
7. A job killed with `SIGKILL` mid-wave leaves per-target truth in `oi run show`.
8. `oi doctor` completes with no provider key and no network beyond fixtures.

---

## 16. Packaging

| Channel | Artifact | Notes |
|---|---|---|
| Release binary | `openinfra-<os>-<arch>.tar.gz` (macOS arm64/x64, Linux x64/arm64) | Node SEA (`node --experimental-sea-config`) bundling the engine, CLI, TUI and the pinned fork packages; notarised + signed on macOS |
| Homebrew | `brew install openinfra` | tap in this repo (`Formula/openinfra.rb`) |
| npm | `npm i -g openinfra` | same tarball layout; requires Node ≥ 22 |
| Docker | `ghcr.io/<org>/openinfra:<ver>` | for jump hosts/CI; EEs referenced by digest |
| Desktop app | later | ships the same binary as its engine |

Build (`scripts/build-openinfra.sh`): esbuild bundle → SEA blob → copy node → postject → codesign → smoke test
(``oi --version``, `oi doctor --json` on fixtures, PTY smoke of `oi tui`). Release job publishes checksums, the
`Formula`, and the SBOM. The fork's pinned commit and every EE digest are embedded in `oi --build-info` and enter
the plan hash.

---

## 17. Build order

Weeks assume one senior engineer full-time on the engine/TUI, with an optional second on adapters; the estimate is
honest but not padded. Every week ends with something runnable.

### W0 — 3 days: spike and skeleton

| Task | Deliverable | Acceptance |
|---|---|---|
| S1 renderer spike: same drift screen, Ink-inline vs viewport | numbers (fps under streaming, keystroke latency, 80×24 usability, tmux/SSH, bundle delta) recorded in §11.2 | DEC-1 closed with measurements |
| Verify the fork's chat package can be imported (F1) | small fork commit exporting `StreamView`, `ApprovalBox`, `Input`, `keys` (or the copy-with-attribution fallback) | `import { ApprovalBox } from '@deepseek-ai/dsh-terminal-chat'` builds |
| Verify headless engine without Electron | `node packages/openinfra-engine/src/cli-smoke.ts` | engine boots, prints version, no Electron imports |
| Skeleton monorepo, CI, lint, `node --test` | `pnpm -r test` green | CI green on a trivial PR |

### W1 — engine spine

| PR | Contents | Acceptance |
|---|---|---|
| 1 | `openinfra-protocol` events + view models (zod) | golden schemas; roundtrip tests |
| 2 | `openinfra-engine`: jobs, journals, artifacts (sha256, zstd), SQLite migrations | kill -9 test; artifact dedup test |
| 3 | `openinfra-testing`: fake device transport, 40 fixtures (ios-xe/nx-os/eos), cassettes | 200-device sweep under 15 s |
| 4 | `openinfra-core`: mode/budget wrapper, tool tiers, sanitize+redaction on results | invariant tests 2, 5 |
| 5 | `oi doctor` end-to-end on fixtures + `--json` + exit codes | golden output; no key needed; 0 network |

### W2 — reads and drift

| PR | Contents | Acceptance |
|---|---|---|
| 6 | `openinfra-inventory`: YAML/TOML loader + NetBox adapter (recorded API fixtures) | merge precedence tests; conflict findings |
| 7 | `openinfra-network`: SSH + NETCONF reads, normalisers, worker pool | parse rate ≥ 95% of fixtures; unreadable categorised |
| 8 | `openinfra-k8s` read-only gate + `openinfra-cloud` read-only inventory | gate refuses a write-capable role; connect output states grants |
| 9 | `openinfra-drift`: snapshots, fingerprints, transitions, severity, exit codes | dedup across 48 passes; `--fail-on` matrix |
| 10 | `openinfra-knowledge` + 6 skills | pack pinned in context; skill loads on demand |

### W3 — the TUI, part 1

| PR | Contents | Acceptance |
|---|---|---|
| 11 | TUI shell: router, reducer, keymap, sanitize, theme, statusbar, PTY harness | golden frames for empty/loading/error; keystroke latency budget |
| 12 | Drift screen: list, filter, detail, evidence → `$PAGER`, mute, recheck | 20-finding triage session in 2 minutes; every action has a CLI twin |
| 13 | Chat: mode pill, `@` targets, evidence (`ctrl-o`), `/` commands | cassette-driven; approval box rule tested |
| 14 | Toasts, errors, degraded modes, `--plain` | 40-col and `TERM=dumb` behaviour per §11.9 |

### W4 — change, approvals, runs

| PR | Contents | Acceptance |
|---|---|---|
| 15 | `openinfra-change`: render, checks, plan, hash, change file, check output | identical hash across runs; gate blocks a broken change |
| 16 | Approvals: TTY gate, typed hash, `ssh-keygen -Y sign/verify`, record format | forged/mismatched/replayed fail; CI verification recipe |
| 17 | `openinfra-iaac`: ansible-runner + tofu plan/apply saved plan, EE wiring | apply refuses without a plan file; no `-auto-approve` (grep test) |
| 18 | Waves, verification, rollback, run journal | mid-wave failure rolls back; interrupted run resumes reporting |
| 19 | Change + Run screens with streaming | approve and watch end-to-end in the TUI; run matrix matches journal |
| 20 | Packaging: SEA binary, brew formula, docker, `oi completion`, build info | `brew install` smoke on a clean container |

### W5 — hardening (the week that makes it trustworthy)

| Task | Acceptance |
|---|---|
| Fuzz the renderer (random bytes from device banners, model text) | no escape reaches the terminal; no crash |
| 8-hour soak: drift every 30 min over the fixture lab | flat memory, no fd leak, no duplicate findings |
| Chaos: kill at every phase of a run | journal always reconciles; exit codes correct |
| Docs: `README`, `docs/COMMANDS.md`, `docs/APPROVALS.md`, 3 asciinema demos | a new user reaches first drift in < 10 min |
| Security review of §13 checklist | every row has a passing test |

### Demo script (the thing we show)

1. Fresh container, `brew install openinfra`, `oi init`, `oi doctor` → readiness report in 12 s, no key.
2. `oi tui` → drift inbox from last night's pass; `x` explains a BGP finding with evidence.
3. `c` → change drafted on a branch; checks run; `a` → types the hash, signs; `r` → waves stream; one target
   fails, rollback runs; `oi run show --audit` prints the chain.
4. `oi drift check --fail-on high` in CI → exit 2; a policy violation → exit 3.
5. Pull the network cable on the lab switch → `unreadable` appears within one cycle, not a green dashboard.

---

## 18. Decisions and risks

### 18.1 Decisions

| ID | Decision | Status |
|---|---|---|
| DEC-1 | Renderer: Ink-inline vs viewport (`pi-tui`) for dashboards | **open**, closed by S1 in W0 |
| DEC-2 | Chat reuse: fork export commit (F1) vs copy-with-attribution | **open**, W0 |
| DEC-3 | Screens live in `apps/openinfra-tui`, one small fork commit for exports | proposed |
| DEC-4 | Subagent fan-out in-process for reads; sessions only for separate work | proposed |
| DEC-5 | `SKILL.md` is the only skill format; runtime registry emits it | proposed |
| DEC-6 | Approvals signed with SSH keys in v0.1 | proposed |
| DEC-7 | `~/.openinfra` separate from the Harness home | proposed |
| DEC-8 | Terraform detected, never bundled; OpenTofu is the default suggestion | proposed |
| DEC-9 | No `client.js` half for OpenInfra plugins (UI is not React) | proposed |
| DEC-10 | k8s writes are out of scope, not deferred (read-only is a product position) | proposed |

### 18.2 Risks specific to this milestone

| Risk | Early signal | Mitigation |
|---|---|---|
| Renderer spike picks wrong, screens get rewritten | W0 numbers contradict assumptions | backend abstraction; only the two dashboards are backend-specific |
| Chat reuse blocked by missing exports | F1 takes > 1 day | copy the ~1.2k-line chat with attribution (MIT) and track upstream |
| Device fixtures too clean | adapters pass but the lab fails | nightlies against a real lab; collect messy real banners (sanitised) |
| Compaction loses an approval/evidence link | invariant test 1 fails | protected-fact list in one module; policy tests in CI |
| TUI scope creep (the upstream failure mode) | a PR adds a chart/map | §11.12 list; a decision record is required to add a surface |
| Approval friction → people script around it | requests for `--yes` | documentation shows the CI recipe (drift gates, exit 4); no bypass exists |
| Performance regression unnoticed | budget table drifts | benches in CI with thresholds, no merge on regression |
| Two renderers rot | inline path untested | golden frames run for both backends in CI |

---

## 19. Appendix

### 19.1 Exit codes (the contract)

| Code | Meaning | Typical use |
|---|---|---|
| 0 | success / no drift / verified | pass |
| 1 | usage or internal error | fail |
| 2 | drift present | notify, do not fail the build |
| 3 | policy/check gate failed | fail |
| 4 | approval required, unavailable (non-interactive) | block, request approval |
| 5 | unreadable targets above threshold | fail: cannot attest |
| 6 | verification failed after apply | page |
| 7 | plan hash mismatch / stale approval | re-plan, re-approve |
| 8 | toolchain unsatisfied / verification failed | fix the toolchain |
| 9 | no workspace / ambiguous workspace | create or select one |

### 19.2 Command cheat sheet

```
oi init [--sot netbox|yaml|both] [--ci github|gitlab|none]
oi doctor [--json] [--fix-suggestions]
oi inv list|show|diff|validate|import
oi drift check [--sources …] [--fail-on high|medium|low|none] [--offline]
oi drift list|show|explain|mute|ack
oi ask "<question>" [--show-context] [--json]
oi change new|show|diff|check|approve|run|verify|rollback|close|restore
oi run list|show --audit|logs|stop
oi kb list|show|update|pin
oi config validate|show|set
oi tui [--screen inline|viewport|auto] [--plain] [--session <id>]
oi completion bash|zsh|fish
```

### 19.3 `SKILL.md` template used for our six skills

```markdown
---
name: config-drift
description: Read a drift finding correctly — normalisation, severity, transitions, ownership — and decide whether to explain, mute with a reason, or open a change.
---

# Config drift

## What a finding is
… (semantics, what "unreadable" means, why transitions are not polls)

## Reading the evidence
… (intended vs actual, the query, the timestamp, the artifact hash)

## Deciding
… (when muting is correct; when a change is needed; never propose a write from a finding)

## Do not
… (do not infer missing devices; do not report a configured value you did not read)
```

### 19.4 Fixture format (fake device)

```yaml
# fixtures/devices/ios-xe/sw-c-01.yaml
platform: ios-xe
prompt: "sw-c-01#"
latency_ms: 40
exchanges:
  - send: "show running-config"
    reply: |
      Building configuration...
      Current configuration : 8120 bytes
      ! Last configuration change at 02:58:11 UTC Thu Oct 22 2026
      hostname sw-c-01
      vlan 230
       name access-230
      interface GigabitEthernet1/0/1
       switchport access vlan 230
      end
  - send: "show version"
    fail: timeout_after_5s
```

### 19.5 Day-1 checklist (copy into the first PR description)

- [ ] `pnpm -r test` green; lint clean; no `client.js` in OpenInfra plugins
- [ ] `oi --version` < 150 ms; `oi doctor --json` on fixtures with `OPENINFRA_NO_NETWORK=1`
- [ ] `Grep -R "auto-approve"` empty; `change.approve` unreachable from the tool layer (unit test)
- [ ] Sanitize fixtures (OSC 52, CSI, C1, newline in filename) pass
- [ ] Redaction fixtures (community strings, keys, bearer tokens) pass
- [ ] One PTY golden frame per screen; `--plain` path tested
- [ ] Budget table enforced on `agent/pre-step` with a cassette test
- [ ] Journal reconciles after `SIGKILL` in each phase (four tests)
- [ ] Docs updated: `docs/COMMANDS.md`, `docs/APPROVALS.md`, `docs/TROUBLESHOOTING.md`

---

_Next review: after W0, when DEC-1 and DEC-2 are closed with measurements. Changes to §11 (the TUI) or §13
(security) require a decision record appended to §18.1._
