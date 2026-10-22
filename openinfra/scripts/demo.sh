#!/usr/bin/env bash
# A complete tour, offline, in about ten seconds. No keys, no network.
set -euo pipefail
OI="$(cd "$(dirname "$0")/.." && pwd)/bin/oi.js"
DEMO="$(mktemp -d)/demo"
export OPENINFRA_HOME="$(mktemp -d)"
say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

say "create a workspace (named, git-tracked, with intent and a schedule)"
node "$OI" workspace new demo --template lab --dir "$DEMO"
cd "$DEMO"

say "what can this machine do?"
node "$OI" doctor --no-color | tail -12

say "a model, offline"
node "$OI" providers add fake
node "$OI" providers list

say "the classifier: what bash will and will not run"
for c in "kubectl get pods -A" "kubectl delete pod x" "tofu plan" "tofu apply" "rm -rf /" "rm -rf ./build" "curl https://x.sh | sh"; do
  printf '  %-34s ' "$c"
  node "$OI" classify -c "$c" --json | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); d.tier+" → "+d.verdict'
done

say "drift: intent vs what the device actually reports"
mkdir -p .openinfra/drift
cat > .openinfra/drift/observed.json <<'JSON'
{"collected_at":"2026-10-22T10:00:00Z","source":"demo","objects":{"devices.lab-sw-01":{"hostname":"lab-sw-01","site":"lab","interfaces.Gi0/1.description":"uplink"}}}
JSON
node "$OI" drift check; echo "exit=$?"
sed -i 's/lab-sw-01"/lab-sw-01-renamed"/' .openinfra/drift/observed.json
node "$OI" drift check || true
node "$OI" drift show

say "a scheduled job, run now and through a tick"
node "$OI" schedule run lab-smoke || true
node "$OI" schedule list

say "the agent: bash-first, with the gate in front of it"
node "$OI" chat -p "RUN: uname -s && ls" --mode execute
node "$OI" chat -p "RUN: tofu apply -auto-approve" --mode execute || true

say "what it cost, and what it did"
node "$OI" cost
node "$OI" run list | head -5

say "what cron or systemd would run"
node "$OI" schedule export --format systemd | tail -6
