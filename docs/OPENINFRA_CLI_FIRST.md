# OpenInfra, CLI and TUI first

_Revision 1 of the sequencing decision, 2026-10-22. Supersedes §11 (roadmap) of [OPENINFRA_PLAN.md](OPENINFRA_PLAN.md);
everything else there — object model, safety model, integrations, knowledge pack, drift design — still holds._

**The question.** Should OpenInfra be a CLI/TUI product first, with the desktop app coming later, instead of the
desktop-first order in the plan?

**Short answer.** Yes — but split the sentence into two products, because they have different jobs:

| | What it is | Who it is for | Cost | Why first |
|---|---|---|---|---|
| **`openinfra` (CLI)** | deterministic verbs over the engine, with JSON out and real exit codes | CI, cron, runbooks, jump hosts, scripts, other agents | lowest | it is the product's spine; the desktop can never be the source of truth |
| **`openinfra tui`** | an interactive *review* surface (3 screens) | the engineer at 02:00 with a tmux session | medium | it is where approvals and drift triage feel good |
| **OpenInfra Studio (desktop)** | the same engine plus rich panes, browser, dashboards, images | mixed teams, demos, people who don't live in a terminal | highest | it is a *skin*, and shipping it first would make the engine app-shaped |

The trap in "CLI first, then desktop" is treating the TUI as a cheap desktop prototype. It isn't: the TUI is a
different instrument with different strengths, and if it is built as a stopgap it will be thrown away. Build it
as a keeper, and build the CLI as the contract both front-ends sit on.

---

## 1. Why this order is right for *this* product (not in general)

**1. The engine is file-first, so the surface is a choice.** Inventory, intent, findings, changes, runs, evidence
and knowledge all live in git + SQLite + blobs. Nothing essential needs a window. That was a deliberate choice
in the plan (§3, §4.4) and it is what makes CLI-first possible without a rewrite later.

**2. The valuable half of the product has no model in it.** `doctor`, inventory merge, snapshot, normalise, diff,
fingerprint, policy, plan, verify — all deterministic. A CLI can ship that value with **no API key configured**.
That is a striking demo: "install this, run `oi doctor`, get a readiness report on 200 devices, zero tokens,
zero credentials beyond read-only." A desktop app that requires a model key to do anything cannot make that
claim as cleanly.

**3. The audience already lives there.** NetDevOps/DevOps engineers run `kubectl`, `tofu`, `ansible`, `ssh`,
`tmux`, `jq`, `delta`. A tool that appears in their prompt with the right exit codes gets adopted in an
afternoon; a 300 MB Electron app is a procurement conversation. And the alternative tools in this space are all
CLI (Batfish, nornir, Nautobot jobs, `terraform plan`).

**4. Approvals in a terminal can be *stronger* than a click.** Typing a plan-hash prefix and signing it with an
SSH key (§6) produces an artefact a CI job can verify. A button click produces a row in a local database.

**5. Distribution and locked-down environments.** Jump hosts, bastion VMs, CI runners, air-gapped labs, SSH
sessions where nothing may be installed but a single binary. Electron is impossible in half of these.

**6. The desktop gets *easier* afterwards.** Once the engine speaks a stable protocol with JSON events, the
desktop becomes one more renderer. Building it first would have baked UI concerns (panes, React state, long
sessions) into engine decisions.

**7. This repository already has the pieces, and it already made the terminal decisions.** See §2.

**When this order would be wrong:** if the buyer is a manager who wants screenshots, if the differentiator were
topology visualisation or side-by-side diffing (terminals are bad at both), or if the product were sold to
NOC staff with no shell. None of those is the wedge — the wedge is drift and gated change for engineers.

---

## 2. What the repository already gives us (and what it gets wrong for CLI-first)

Verified in this checkout today:

| Asset | Where | Use for OpenInfra |
|---|---|---|
| Inline terminal chat under Ink 5.2.1 + React 18.3.1, StreamingText, tool lines, spinner, status line, `/` menu, inline approval box, key splitting, control-character escaping, fallback to the line chat | `docs/TUI_PLAN.md` stages 1–4; fork `packages/ui/terminal-chat` + `packages/bundle/headless/src/chat-*.ts` | the TUI's chat half is **already written and live-tested**. Do not build another one |
| Hard rules from that work: escape model/tool text before drawing; an approval is never answered by text typed before it appeared (default **No**); streamed text can be withdrawn | `docs/TUI_PLAN.md` §"Risky defaults" | carry them into every OpenInfra TUI screen, not just chat |
| The headless runner: one task, `--json`, `--session-id`, session logs | fork `packages/bundle/headless` | the CLI's plumbing; reuse, don't duplicate |
| Hooks + permission rules in Claude Code's format, including deny/ask | `plugins/hooks`, `plugins/compact` | the guardrail file that stops the agent running `ansible-playbook` itself |
| Sandbox with read-only hold (plan mode), network allowlist, secret-file protection | fork patches 15, 16, 20 | "read tier" enforcement in the CLI and TUI |
| Watch subsystem that runs checks with no model | `plugins/watch` | drift scheduling in the engine, no agent loop needed |
| Artifact/dashboard/evidence patterns | `plugins/devpreview` | evidence store, HTML reports later |

**Three things the current shape gets wrong for CLI-first, and must change:**

1. **The terminal command is a child of the desktop app.** It is installed from a menu item
   (`/usr/local/bin/harness-studio`, patches 17 and 27) and runs the app's Electron binary as Node; the AppImage
   ships **no** command at all. CLI-first inverts this: `openinfra` must be installable on its own
   (`brew`, `npm i -g`, a single binary, Docker), and the desktop must become *optional*. Keeping both paths is
   fine; making the app-managed one primary is not.
2. **One front-end exists, and it is React DOM.** Plugins' `client.js` halves cannot render in Ink. OpenInfra
   must not ship UI logic in React; the host must emit **view data** (JSON) that each renderer draws (§4.3).
3. **Upstream removed its own TUI on purpose** (7.7k lines on a patched `pi-tui`, deleted August 2026) and asks
   any return for a *named product, its own package, and PTY acceptance tests*. We happen to be that named
   product — so we accept the obligation: the TUI lives in its own package, has PTY tests, and never leaks into
   the headless runner.

---

## 3. The shape: one engine, three skins, one protocol

```
                      ┌──────────────────────────────┐
   oi … (scripts, CI) │  openinfra-cli               │
                      │  verbs · exit codes · JSON   │
                      ├──────────────────────────────┤
   oi tui             │  openinfra-tui (Ink)         │──┐
                      │  3 screens + chat            │  │   same JSON
                      ├──────────────────────────────┤  ├──▶  engine RPC ──▶ adapters (SSH/NETCONF/
   desktop shell      │  openinfra-studio (Electron) │──┘      over stdio     RESTCONF/k8s/cloud/netbox)
                      │  panes · browser · reports   │         or HTTP        + EEs (containers)
                      └──────────────────────────────┘
```

**Rules that keep the three honest:**

- **R1 — Every TUI action has a CLI form.** If it can be done in the TUI, it can be scripted. No exceptions for
  "convenience" actions (including approve — see §6).
- **R2 — The engine never prints.** It emits events (`ndjson`) and returns data. Printers live in the CLI and the
  TUI. This is what makes `--json` and the TUI the same code path.
- **R3 — No TTY, no prompt.** Anything interactive requires a real terminal; without one it fails with a
  specific exit code (§5.2) rather than hanging or guessing.
- **R4 — State is shared, not per-surface.** `~/.openinfra/` (config, DB, artifacts, credentials refs) and the
  repo's `.openinfra/` are the same for all three skins. Approve in the TUI, see it in `oi change show --json`,
  run it from CI.
- **R5 — The agent is additive.** Every deterministic verb works with no model configured. Agent verbs
  (`ask`, `explain`, `draft`, `triage`) are clearly marked and never required for a change to proceed.

---

## 4. The CLI

**Name.** `openinfra`, alias `oi`. (`infra` collides with existing tools; `oi` is fast to type and unambiguous.)

**Verb grammar** — noun-first, like `git`/`kubectl`, because operators think in objects:

```
oi init [--sot netbox|yaml|both] [--ci github|gitlab|none]
oi doctor [--json] [--fix-suggestions]
oi inv list|show|diff|validate|import            # inventory & SoT
oi ask "<question>" [--evidence] [--json]        # agent, read tier only
oi drift list|show|explain|mute|open             # findings
oi drift check [--sources devices,tofu,k8s,cloud] [--exit-code]
oi change new|show|diff|check|approve|run|verify|rollback|close
oi run list|show|logs|stop
oi verify <change> [--wait]
oi kb list|show|update|pin                       # knowledge pack
oi tui                                           # the interactive surface
oi mcp serve                                     # expose read verbs to other agents (later)
```

**Output contract.**

- Human output is compact tables with a total line; `--json` is a single JSON document; `--events jsonl` streams
  progress (one object per line: `target`, `phase`, `status`, `detail`) for CI logs and other tooling.
- `NO_COLOR`, `CLICOLOR_FORCE`, `TERM=dumb` respected; everything degrades to plain text; no spinner when not a TTY.
- Every command supports `--offline` where a cache exists (drift from stored snapshots, `show`, `diff`,
  `explain`) so an incident on a plane or in an air-gapped lab still works.
- Every mutating verb supports `--dry-run` and prints the plan it *would* run.

### 4.1 Exit codes (the CI contract)

| Code | Meaning | Typical gate |
|---|---|---|
| 0 | success / no drift / verification passed | pass |
| 1 | usage or internal error | fail |
| 2 | drift or differences present (mirrors `terraform -detailed-exitcode`) | notify, don't fail the build |
| 3 | policy or check gate failed (`conftest`, `ansible-lint`, parse, blast radius) | fail |
| 4 | approval required but not available (non-interactive) | block, open a PR |
| 5 | too many targets unreadable (threshold from config) | fail: cannot attest |
| 6 | verification failed after apply | **page someone** |
| 7 | plan hash mismatch / stale approval | fail: re-plan and re-approve |

These are stable, documented, and tested — they are an API. `oi drift check` returning 2 on new findings and 5 on
"couldn't read 12 devices" is the difference between a tool you can wire into a pipeline and one you watch.

### 4.2 Example: the ten-minute first run, in a terminal

```console
$ oi init --sot both --ci github
wrote .openinfra/config.toml
wrote inventory/example.yaml (3 devices — replace with yours)
wrote .github/workflows/openinfra-drift.yml
wrote .gitignore entries for .openinfra/artifacts/
next: oi doctor

$ oi doctor
OpenInfra 0.1.0 · profile: lab · model: not configured (agent verbs off)

Inventory    netbox 4.7.3 · 214 devices · 1,932 interfaces · token read-only ✓
             inventory/*.yaml · 214/214 covered · 9 objects without a source of truth
Devices      181/214 reachable (22) · 27 netconf (830) · 6 restconf (443)
             unreachable: 27 — 19 timeout (mgmt vlan), 8 auth failed  → oi doctor --json
Parsers      ios-xe 96/98 · nx-os 44/44 · eos 38/38 · unsupported 3
Kubernetes   prod-eu · 1.35.9 · view role verified ✓ · secrets denied ✓
Cloud        aws:1234 · ReadOnlyAccess + denies ✓ · write actions in policy: 0
Intent       tofu 1.13.0 · k8s manifests · rendered ok 214/214
             no drift check has run yet → oi drift check --sources devices

12.4 s · 0 model tokens · 0 writes attempted
```

### 4.3 Agent verbs vs. deterministic verbs

| Kind | Examples | Needs a key | Sandbox | Writes |
|---|---|---|---|---|
| Deterministic | `doctor`, `inv`, `drift check`, `change check`, `run`, `verify` | no | command sandbox, read tier | only through the change engine |
| Agent, read tier | `ask`, `explain`, `triage`, `draft` | yes | command sandbox, read tier, read-only fs | none |
| Agent, plan tier | `draft --write` (edits intent on a branch) | yes | workspace only | git branch, no devices |

`oi ask` without a key prints: *"agent verbs need a provider key (`oi config set provider`); deterministic verbs
work without one: oi doctor, oi drift check."* No mystery, no upsell wall.

### 4.4 The feel of the CLI (grilled)

- **Fast.** `oi doctor` on a 200-device inventory must be under 15 s warm, and it must parallelise reads (nornir
  style, ~50 concurrent) with a progress line on stderr, not stdout — so `oi doctor > report.txt` stays clean.
- **Quiet by default, loud on failure.** One screen of output for the happy path; on failure, the first line
  names the command to run next (`→ oi drift show drift_01J9…`).
- **Never a wall of YAML.** Tables with truncation and a "12 more · use --all" line.
- **Pipes are first class.** `oi drift list --json | jq '.[] | select(.severity=="high")'`,
  `oi change show NET-142 --json | jq .plan.hash`, `oi inv list --json | jq -r '.[] | select(.site=="bldg-c") | .name'`.
- **Shell completion** (`oi completion bash|zsh|fish`) and a `--help` that fits in 40 lines.
- **Idempotent.** Running `oi change check` twice returns the same hash and byte-identical artifacts.

---

## 5. The TUI

**Do not rebuild the chat.** `docs/TUI_PLAN.md` stages 1–4 already ship an inline Ink chat: streaming
answers, `⏺` tool lines with `⎿ ✓/✗`, spinner with elapsed time, bordered multi-line input with history, `/`
menu with Tab completion, an inline approval box defaulting to **No**, control-character escaping, and a
fallback to the line chat on dumb/narrow terminals. OpenInfra's TUI adds three screens around it and stops.

### 5.1 Three screens, three keybinding grammars already familiar

| Screen | Command | Looks like | Why this grammar |
|---|---|---|---|
| **Ops / drift triage** | `oi tui` (default) | three panes: findings list, selected finding detail, evidence footer | `k9s`/`lazygit` muscle memory: `j/k` move, `enter` open, `f` filter, `/` search, `x` explain (agent), `c` open change, `m` mute with reason, `r` refresh, `?` help, `q` quit |
| **Change review** | `oi tui open NET-142` | header (id, hash, targets, env, blast radius), checks panel, diff (delegated to `$PAGER`), waves + approvals | review is where terminals are strongest: the diff goes to `git delta`/`difftastic` if installed, else `diff -u` in the pager. `a` approve (type the hash prefix), `r` run, `v` verify, `l` logs, `esc` back |
| **Run / live** | `oi tui run NET-142` | per-target matrix streaming: `sw-c-01 ✓ 3.2s`, `sw-c-02 ✗ verify: vlan-up` | one glance answers "how far did it get and where did it stop" |

The chat stays **inline** (scrollback keeps history, terminal search/copy work), the two dashboards use the
alternate screen (they are dashboards, like `k9s`). Resize, 80 columns, tmux, SSH and no-mouse all work; under
60 columns each screen has a stacked single-pane mode.

```
┌─ Drift ─────────────────────────────── 7 open · 3 high · last check 03:12 ─┐
│ HIGH  sw-c-01   BGP neighbor removed from running-config      1 device     │
│ HIGH  sg-0f2a   0.0.0.0/0:22 on 3 resources                   aws eu-w1    │
│ MED   vlan 240  missing on 1 of 12 bldg-c switches            bldg-c       │
│ MED   api-gw    image differs from git                        k8s prod-eu  │
│ LOW   14 EC2    unmanaged (shadow infra)                      aws eu-w1    │
├─ drift_01J9… ──────────────────────────────────────────────────────────────┤
│ intended  netbox:device/821 → neighbor 10.40.0.6 (as 64512)               │
│ actual    ssh://sw-c-01 · running-config @ 03:12:41Z · removed 02:58      │
│ owner     team-network (netbox tenant)   commit 4f2c1a (07:40, @you)      │
│ evidence  artifacts/41ab…/sw-c-01.running-config · diff.patch             │
├────────────────────────────────────────────────────────────────────────────┤
│ x explain   c open change   m mute   o pager   r refresh   ? help          │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 What the TUI deliberately does not do

No topology maps, no SVG, no charts, no side-by-side diffs (delegate to the pager/tool the user already
configured), no image or PDF preview, no browser pane, no mouse-first interactions, no dashboards. Each of those
is a desktop job. A TUI that tries to be the desktop is exactly the maintenance tax upstream deleted.

**Also:** the TUI must never be the only way to see something important. Anything its panes show, `--json`
shows too (R1).

---

## 6. Approvals in a terminal (the part worth grilling hardest)

The desktop plan binds an approval to a plan hash. In a terminal we can do better than a click:

```
$ oi change approve NET-142
Change NET-142 · Add VLAN 240 to Building C access switches
plan sha256:9f2c4b71e0aa…   targets 12 · env prod · waves canary → small → rest
checks: ansible-lint ✓  batfish parse ✓  conftest 4/4 ✓  tofu plan no-change ✓

Type the first 8 characters of the plan hash to approve: 9f2c4b71
sign this approval with your SSH key? [Y/n] y
signed by ~/.ssh/id_ed25519.pub (SHA256:9f0a…) · approval written
→ git commit -S?  no.  approval record: .openinfra/changes/NET-142/approvals/2026-10-22T09-14-03Z.json
→ oi change run NET-142
```

Why this is stronger than a button:

- **Human presence is provable.** Approve requires a real TTY, typing the hash prefix, and access to a signing
  key. An agent cannot do it from inside its sandbox (no TTY; and the guardrail rules deny `oi change approve`),
  and neither can a prompt-injected script.
- **Portable proof.** `ssh-keygen -Y sign` / `-Y verify` is standard, needs no new PKI, and the resulting
  signature is verifiable in CI and by auditors (`oi change verify-signature NET-142`, `--allowed-signers`).
- **The hash is typed, not clicked**, so "approve the thing I looked at" is a deliberate act. (Same principle as
  the terminal chat's rule that queued input can never answer an approval.)
- **Two-person rule** in team mode = a second signature from a different key; `oi change approve --co-sign`.
- **No TTY, no approval.** In CI, an unapproved change exits 4 with a link/command to approve. There is no
  `--yes`. (A `--force` would be read as an invitation.)

Failure paths, decided up front: signing key unavailable → approval refused, not degraded; hash mismatch after
approval → exit 7 and re-plan; approval older than the intent change → invalid; approval for a different target
set → invalid (the hash covers targets).

---

## 7. Distribution

| Channel | Command | Notes |
|---|---|---|
| Single binary (primary) | `brew install openinfra`, GitHub release, `curl -fsSL … \| sh` | built per platform from this repo (macOS arm64/x64, Linux x64/arm64, Windows later). Node SEA or Bun compile: ~50–90 MB, acceptable |
| npm | `npm i -g openinfra` | for the Node crowd; must not require the desktop app |
| Docker | `ghcr.io/…/openinfra:0.1` | jump hosts and CI; also carries the EE images' baseline tooling |
| Desktop app (later) | dmg/deb/AppImage | ships the same engine; **must not be required by the CLI** |
| Air-gapped | tarball + image digests | checksums signed; knowledge pack included |

**Engineering decision this forces:** the engine depends on the fork's `@deepseek-ai/dsh-*` packages, which are
not published to npm. Two viable answers: (a) build a bundled CLI binary from the fork at release time
(recommended — no new public packages, exact pin in the binary, one artifact), or (b) publish scoped packages and
pin them. (a) keeps the license story simple (MIT) and the supply chain short. The desktop build then consumes
the same bundled engine instead of re-implementing the CLI's plumbing.

Second decision: **`~/.openinfra` is the home for everything** (SQLite, artifacts, credentials refs, sessions),
with `OPENINFRA_HOME` to relocate it. Harness's own home stays untouched so the app and the CLI can coexist.

---

## 8. Revised roadmap (replaces OPENINFRA_PLAN.md §11)

| Phase | Weeks | Deliverable | Exit criteria |
|---|---|---|---|
| **0. Spine** | 2 | monorepo layout (`openinfra-engine`, `-cli`, `-tui`, desktop later); bundled single binary; `oi init`, `oi doctor`, `oi config`, `oi --json`, exit codes; credential store + read/write tiers; guardrail rules | `curl \| sh` on a clean Linux box, run `oi doctor` against a lab with **no** model key; every command has `--help`, `--json`, stable exit codes |
| **1. Read truth** | 4 | inventory merge (NetBox 4.7 + YAML/TOML), target resolution, device read adapters + normalisers, k8s read-only + RBAC gate, cloud read-only, `oi ask` (agent, read tier), Python scratchpad | 200-device lab in <15 s warm; evidence on every claim; zero write verbs reachable; 95% fixture parse |
| **2. Drift for CI** | 4 | `oi drift check` with exit codes 2/5, fingerprints and transitions, SQLite store, `--offline`, digest notifications, GitHub Actions recipe | a week of polling with <1% false positives; a CI job that fails only on tier-1 drift; 0 tokens while idle |
| **3. Change pipeline** | 5 | change files on intent branches, render/check/plan/hash, **SSH-signed approvals**, waves, verification, rollback, `oi run` + `oi verify`, PR creation | 5 real changes reviewed by someone who didn't write them; a broken change caught pre-wave-1; mid-wave failure rolls back cleanly; approval verifies in CI |
| **4. TUI** | 3 | the three screens on the existing Ink chat, PTY acceptance tests, asciinema demos. Base, gaps and the renderer spike: [OPENINFRA_TUI_HARNESS.md](OPENINFRA_TUI_HARNESS.md); the full build plan: [TUI.md](TUI.md) | approve + triage + watch a run entirely in the TUI; PTY tests green in CI; fallback to plain output on dumb terminals |
| **5. Desktop** | 6 | OpenInfra Studio shell over the same engine: Inventory page, Change sheet, Drift inbox, Evidence pane, Dashboards, reports | desktop can do nothing the CLI cannot; state is shared; first-run on macOS/Linux |
| **6. Team mode** | 8+ | runner service, Postgres, SSO, approval queues, audit export, policy bundles | — |

Phases 0–3 are the product. Phase 4 is what makes engineers love it. Phase 5 is what makes a buyer sign. If
resources shrink, cut in that order, not the other way round.

---

## 9. Grilling: objections and verdicts

| Objection | Verdict | Reasoning / consequence |
|---|---|---|
| "A CLI isn't a product, it's a feature." | **False here.** | For this audience the CLI *is* the distribution and the integration surface. Terraform, Ansible, kubectl, Batfish, nornir, `gh` are products. |
| "The TUI is a cheap prototype that you'll throw away." | **Only if built as one.** | Budget 3 screens, reuse the shipped Ink chat, add PTY tests. If a screen needs a chart or a diff viewer, it moves to the desktop instead of being hacked in. |
| "You'll maintain two front-ends badly." | **Real risk, mitigated.** | No parallel UI work: desktop doesn't exist until phase 5. Views are data (R2). Parity rule (R1) makes divergence a test failure, not a discovery. |
| "Terminals are bad at reviewing 1,200-line diffs." | **True, and not our job.** | Delegate to `delta`/`difftastic`/`vimdiff` via `$PAGER`/`$EDITOR`. The TUI's job is *blast radius, checks, hash, waves*, which fit in 30 lines. Desktop adds side-by-side later. |
| "Approvals typed in a shell are worse UX." | **Opposite.** | Hash prefix + SSH signature is a portable, verifiable artefact. A click is a local row. The only cost is 8 characters. |
| "Enterprises want a UI." | **They want audit and approvals.** | Both are stronger in the CLI. Desktop sells the demo; the CLI passes the audit. Phase 5, not phase 1. |
| "Model-first is the differentiator; a model-less CLI is dull." | **The model-less part is the wedge.** | Zero-token drift detection is the story competitors can't tell cheaply. The agent then explains, drafts and triages on top. |
| "Ink under Node in a sandbox is heavy/fragile." | **Already solved here.** | Ink 5.2.1 was verified rendering under the app's Electron/Node 24.21 in a PTY (`docs/TUI_PLAN.md`). The bundled binary uses the same renderer. |
| "The fork's command depends on the desktop app." | **Must be fixed in phase 0.** | Standalone binary + `brew`/`npm`/Docker; keep the app's installer for people who have the app. AppImage users currently have no command at all — the new path removes that trap. |
| "You'll drift from upstream faster with a TUI." | **Contained by package boundaries.** | TUI is its own package with one call site into the runner, exactly as upstream asked. Engine changes go through the same merge ritual (`docs/FORK_PLAN.md`). |
| "Python would be more natural for netops." | **Keep one runtime.** | The product is Node/TypeScript; *automation* is Python, inside the EEs (`netmiko`, `nornir`, `pybatfish`) and in `oi exec python`. Two product runtimes would double the packaging matrix for no user-visible gain. |
| "What about Windows terminals?" | **Deferred, not blocked.** | Windows Terminal + Ink works; PTY and signing need care. Ship macOS/Linux first, as the app already does. |

---

## 10. Risks added by this order

| Risk | Mitigation |
|---|---|
| **TUI scope creep** (the upstream failure mode) | 3 screens, a written no-list (§5.2), PRs that add a 4th screen require deleting one |
| **Approval theatre** (people approve without reading) | typed hash prefix, blast radius above the fold, `--require-diff-viewed` option that opens the pager before approval |
| **CI misuse** (someone puts `oi change run` in a pipeline unattended) | run requires a signed approval that names a target set; non-TTY without approval exits 4; documentation shows drift-only CI recipes |
| **Terminal injection / fake prompts** | reuse the fork's escaping for *all* engine text (findings, device output, model text); evidence is wrapped and truncated, never raw-printed into the prompt area |
| **Binary size and signing on macOS** | notarised single binary; document the `xattr` path as the app does |
| **Two state homes** (Harness vs OpenInfra) | separate `~/.openinfra`; explicit migration note if the desktop predates the CLI |
| **PTY tests are deferred upstream** | they are a phase-4 gate here; `node-pty` + golden screens + a fake model/provider so CI needs no key |

---

## 11. Decisions this revision needs from you

1. **Binary name:** `openinfra` with `oi` (my preference), or something shorter/branded?
2. **Bundled single binary vs. npm package** as the primary channel (I recommend the binary, npm second).
3. **SSH-signature approvals** in v1, or plain typed-hash approvals first and signing in team mode? (I recommend
   signing in v1: it is ~150 lines and it is the audit story.)
4. **TUI screen count:** the three above, or do you want the Inventory browser as a fourth (I'd cut it; `oi inv`
   plus `--json`/`jq` covers it)?
5. **Does the desktop app keep the harness-studio command** for people who installed via dmg/deb, or do we
   replace it with a link to the standalone `openinfra` so there is only one binary to support?
6. **Model provider default for agent verbs** in the CLI: prompt on first use, or require `oi config set
   provider` explicitly (I prefer explicit, so CI never carries a key it doesn't need)?
