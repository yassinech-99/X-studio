# OpenInfra (`oi`)

A CLI-first infrastructure harness: one binary that reads what your network, cloud, Kubernetes and IaC
actually say, compares it to what you declared, runs Ansible/Terraform/Python/Bash on a schedule, and gives an
agent a **bash tool with a policy gate** — on whichever model you already pay for.

This is the implementation of [`docs/phased.md`](../docs/phased.md). The plan documents what the whole product
is; this directory is the part that exists and runs.

```
node bin/oi.js --version     # 0.1.0
node bin/oi.js --help
npm test                     # 154 tests, no network, no keys
```

Node ≥ 22.5 (uses `node:sqlite`). **No runtime dependencies** — nothing to install, nothing to audit, and it runs
on a jump host with no internet.

---

## Five minutes, offline

```bash
cd openinfra
node bin/oi.js workspace new demo --template lab --dir ~/demo
cd ~/demo

node /path/to/openinfra/bin/oi.js providers add fake     # a deterministic model, no key, no network
node /path/to/openinfra/bin/oi.js doctor                 # what this machine can do
node /path/to/openinfra/bin/oi.js drift check            # intent/ vs .openinfra/drift/observed.json
node /path/to/openinfra/bin/oi.js chat -p "RUN: kubectl get pods -A" --mode execute
node /path/to/openinfra/bin/oi.js schedule list
node /path/to/openinfra/bin/oi.js schedule tick          # what cron/systemd would run
```

With a real key (the four providers from the plan, plus anything OpenAI-compatible):

```bash
node bin/oi.js providers add anthropic --key sk-ant-…      # native Messages API
node bin/oi.js providers add openai    --key sk-…          # Chat Completions
node bin/oi.js providers add nvidia    --key nvapi-…       # NVIDIA NIM hosted catalogue
node bin/oi.js providers add openrouter --key sk-or-v1-…   # routing, fallbacks, cost in usage
node bin/oi.js providers add compatible --base-url http://127.0.0.1:11434/v1   # vLLM, Ollama, LiteLLM, gateways
node bin/oi.js providers test --all
node bin/oi.js models list --provider nvidia               # ids come from /v1/models, never hard-coded
```

Keys go to the OS keychain when available, otherwise `~/.openinfra/secrets.json` (mode 0600), or to an
`OPENINFRA_KEY_*` environment variable if you prefer. They are never written to config, a transcript, an event,
an artifact or a log — and there are tests that fail if they are.

---

## What is implemented, honestly

| Area | State | Where |
|---|---|---|
| TOML config (strict, unknown keys are errors), references not values | **done** | `src/config.js`, `src/toml.js` |
| Workspaces: id, registry, templates, git init, discovery, network-FS refusal | **done** | `src/workspace.js` |
| Store: SQLite WAL, runs, events, findings, transitions, schedule state, cost ledger | **done** | `src/store.js` |
| Artifacts: content-addressed, compressed, deduplicated, redacted | **done** | `src/artifacts.js` |
| Jobs: own process group, timeout kills the group, output caps + artifact offload, journal fsync | **done** | `src/jobs.js`, `src/journal.js` |
| Provider layer: Anthropic native, OpenAI/OpenRouter/NIM/compatible, fake; probes; cost; retries | **done** | `src/providers/` |
| Bash-first tools: `bash` + read/write/edit/grep/glob; parallel reads, serial writes | **done** | `src/tools.js`, `src/agent.js` |
| Command classifier + permission rules (deny > ask > allow, deny wins) | **done** | `src/classify.js`, `src/permissions.js` |
| Drift: intent vs observed trees, fingerprints, severity, transitions, coverage/unreadable | **done** | `src/drift.js` |
| Scheduler: cron + IANA timezones + DST, leases, overlap/missed, standing approvals, 4 exporters | **done** | `src/cron.js`, `src/scheduler.js` |
| `oi doctor`, exit codes 0–9, JSON everywhere | **done** | `src/doctor.js`, `src/exit.js` |
| **Adapters** (SSH/NETCONF/RESTCONF, Kubernetes, AWS/Azure/GCP, NetBox) | **not yet** (P5) | — |
| **Change engine** (render → check → plan → hash → signed approval → waves → rollback) | **not yet** (P7) | — |
| **TUI** | **not yet** (P8) — `oi tui` says so and exits 6 | — |
| **Toolchain installer** (verified downloads, lockfile writer) | **partial**: lockfile read + verify; install is P2 | `src/toolchain.js` |

Drift is adapter-free by design: an adapter's only job is to produce the `observed` tree, so the comparator,
fingerprints, severity and transitions are already tested without a lab. Today you produce it from a file:

```bash
node bin/oi.js drift check --observed .openinfra/drift/observed.json --json
```

---

## The three decisions this code makes

### 1. bash is the primary tool, and it has a gate

The agent's first tool is `bash`. It runs real commands with the workspace's pinned toolchain first on `PATH`,
a scrubbed environment (no provider keys, no cloud creds), a confined `cwd`, and a timeout that kills the whole
process group.

Every command is classified **before it spawns** by a shell parser and verb tables — never by a model — into
`read`, `workspace-write`, `infra-write`, `dangerous` or `unknown`, and then decided per mode:

| | read | workspace-write | unknown | infra-write | dangerous |
|---|---|---|---|---|---|
| explore | allow | deny | ask | deny | deny |
| plan | allow | allow | ask | deny | deny |
| execute | allow | allow | allow | deny | deny |
| incident | allow | deny | ask | allow | deny |

`infra-write` is **never** available through bash, in any mode: `tofu apply`, `ansible-playbook` without
`--check`, `kubectl apply`, `git push`. Those belong to the change engine (P7), and the refusal tells the model
so. A denial comes back as a normal tool error, so the agent adapts instead of retrying.

Try it: `node bin/oi.js classify -c 'kubectl delete pod x'`.

### 2. Scheduling is file-declared, locked, and boring

`oi schedule tick` is stateless and idempotent. Run it every minute from systemd, cron, launchd or a Kubernetes
CronJob (`oi schedule export --format systemd|k8s|…`) — they all call the same code, so behaviour cannot diverge.

- **overlap**: `skip` (default), `queue`, `replace` — decided by a lease file with an owner token and TTL, so a
  crashed run is taken over and a live one is respected
- **missed**: `skip` (default) or `once` — no thundering herd after a laptop wakes up
- **timezones**: IANA, with DST gaps skipped rather than silently shifted, and never-fires detected at parse time
- **writes**: a scheduled `ansible … mode="apply"` or `tofu apply` needs `approval = "standing:<id>"`; the plan
  hash is re-checked at every run and a changed hash stops it with exit 7
- every run is a journal (`oi run show <id>`) — `run.started`, `job.exec`, `job.output`, `run.finished`

Five job kinds: `drift`, `bash`, `python`, `ansible`, `tofu`.

### 3. Drift reports what it did not look at

Comparing trees is easy. Being honest about coverage is not. An object declared in `intent/` that no source
reported is a **`unreadable` finding**, never a silent match, and `oi drift check` prints the coverage ratio.
Findings carry a stable fingerprint, so "same drift twice" is one finding with `occurrences: 2`, and drift going
away is exactly one `resolved` transition — which is what notifications should fire on.

---

## Layout

```
bin/oi.js            entry point
src/cli.js           the verbs (every one has a JSON form and a real exit code)
src/agent.js         the loop: bash first, parallel reads, deterministic compaction
src/tools.js         bash, read, write, edit, grep, glob — all behind the same gate
src/classify.js      shell splitter + verb tables + the mode matrix
src/permissions.js   permissions.json (Claude Code shape), deny > ask > allow
src/providers/       anthropic (native), openai-compatible (OpenAI/NIM/OpenRouter/anything), fake
src/scheduler.js     tick, leases, approvals, exporters
src/cron.js          five fields, IANA timezones, DST
src/drift.js         compare, fingerprint, classify, transition
src/jobs.js          the only place that spawns a process
src/store.js         SQLite; src/artifacts.js content-addressed blobs
test/                unit, contract, adapter, chaos-ish and the 11 invariants
```

## Test suite

```bash
npm test          # 154 tests: cron/DST tables, classifier adversarial cases, both provider wire formats
                  # against a local mock server, agent loop, scheduler with a fake clock, drift transitions,
                  # approval gates, redaction, terminal sanitisation, CLI exit codes, invariants
npm run lint      # every file parses; no unowned markers; invariants present
```

No test touches the network, and none needs a key. The invariant suite (`test/invariants.test.mjs`) is the ten
rules from `docs/phased.md` §15.1 plus one: a second tick cannot start a job another tick is running.

## Deviations from the plan, and why

1. **OpenAI uses Chat Completions, not the Responses API.** One wire format for OpenAI, NIM, OpenRouter, vLLM,
   Ollama and every gateway is one place for tool-call bugs instead of four. Anthropic still uses its native
   Messages API, because its OpenAI-compatible layer is documented as evaluation-only and drops prompt caching.
2. **Drift compares trees, not devices.** Adapters are P5. Doing the comparator first is what let it be tested
   without a lab, and it means adding an adapter later cannot change the drift semantics.
3. **Scheduling ships before the change engine.** Cron is useful on day one (`drift`, `bash`, `python`,
   `ansible --check`, `tofu plan`); writes stay refused until P7 rather than shipping a half-approval.
