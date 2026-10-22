# OpenInfra — phased implementation and test plan

_2026-10-22 · v1. The build order for the whole product, phase by phase, with the tests and the exit gate for each.
Companions: [TUI.md](TUI.md) (TUI build detail), [WORKSPACES_AND_TOOLCHAIN.md](WORKSPACES_AND_TOOLCHAIN.md)
(workspaces, tool installs), [OPENINFRA_CLI_FIRST.md](OPENINFRA_CLI_FIRST.md) (CLI contract, approvals),
[OPENINFRA_PLAN.md](OPENINFRA_PLAN.md) (product and safety model)._

This revision adds three things the earlier plans did not settle: **the model layer** (Anthropic, OpenAI, NVIDIA
NIM, OpenRouter, any OpenAI-compatible endpoint, keys from the user), **bash as the primary tool** (the harness is a
CLI harness, so the shell *is* the interface), and **cron jobs** for Ansible, Terraform/OpenTofu, Python and Bash.
Everything below is sequenced so each phase ends with something demonstrable and a gate that can fail.

---

## 0. How to read this

- **P0–P9** are the v1.0 build. **P10** is post-v1 (team mode). Phases are sequential in gate order but several
  workstreams run in parallel (see §11).
- Every phase has: *goal · workstreams with task IDs · tests · exit gate · demo*. A phase is not "done" because
  the code merges; it is done when the gate's tests pass and the demo runs on a clean machine.
- Task IDs (`P3-T2`) are stable and are what issues and commit messages reference.
- "Gate" always includes: no regression in previous gates, docs updated, and the invariant suite green (§8.3).

**Effort assumptions.** Weeks assume **two senior engineers** (one engine/adapters, one CLI/TUI/product) plus
part-time design review. One engineer: multiply engine phases by ~1.5. Estimates are effort, not calendar padding.

---

## 1. What v1.0 is

A single Node binary, `openinfra`/`oi`, that a network/cloud engineer installs in ten minutes and uses daily:

1. **Workspaces** — named, git-tracked project folders with their own config, inventory, lockfile and history.
2. **Toolchain** — detects and (with consent) installs verified Ansible, OpenTofu/Terraform, kubectl/Helm, Python
   tools; never touches the system; pins versions in `openinfra.lock`.
3. **Reads** — devices (SSH/NETCONF/RESTCONF), Kubernetes (read-only, enforced three times), cloud (read-only),
   NetBox 4.7 or local YAML/TOML; every fact carries source, query, timestamp and raw output.
4. **Drift** — scheduled, fingerprint-transitional, severity-classified, exit-coded for CI, zero tokens when idle.
5. **Agent** — a bash-first harness on multi-provider models (Anthropic, OpenAI, NVIDIA NIM, OpenRouter, generic
   OpenAI-compatible), with skills, subagents, compaction, memory, and a knowledge pack of pinned tool versions.
6. **Change** — intent edits on a branch, render → checks → plan → hash → typed, SSH-signed approval → waves →
   verification → rollback → record.
7. **Cron** — scheduled drift, Ansible check-runs, Terraform/OpenTofu plans, Python and Bash jobs, with overlap
   locks, missed-run policy, notifications and exported schedules for systemd/cron/Kubernetes.
8. **TUI** — chat plus Drift, Change, Run, Setup and Tools screens, with a CLI twin for every action.

**Not v1.0:** cloud/k8s/NetBox writes, gNMI, SNMP, Windows, multi-user, web UI, topology diagrams, auto-remediation.

---

## 2. Deltas since the earlier plans

| Area | Earlier plan | Now | Why |
|---|---|---|---|
| Model layer | "any provider the fork supports" | **four named providers + generic OpenAI-compatible**, capability probes, per-provider cost, recorded model identity | the four the owner asked for, and users bring keys |
| Tool surface | `infra_*` typed tools first | **bash is the primary tool**; typed `infra_*` tools are thin, deterministic wrappers over it; read/write/edit/grep/glob as in every CLI harness | CLI-first means the shell is the interface; fewer bespoke tools is less surface to break |
| Scheduling | drift schedules on the Watch plugin | **a first-class scheduler** for four job kinds, with export to the system scheduler | the owner wants cron for Ansible/Terraform/Python/Bash |
| Safety | approvals for changes | unchanged, plus **command classification** for the bash tool and **standing approvals** for scheduled writes | bash broadens the attack surface; scheduling broadens the blast radius |

---

## 3. Phase overview

| Phase | Weeks | Theme | Gate in one line |
|---|---|---|---|
| **P0** | 2 | Foundations: spike, skeleton, CI, protocols | renderer decision recorded; repo builds and tests on a clean container |
| **P1** | 3 | Engine spine: store, artifacts, jobs, journal, `doctor` | `oi doctor` on fixtures, no key, < 15 s, truth survives `kill -9` |
| **P2** | 2 | Workspaces + toolchain | `oi workspace new` + verified install of uv/ansible-core in a fresh container |
| **P3** | 2 | Model layer: 4 providers + generic, probes, cost | every provider answered with a real key; cassettes replay offline; keys never reach the agent |
| **P4** | 2 | Bash-first tool surface + sandbox hardening | a red-team list of commands is classified, denied or approved correctly |
| **P5** | 3 | Reads: inventory, devices, k8s, cloud | 200-device lab read end-to-end, every fact with evidence |
| **P6** | 3 | Drift + scheduler (cron) | a week of scheduled checks with < 1% false positives and 0 tokens idle |
| **P7** | 3 | Change engine, approvals, waves, rollback | a real change approved and run in waves; a broken one stopped pre-wave-1 |
| **P8** | 3 | TUI: five surfaces + chat | triage → approve → watch a run entirely in the TUI; PTY tests in CI |
| **P9** | 2 | Packaging, hardening, docs, beta | `brew install`, air-gap bundle, 8-hour soak, security checklist signed |
| | **≈25** | | **v1.0 release candidate** |
| P10 | 8+ | Team mode: runner service, SSO, shared store, audit export | post-v1 |

---

## 4. P0 — Foundations (2 weeks)

**Goal.** Kill the two unknowns that change architecture, then stand up the repo so every later phase has a place
to land.

| ID | Task | Detail | Depends |
|---|---|---|---|
| P0-T1 | Renderer spike (S1) | Build the Drift screen twice (Ink-inline vs `pi-tui` viewport); measure fps under streaming, keystroke latency, 80×24 usability, tmux/SSH, bundle delta; record numbers in [TUI.md](TUI.md) §11.2 | — |
| P0-T2 | Chat reuse decision (F1) | Fork export commit for `StreamView`/`ApprovalBox`/`Input`/keys, or copy-with-attribution; time-box 1 day | — |
| P0-T3 | Headless engine proof | Boot the engine under plain `node` (no Electron), print build info | — |
| P0-T4 | Monorepo skeleton | `apps/`, `packages/`, `plugins/openinfra-*`, ESLint/Biome, `node --test` runner, tsconfig, CI matrix (macOS arm64, Linux x64) | — |
| P0-T5 | Protocol v1 | zod schemas: events, view models, config, approval, finding, change, `schedule.toml`, provider config; golden JSON | P0-T4 |
| P0-T6 | Invariant harness | The 8 must-never-break tests from [TUI.md](TUI.md) §15 stubbed and wired to CI (some skip until their phase) | P0-T4 |

**Tests.** CI green on a trivial PR; protocol golden round-trip; spike results committed as a table, not prose.

**Gate.** Renderer decision closed with numbers; chat reuse path chosen; `pnpm -r test` green on a clean container.

---

## 5. P1 — Engine spine (3 weeks)

**Goal.** The deterministic core every other phase stands on: jobs that survive crashes, artifacts addressed by
content, a SQLite store, and `oi doctor` telling the truth.

| ID | Task | Detail |
|---|---|---|
| P1-T1 | Job runner | `Job` = id, kind, spec, journal (`runs/<id>/journal.ndjson`, fsync per event), cancel, timeout, retries, child process-group kill, resume/reconcile on start |
| P1-T2 | Artifact store | sha256 content-addressed blobs, zstd, index table, `oi artifact show`, dedup, GC policy (30/90 days) |
| P1-T3 | SQLite store | WAL, `busy_timeout`, migrations, tables from [TUI.md](TUI.md) §6.2; `openinfra.db` in `~/.openinfra` |
| P1-T4 | Config loader | `.openinfra/config.toml` with strict unknown-key errors, `${env}` and `keychain:` references, `oi config validate|show` |
| P1-T5 | Fake device transport + fixtures | scripted prompt/response YAML for ios-xe/nx-os/eos; latency, timeout, auth failure, garbage, banner injection; 40 scenarios |
| P1-T6 | `oi doctor` | inventory counts, reachability by transport, parser coverage, k8s/cloud/source checks, toolchain status; `--json`; exit codes; < 15 s warm on 200 fake devices |
| P1-T7 | Exit-code module | the full table (0–9) in one place, unit-tested, used by every verb |

**Tests.** `kill -9` at each journal boundary → `oi run show` reconciles; artifact dedup; config typo rejected with a
useful message; doctor performance budget; 200-device sweep with 12 failures of 3 kinds merged correctly.

**Gate.** `OPENINFRA_NO_NETWORK=1 oi doctor --json` on the fixture lab, no key configured, under 15 s; crash tests
green; store migration test from an empty file.

---

## 6. P2 — Workspaces and toolchain (2 weeks)

Full detail in [WORKSPACES_AND_TOOLCHAIN.md](WORKSPACES_AND_TOOLCHAIN.md). This phase implements it.

| ID | Task | Detail |
|---|---|---|
| P2-T1 | Workspace model | `workspace.toml` with stable `id`, registry `~/.openinfra/workspaces.json`, discovery by walking up, rename/move/remove/export/import |
| P2-T2 | Templates | `network-core`, `cloud-iac`, `k8s-ops`, `lab`, `empty`; `.gitignore`, `AGENTS.md`, config, initial commit |
| P2-T3 | Recipe engine | YAML recipes, platform asset tables, verification ladder (pinned sha256 → publisher signature/attestation → PyPI hash), smoke checks, `.ready` swap |
| P2-T4 | Providers | `managed` (`~/.openinfra/toolchains/<tool>/<v>`), `system` (detect only), `container` (digest-pinned EEs), `imported` (mise/asdf) |
| P2-T5 | Python bootstrap | uv recipe; `uv tool run` per version; ansible-core + collections into the workspace |
| P2-T6 | Lockfile | `openinfra.lock` (tool, version, provider, digest, verified, collections, smoke) + hash integration hook for P7 |
| P2-T7 | `oi tools` verbs | `doctor`, `install`, `lock`, `pin`, `use`, `verify`, `gc`, `bundle`; exit 8; preview output |
| P2-T8 | Env wiring | explicit `PATH`/`ANSIBLE_CONFIG`/`TF_CLI_CONFIG_FILE`/`TF_DATA_DIR`/`KUBECONFIG` for engine children and the agent's bash; `oi doctor --env` prints it |

**Tests.** Tampered download / wrong signature / size mismatch → nothing installed; interrupt at each of the 8
install steps; concurrent installs serialise; user's `which ansible` unchanged; `--locked` refuses unknown
versions; air-gap bundle installs offline; network-filesystem workspace refused.

**Gate.** Fresh container → `oi workspace new demo --template lab` → `oi tools install` installs uv + ansible-core
+ tofu with verification visible, then `ansible --version`, `tofu version` and a `localhost` ping succeed; lock
diff printed and committed.

---

## 7. P3 — Model layer (2 weeks)

**Goal.** Four first-class providers plus a generic OpenAI-compatible one; user-supplied keys; capability probing;
cost and identity recorded. This is what makes the agent usable by people who do not have an Anthropic key — and by
people who *only* have one.

### 7.1 Provider matrix

| Provider id | API | Base URL | Auth | Model ids | Notes |
|---|---|---|---|---|---|
| `anthropic` | **Messages API** (native) | `https://api.anthropic.com` | `x-api-key` + `anthropic-version` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-*` (from `/v1/models`) | **Production path for Claude.** Prompt caching, thinking, tool use. Anthropic's OpenAI-compatible layer is documented as evaluation-only and ignores prompt caching → we do not use it for the agent loop |
| `openai` | Responses API primary, Chat Completions fallback | `https://api.openai.com/v1` | `Authorization: Bearer` | from `/v1/models` | Responses for tool-heavy loops; Chat Completions when a model lacks Responses support |
| `nvidia` (NVIDIA NIM) | OpenAI-compatible Chat Completions | `https://integrate.api.nvidia.com/v1` | `Authorization: Bearer nvapi-…` | `org/model`, e.g. `meta/llama-3.3-70b-instruct`, `nvidia/nemotron-*`, `qwen/*`, `deepseek-ai/*` | hosted catalogue; also supports self-hosted NIM → base URL configurable |
| `openrouter` | OpenAI-compatible | `https://openrouter.ai/api/v1` | `Authorization: Bearer` + attribution headers | `author/model` | provider routing, `models[]` fallbacks, cost in response usage |
| `compatible` | OpenAI-compatible | user base URL | user header/key | user | vLLM, Ollama, LM Studio, gateways, LiteLLM |

### 7.2 Configuration

```toml
# ~/.openinfra/providers.toml   (keys are references, never values)
[default]
provider = "anthropic"
model = "claude-sonnet-5-5"

[providers.anthropic]
kind = "anthropic"
api_key_ref = "keychain:openinfra/anthropic"
# base_url override for gateways: base_url = "https://gateway.internal/anthropic"

[providers.openai]
kind = "openai"
api_key_ref = "keychain:openinfra/openai"

[providers.nvidia]
kind = "openai-compatible"
base_url = "https://integrate.api.nvidia.com/v1"
api_key_ref = "keychain:openinfra/nvidia"
models = ["meta/llama-3.3-70b-instruct", "nvidia/nemotron-3-ultra-550b-a55b"]

[providers.openrouter]
kind = "openrouter"
api_key_ref = "keychain:openinfra/openrouter"
attribution = { referer = "https://openinfra.dev", title = "OpenInfra" }
# routing: pin or allow fallbacks. Fallbacks are recorded per response (see 7.4)
routing = { sort = "latency", allow_fallbacks = true }

[providers.local]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
api_key_ref = "none"
```

Rules:

- **Keys live in the OS keychain** (`keychain:` ref), or in an external secret manager. Environment variables are
  accepted only with `OPENINFRA_ALLOW_ENV_KEYS=1`, and are never inherited by the agent's bash.
- `oi providers add <kind>` prompts for the key (no echo), tests it with a 1-token call, probes capabilities, and
  writes only the reference.
- `oi providers test [--all]` reports latency, HTTP status, model count, whether tool calling works, and the
  approximate cost of a 1k-token round trip where the provider returns pricing.
- A key is redacted from every log, artifact, transcript and event (`nvapi-`, `sk-`, `sk-ant-`, `sk-or-v1-`,
  bearer patterns), with fixtures in the redaction suite.

### 7.3 Capability probe (stored per provider+model)

```json
{ "provider": "nvidia", "model": "meta/llama-3.3-70b-instruct",
  "streaming": true, "tools": true, "parallel_tool_calls": false, "json_mode": true,
  "context_tokens": 131072, "max_output_tokens": 4096, "prompt_cache": false,
  "probed_at": "2026-10-22T10:02:11Z", "probe": "P3-T4" }
```

The agent refuses to start a turn on a model without `tools` (text-only planning is offered instead), caps context
from the probe rather than a hard-coded number, and warns when `prompt_cache` is false on a long session (cost).

### 7.4 Model identity, fallbacks, and trust

- Every assistant turn records `requested_model` **and** `served_model` (from the response), plus provider and
  routing metadata. OpenRouter and NIM can serve a different model than requested; the evidence records what
  actually answered.
- **No mid-turn provider failover.** Message formats differ across providers; pi's own docs call cross-provider
  handoff lossy. On 429/5xx we retry with backoff, then fail the turn with a clear error. A *new* turn may use a
  different provider.
- **Fallbacks are forbidden for change-authoring turns** unless `change.allow_model_fallback = true`: an approval
  bound to a plan authored by an unknown model is a weaker claim.
- Cost: tokens and (where provided) `usage.cost` are recorded per turn, per run and in `oi cost`; budget caps per
  turn and per day with a hard stop (exit 1 with `budget_exceeded`).

### 7.5 Tasks

| ID | Task | Detail |
|---|---|---|
| P3-T1 | Provider abstraction | `LlmProvider` interface: `stream(req)`, `models()`, `probe(model)`; adapters for anthropic/openai/openrouter/compatible |
| P3-T2 | Anthropic adapter | Messages API: system prompt, tool_use/tool_result blocks, streaming events, thinking blocks passed through, cache-control breakpoints |
| P3-T3 | OpenAI adapter | Responses API mapping (tools, tool outputs), Chat Completions fallback, streaming deltas |
| P3-T4 | NIM + OpenRouter + generic | shared OpenAI-compatible core: base URL, headers, `org/model` ids, NIM `/v1/models`, OpenRouter routing object + attribution + cost |
| P3-T5 | Key store | `oi providers add/remove/list/test`, keychain lib per platform, `keychain:` refs, env-key opt-in, redaction |
| P3-T6 | Probe + registry | capability probe with a real tiny call; cache in SQLite; `oi models list` |
| P3-T7 | Budgets and cost | per-turn/per-day caps, `usage` normalisation (Anthropic/OpenAI/NIM/OpenRouter shapes), `oi cost` |
| P3-T8 | Cassettes | record/replay provider frames; `--fake-model` adapter for CI; no network, no key |
| P3-T9 | Failover policy | retry/backoff, turn-level failure, no mid-turn switch, fallback ban for change authoring |

**Tests.** One live call per provider behind an opt-in CI job (secrets in CI); full offline suite on cassettes;
probe rejects a model without tools; key never appears in logs/transcripts/artifacts (grep + fixture tests);
429 → backoff → visible failure; cost accounting matches recorded usage; provider switch mid-session preserves the
transcript (new turn, no format corruption).

**Gate.** A session runs on each of the four providers with the user's key; `oi providers test --all` prints a
clean table; offline CI green; redaction tests green; `oi cost` matches the provider dashboard within tolerance.

---

## 8. P4 — Bash-first tool surface (2 weeks)

**Goal.** Since we are a CLI harness, `bash` is the main tool. That is a capability decision *and* a security
decision; this phase makes both explicit.

### 8.1 Tool set

| Tool | Role | Notes |
|---|---|---|
| **`bash`** | **primary**: everything the CLI can do — `kubectl`, `tofu`, `ansible-lint`, `jq`, `curl` (policy-bound), `git`, Python one-liners | one process per call, controlled env, sandbox, tiered |
| `read` | files, images, line ranges | before `edit` |
| `edit` | exact-match replacements (unique match or refuse) | pi/Claude-Code semantics |
| `write` | create/overwrite | requires a prior `read` when the file exists |
| `grep` / `glob` | fast search | ripgrep-backed, permission-filtered |
| `infra_*` (typed) | deterministic wrappers: inventory query, device read, k8s read, cloud inventory, drift, change check/run, verify, knowledge | each **implemented over the same engine path bash would use** — no second code path |

Prompt guidance (short, pi-style, ~1,000 tokens total): use bash for exploration; read before edit; exact match;
never `cat` to show work; use `oi change` for writes instead of `tofu apply`/`ansible-playbook`; if a command is
long-running, use `background` and poll the job.

### 8.2 `bash` tool contract

```jsonc
{ "command": "tofu plan -refresh-only -detailed-exitcode -no-color",
  "cwd": ".",                      // must resolve inside the workspace
  "timeout_s": 120,                // default 30, max 600; longer work → engine job
  "background": false,             // true → returns job_id (engine job, not a detached shell)
  "pty": false,                    // interactive programs (rare; see plugins/terminal precedent)
  "shell": "bash" }                // or "sh"; never a login shell by default
```

Returns: `exit_code`, `duration_ms`, `stdout`/`stderr` (64 KiB inline each), `truncated` + `artifact` refs, `tier`,
`denied_reason?`, `job_id?`. Output is redacted and evidence-linked.

### 8.3 Command classification and policy

| Class | Examples | Explore | Plan | Execute | Incident |
|---|---|---|---|---|---|
| **read** | `ls`, `cat`, `grep`, `jq`, `kubectl get`, `tofu plan`, `ansible --version`, `git status/log/diff` | allow | allow | allow | allow |
| **workspace-write** | creating files, `git commit`, `oi change check` | deny | allow | allow | deny |
| **infra-write** | `tofu apply`, `ansible-playbook` (non-check), `kubectl apply`, `ssh <device>` with config mode | deny | deny | **only via the change engine** | deny |
| **dangerous** | `sudo`, `rm -rf /`, `mkfs`, `dd of=/dev/`, `curl … \| sh`, fork bombs, `git push --force` | deny | deny | deny | deny |
| **unknown** | anything else | ask | ask | allow with reason | deny |

Implementation: a classifier over the command string (shell-parse with a small AST, then verb tables per binary) —
**not** a model. Deny rules come from `plugins/hooks`-style `permissions.json` (Claude Code format) *and* this
classifier; the union applies, deny wins. A `deny` is returned to the model as a normal tool error with the rule
that matched, so it can adapt instead of retrying.

### 8.4 Tasks

| ID | Task | Detail |
|---|---|---|
| P4-T1 | Bash tool | spawn with controlled env, sandbox policy, cwd confinement, timeout, process-group kill, output caps + artifact offload |
| P4-T2 | Classifier | shell parse + verb tables + tier; ~120 fixtures (including obfuscations: `$(…)`, `;`, pipes, `env`, `xargs`, aliases, base64) |
| P4-T3 | Deny rules | OpenInfra rule set merged with user rules; deny-first ordering; explains why |
| P4-T4 | Background jobs | `background: true` → engine job with journal; `oi run show`/`oi jobs`; no orphan processes |
| P4-T5 | PTY mode | interactive programs via a real PTY, screen read as text (reuse `plugins/terminal` technique) |
| P4-T6 | File tools | read/edit/write/grep/glob with secret-path denies and size caps |
| P4-T7 | Redirect to the engine | prompt + tool errors teach `oi change` for writes; `ansible-playbook`/`tofu apply` denied in bash |
| P4-T8 | Red-team suite | 80 adversarial commands (exfiltration, secret reads, encoded payloads, prompt-injected banners) |

**Tests.** Every fixture classified as specified; denied command never spawns a process (assert with a probe file);
`timeout` kills the group; 100 MB output → artifact + stub; secret paths unreadable; a model trying `tofu apply`
gets a denial and the change-engine hint; explore mode cannot write even via `git commit`.

**Gate.** Red-team suite green; a scripted session where the agent solves a task using only bash + read/edit on a
fixture lab, with zero write-tier commands escaping the classifier.

---

## 9. P5 — Reads (3 weeks)

| ID | Task | Detail |
|---|---|---|
| P5-T1 | Inventory merge | NetBox 4.7 REST+GraphQL (version-shape adapters, `{value,label}`, `port_mappings`), YAML/TOML loader + schema, precedence (identity ← NetBox, intent ← repo, observed ← devices), conflicts as findings |
| P5-T2 | Target resolution | selectors (`role/site/platform/env`) → frozen list; hash of the list |
| P5-T3 | SSH/CLI adapter | netmiko 4.8.0, per-platform prompts, allowlisted read verbs, timeouts, no enable unless configured |
| P5-T4 | NETCONF/RESTCONF | ncclient get/get-config with subtree filters; RESTCONF GET; capability gates |
| P5-T5 | Normalisers | volatile-line stripping, block sorting, golden fixtures, `oi normalise --explain` |
| P5-T6 | Fan-out | bounded pool (50), partial failure as `unreadable`, evidence per fact, worker pool for parsing |
| P5-T7 | k8s read-only | `kubectl auth can-i --list` gate, client allowlist, secrets never read, drift sources |
| P5-T8 | Cloud read-only | AWS assume-role (external id/OIDC) + policy introspection, Azure Reader, GCP viewer+securityReviewer |
| P5-T9 | Evidence | `source · query · ts · raw` on every read; `oi evidence show`, `--json` |

**Tests.** 200-device fixture lab; unreadable categorisation; normaliser golden files per platform; k8s gate
refuses a write-capable role and reports the offending rule; cloud policy shows "write actions: 0"; parser coverage
≥ 95%; evidence is complete for every cell in a generated answer.

**Gate.** `oi doctor` and `oi inv show --json` on the lab in < 15 s warm; k8s and cloud connectors verified
read-only; evidence audit passes.

---

## 10. P6 — Drift and the scheduler (3 weeks)

### 10.1 Drift

Per [OPENINFRA_PLAN.md](OPENINFRA_PLAN.md) §8: snapshot → normalise → compare → classify → fingerprint → transition
→ notify; severity from policy, coverage matrix, `unreadable` as findings, exit codes 2/3/5.

| ID | Task | Detail |
|---|---|---|
| P6-T1 | Snapshot store | per-source snapshots with hashes, diff base, rollback source; retention |
| P6-T2 | Comparators | text config, structured YANG/JSON, tofu/terraform plan JSON, k8s object graph, cloud id sets |
| P6-T3 | Fingerprint + transitions | `new/changed/resolved`, occurrences, rename tolerance, mute with reason |
| P6-T4 | Severity policy | `rules/drift-policy.yaml`, tier-1 routing/ACL/BGP → high |
| P6-T5 | Coverage matrix | per adapter, shown in UI and `oi drift coverage` |
| P6-T6 | Notifications | in-app, digest webhook/Slack/Teams/email, one message per transition |

### 10.2 Scheduler (cron)

**Primitive:** `oi schedule tick` — stateless, safe to run every minute from *any* scheduler; locks prevent
overlap. Our daemon is optional (laptops); production uses system cron/systemd/launchd/Kubernetes.

```toml
# <workspace>/.openinfra/schedule.toml
[defaults]
timezone = "Africa/Algiers"
notify = ["slack:netops"]
overlap = "skip"            # skip | queue | replace
missed = "skip"             # skip | once
timeout = "30m"

[[job]]
name = "drift-devices"
kind = "drift"              # drift | bash | python | ansible | tofu
cron = "17,47 * * * *"      # off the hour on purpose
sources = ["devices"]
fail_on = "high"

[[job]]
name = "tofu-nightly-plan"
kind = "tofu"
cron = "23 2 * * *"
command = "plan -refresh-only -detailed-exitcode -lock=false"
dir = "terraform/envs/prod"
fail_on = "any"

[[job]]
name = "ansible-compliance"
kind = "ansible"
cron = "41 3 * * 1-5"
playbook = "ansible/compliance.yml"
mode = "check"              # check only; apply requires a standing approval
limit = "site:bldg-c"
timeout = "45m"

[[job]]
name = "bash-backup-configs"
kind = "bash"
cron = "5 1 * * *"
command = "./scripts/backup-configs.sh"

[[job]]
name = "python-report"
kind = "python"
cron = "0 6 * * 1"
script = "scripts/weekly_report.py"
args = ["--days", "7"]
```

Rules that are not negotiable:

1. **Scheduled writes need a standing approval**: `mode = "apply"` (Ansible) or `kind = "tofu"` with `apply`
   requires `approval = "standing:<change-id>"`, created by a human with
   `oi change approve <id> --standing --expires 30d --max-targets N --sign`. At every run the plan is **re-planned,
   re-hashed and compared**: a changed hash stops the run (exit 7) and notifies. No standing approval, no run.
2. **No auto-remediation from drift findings** in v1. A finding can open a change; only the change runs.
3. **Overlap is always decided**, never defaulted silently: `skip` (default, `flock`-equivalent), `queue`
   (bounded), `replace` (kills the previous run — only for checks).
4. **Missed runs**: `skip` by default; `once` catch-up runs a single make-up execution, never a thundering herd.
5. **Bounded runtime** per job; exceeding it kills the process group and records `timeout`.
6. **Retries** 0–3 with exponential backoff and jitter, only for classified transient failures (network, 5xx,
   provider 429); never for a failed policy gate.
7. **Every run is a run record**, same journal as changes: exit code, duration, per-target state, artifacts,
   notifications sent.
8. **Jitter** for `0 * * * *`-style schedules (±90 s) to avoid stampedes and provider rate limits.

Export and CI:

```
oi schedule list|show|enable|disable|run <name>|history <name>|status
oi schedule tick                 # stateless; safe every minute
oi schedule daemon               # optional, laptops
oi schedule export --format systemd|cron|launchd|k8s [--out -]
```

`--format systemd` writes a `.service` + `.timer` pair calling `oi schedule tick`; `k8s` writes a CronJob with
`concurrencyPolicy: Forbid` and an `activeDeadlineSeconds`; `cron` writes a crontab line with `flock`. All of them
call the same tick, so behaviour cannot diverge.

| ID | Task | Detail |
|---|---|---|
| P6-T7 | Cron parser | 5-field + `@daily` aliases, IANA timezones, DST handling (skip/duplicate hour documented), never-fire detection |
| P6-T8 | Scheduler core | due calculation, tick idempotency, locks (lease files with owner token + TTL), overlap/missed policies, retries, timeouts |
| P6-T9 | Job kinds | drift, bash, python, ansible (check/apply), tofu (plan/apply) with the gating above |
| P6-T10 | Exporters | systemd, cron, launchd, k8s manifests |
| P6-T11 | History/status | `oi schedule history`, heartbeat, `oi schedule status --json` for monitoring, exit code for a failed last run |
| P6-T12 | Notifications | digest + failure alerts, per-job routing, quiet hours |

**Tests.** Cron parsing table (including leap/DST cases); tick called twice in a second runs once; overlap `skip`
drops with exit 0 and a reason; `queue` bounds; `replace` kills; missed-run `once`; standing approval invalidated by
a changed plan hash (exit 7, nothing applied); `tofu apply` job without approval refuses; timezone conversion;
exported systemd unit runs the same command and produces the same run record; scheduler tests run with a fake clock
(no `sleep` in CI).

**Gate.** A workspace with five scheduled jobs runs for a simulated week on a fake clock: drift history shows
transitions only, one failing job alerts once, no overlap, zero model tokens, and `oi schedule status` is honest
about every run.

---

## 11. P7 — Change engine, approvals, waves (3 weeks)

| ID | Task | Detail |
|---|---|---|
| P7-T1 | Change object | `.openinfra/changes/<id>/change.yaml`, branch `openinfra/<id>-<slug>` (worktree optional) |
| P7-T2 | Render + checks | templates, `ansible-lint`, `yamllint`, batfish parse, `pyang`, `kubeconform`, `tflint` |
| P7-T3 | Policy | conftest/OPA on rendered configs and `tofu show -json`; OpenInfra scope/blast-radius rules |
| P7-T4 | Plan + hash | `ansible --check --diff`, `tofu plan -out`, k8s diff; hash over intent+targets+rendered+tool versions+lock+policy |
| P7-T5 | Approval | TTY + typed 8-char hash + `ssh-keygen -Y sign`; `allowed_signers`; verification in CI; exit 4/7 |
| P7-T6 | Standing approvals | for schedules: expiry, max targets, re-hash check, revoke |
| P7-T7 | Waves + verify | canary → small → rest, thresholds, independent verification, stop on breach |
| P7-T8 | Rollback | config-replace from snapshot; intent revert for IaC; recorded and itself approvable |
| P7-T9 | PR integration | `gh`/`glab` PR with checks, artefacts and the approval record attached |

**Tests.** Hash stability across runs; any tool/lock change changes the hash; forged/mismatched/expired approval
fails; wave threshold stops and rolls back; `SIGKILL` mid-wave reconciles; a broken change is caught before wave 1;
rollback restores byte-identical configs on the fixture lab.

**Gate.** Five real changes on the lab, reviewed by someone who did not write them, each with a signed approval and
a passing verification; one deliberately broken change blocked; one mid-wave failure rolled back cleanly.

---

## 12. P8 — TUI (3 weeks)

Per [TUI.md](TUI.md) §11, on the renderer decided in P0.

| ID | Task | Detail |
|---|---|---|
| P8-T1 | Shell | router, reducer, keymap, sanitize, theme, status line, PTY harness |
| P8-T2 | Drift screen | list/filter/detail/evidence, mute, recheck, `x` explain |
| P8-T3 | Chat | mode pill, `@` targets, evidence (`ctrl-o`), `/` commands, approvals box |
| P8-T4 | Change screen | checks, diff delegation, waves, approve (typed hash), run |
| P8-T5 | Run screen | live per-target matrix, logs, stop, rollback |
| P8-T6 | Setup + Tools | workspace/toolchain/sources; install preview and progress; provider setup (`oi providers` in TUI) |
| P8-T7 | Schedules screen | job list, next/last run, history, run now, enable/disable |
| P8-T8 | Degraded modes | `--plain`, dumb terminals, < 60 columns, resize |

**Tests.** PTY golden frames per screen; keystroke latency budget; sanitize fixtures; approval cannot be answered by
queued input; `--plain` parity; every TUI action has a CLI twin (a test enumerates actions and asserts the CLI verb
exists).

**Gate.** Triage 20 findings, open a change, approve it and watch the run entirely in the TUI; PTY tests in CI;
`TERM=dumb` behaves.

---

## 13. P9 — Packaging, hardening, docs, beta (2 weeks)

| ID | Task | Detail |
|---|---|---|
| P9-T1 | Binary | Node SEA bundle, notarised macOS, Linux x64/arm64, `oi --build-info` (pinned fork commit, EE digests, recipe hashes) |
| P9-T2 | Channels | Homebrew tap, npm package, Docker image, air-gap bundle |
| P9-T3 | Soak + chaos | 8-hour soak (drift every 30 min, schedules firing), kill at every phase, fd/memory leak checks |
| P9-T4 | Security review | §13 checklist signed row by row, red-team rerun, secret-exfil test |
| P9-T5 | Docs | README quickstart, `COMMANDS.md`, `APPROVALS.md`, `SCHEDULING.md`, `PROVIDERS.md`, `WORKSPACES.md`, `TOOLCHAIN.md`, troubleshooting, three asciinema demos |
| P9-T6 | Beta programme | 10 users, two real labs, one real cloud account; instrument local metrics only (opt-in) |
| P9-T7 | Release | versioning, changelog, checksums, SBOM, recipe canary, knowledge pack refresh |

**Gate.** `brew install` on a clean container → first drift in < 10 minutes; soak and chaos green; security checklist
signed; docs cover every command in `--help`; beta feedback triaged.

---

## 14. P10 — Team mode (post-v1, 8+ weeks)

Standalone runner service (engine without TUI), Postgres, SSO/OIDC, approval queues, audit export (SIEM), policy
bundles per team, shared schedules, air-gapped distribution, Slack app. The engine is written as a library from P1
precisely so this is packaging, not a rewrite.

---

## 15. Test strategy (the whole matrix)

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit | pure logic: cron, classifier, normalisers, hashing, reducer, sanitize, cost, redaction | `*/test/*.test.mjs` (`node --test`) | every push |
| Contract | protocol schemas, view models, provider request/response shapes | `packages/openinfra-protocol/test` | every push |
| Adapters | fake devices, fake k8s API, fake cloud, fake NetBox (recorded fixtures) | `packages/openinfra-testing` | every push |
| Provider | cassettes (recorded frames) for all four providers; `--fake-model` | `apps/openinfra-cli/test/providers` | every push |
| Engine | jobs, journals, crash/resume, drift transitions, scheduler with a fake clock | `packages/openinfra-engine/test` | every push |
| Change | gates, hash, waves, rollback, standing approvals | `plugins/openinfra-change/test` | every push |
| TUI | reducer/keys/sanitize unit; PTY golden frames with `@xterm/headless` | `apps/openinfra-tui/test` | every push |
| Live provider | one tiny call per provider (secrets-gated, nightly) | CI job | nightly |
| Lab | containerlab/kind/MinIO/NetBox compose: real devices, real cluster | `fixtures/lab` | nightly |
| Chaos | kill -9 at each phase boundary, disk full, network drop mid-wave | `test/chaos` | nightly |
| Soak | 8 h scheduler + drift + 50 agent turns | `test/soak` | weekly |
| Security | red-team commands, secret exfil, escape sequences, approval forgery | `test/security` | every push (fast subset), nightly (full) |
| Performance | budgets table from [TUI.md](TUI.md) §14 | `test/bench` | nightly, blocks release |

### 15.1 The invariant suite (never deleted, never skipped)

1. Protected facts survive forced compaction.
2. A write tool without an approval token is refused before any adapter call.
3. `oi change run` with a mismatched hash exits 7 and writes nothing.
4. Piped stdin can never approve (exit 4).
5. Control characters from device output never reach the terminal as escapes.
6. `grep -R "auto-approve"` in apps/packages/plugins returns nothing.
7. `SIGKILL` mid-wave leaves truthful per-target state in `oi run show`.
8. `oi doctor` completes with no provider key and no network beyond fixtures.
9. Provider keys never appear in a transcript, artifact, event or log.
10. A scheduled write without a valid standing approval does not start.

---

## 16. Risks and mitigations (programme level)

| Risk | Phase | Mitigation |
|---|---|---|
| Provider churn (model ids, endpoints) | P3 | capability probe + `/v1/models` discovery; cassettes; ids in config, never hard-coded in code paths |
| Anthropic OpenAI-compat layer tempting us | P3 | documented decision: native Messages API for the agent loop (no prompt caching otherwise) |
| Model quality varies wildly across the four | P3/P8 | per-mode default model recommendations; "cheap model for explore, strong for change authoring"; record served model |
| Bash tool becomes an escape hatch | P4 | classifier + deny rules + tiers; `infra-write` only via change engine; red-team suite |
| Prompt injection from device banners / web pages | P4/P5 | data-not-instructions rule, sanitisation, write tier needs approval, tool error teaching |
| Scheduled applies cause an outage | P6 | standing approvals with re-hash, waves, canary, verification, kill switch, no auto-remediation |
| Overlap/stampede at :00 | P6 | jitter, locks, `skip` default, exports use the same tick |
| Cron on laptops is unreliable | P6 | `oi schedule tick` + exporters; document that production schedules belong on a server |
| Toolchain recipe rot | P2 | nightly canary; pinned digests; failing canary blocks release |
| TUI scope creep | P8 | written "will not do" list; decision record to add a surface |
| Two engineers, 25 weeks slips | all | gates are cuttable: P10, then Tools screen, then k8s/cloud adapters; never cut invariants |

---

## 17. Parallelisation and staffing

| Track | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 |
|---|---|---|---|---|---|---|---|---|---|---|
| Engine (E1) | skeleton | store/jobs/doctor | recipes/toolchain | provider core | bash/classifier | adapters | drift+scheduler | change | — | soak/chaos |
| Product (E2) | spike/TUI | CLI output/exit codes | workspace UX | provider UX/cost | tools polish | inventory UX | schedules UX | approvals UX/PR | TUI | docs/beta |

Hand-offs that matter: E1 owns the protocol and invariants; E2 owns every user-visible string and the exit-code
contract. Both review security tests.

---

## 18. Definition of done for v1.0

- [ ] `brew install openinfra` on a clean macOS and a clean Linux container, then `oi init`, `oi workspace new`,
      `oi doctor`, `oi tui` — no key required for any of it.
- [ ] Four providers work with real keys; a session can switch models between turns; cost is visible.
- [ ] `bash` is the primary tool and the classifier's red-team suite is green.
- [ ] Drift: transitions only, < 1% false positives on the lab over a week, exit codes 2/3/5 honoured in CI.
- [ ] Schedules: five job kinds, overlap/missed/expiry handled, exports verified, zero idle tokens.
- [ ] Change: signed approvals, waves, verification, rollback, PRs; audit chain reconstructable.
- [ ] TUI: five surfaces, PTY tests, degraded modes, every action has a CLI twin.
- [ ] Invariant suite 1–10 green; performance budgets green; soak and chaos green.
- [ ] Docs complete and honest about limits; knowledge pack pinned and dated.

---

## 19. Appendix — provider quick reference

```bash
# Anthropic (Messages API)
oi providers add anthropic              # keychain prompt, then: oi providers test anthropic
# OpenAI
oi providers add openai
# NVIDIA NIM (OpenAI-compatible hosted catalogue)
oi providers add nvidia --base-url https://integrate.api.nvidia.com/v1 --key nvapi-…
oi models list --provider nvidia        # org/model slugs from /v1/models
# OpenRouter (author/model, routing, fallbacks)
oi providers add openrouter --routing '{"sort":"latency","allow_fallbacks":true}'
# anything OpenAI-compatible (vLLM, Ollama, LiteLLM, gateways)
oi providers add compatible --base-url http://127.0.0.1:11434/v1 --key none
oi providers test --all
oi models probe nvidia/meta/llama-3.3-70b-instruct
```

```toml
# .openinfra/config.toml — per-mode model choice
[agent.explore]
provider = "nvidia"; model = "meta/llama-3.3-70b-instruct"
[agent.plan]
provider = "openrouter"; model = "anthropic/claude-sonnet-5-5"
[agent.change]
provider = "anthropic"; model = "claude-sonnet-5-5"; allow_model_fallback = false
[agent.incident]
provider = "openai"; model = "gpt-5.2"; reasoning = "medium"
```

```bash
# schedules
oi schedule list
oi schedule run drift-devices          # run now, same locks as the timer
oi schedule history tofu-nightly-plan --limit 20
oi schedule export --format systemd --out -
oi schedule status --json              # for monitoring; non-zero when a job is failing
```

---

## 20. Implementation status

The first build lives in [`openinfra/`](../openinfra/README.md): zero runtime dependencies, Node ≥ 22.5, 154
tests, no network and no keys required. What is real today:

| Phase | State | Evidence |
|---|---|---|
| P0 | **done** | monorepo, protocol/exit codes, invariant harness, `node --test` on a clean container |
| P1 | **done** | store, artifacts, journal, job runner with process-group kill and crash reconcile, `oi doctor` |
| P2 | **partial** | workspaces (id, registry, templates, git, network-FS refusal) and lockfile verification; the verified *installer* is not written yet |
| P3 | **done, one transport fewer** | Anthropic native + OpenAI-compatible (OpenAI, NIM, OpenRouter, gateways) + fake; probes, cost, retries, redaction. OpenAI runs on Chat Completions rather than the Responses API — one wire format for five providers beats four near-identical adapters |
| P4 | **done** | bash tool with scrubbed env, confined cwd, group-kill timeouts, artifact offload; classifier with 5 tiers and the mode matrix; permissions merged deny-first; read-only tools parallel, writes serial |
| P5 | **not started** | no device/k8s/cloud/NetBox adapters yet; drift consumes an `observed` tree so the engine is already tested without them |
| P6 | **drift + scheduler done** | intent/observed comparison with fingerprints, severity, transitions and coverage; cron with IANA timezones and DST, leases, overlap/missed, standing approvals re-checked against the plan hash, four exporters |
| P7 | **not started** | `infra-write` stays refused in every mode until the change engine exists |
| P8 | **not started** | `oi tui` exits 6 and says which phase it is |
| P9 | **partial** | `npm run demo`, README, exit-code contract; packaging, soak, security review outstanding |

Two invariants gained a companion during the build: **11. a second tick cannot start a job another tick is
running**, and **5** is enforced by stripping escape sequences from every captured stream, not by asking
nicely. Both are in `openinfra/test/invariants.test.mjs`.

_Review cadence: at each gate, this document is updated with what changed and why. Decisions that alter §7 (model
layer), §8 (bash/tool surface) or §10 (scheduler safety) are recorded here before code._
