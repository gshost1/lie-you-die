#!/usr/bin/env bash
# Provision a Freestyle Ubuntu 24.04 builder VM, which is then snapshotted.
# Runs as root, on the builder only (which has public egress). Run VMs boot
# from the snapshot with NO general internet access. UNTESTED (Day 1).
#
# Installs: bpftrace (exec tracer), bun + node (base image ships both; checked),
# and the four agents under test. Agent install commands are UNVERIFIED and
# mirror config/agents.json.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends bpftrace ca-certificates curl git jq tar procps

# bun + node: Freestyle's Ubuntu base snapshot ships them under /usr/local/bin.
command -v bun >/dev/null || { echo "bun missing from base image" >&2; exit 1; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Unprivileged agent user. No sudo; cannot read /opt/lyd.
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
install -d -m 0700 -o root -g root /opt/lyd /opt/lyd/out


# Agents under test: LATEST by default, resolved to exact versions here and
# recorded in /opt/lyd/manifest.json, which the orchestrator saves next to the
# snapshot id (config/snapshot-manifest.json). To rebuild an identical image,
# pass the recorded versions back in: PI_VERSION=1.2.3 OMP_VERSION=... etc.
# npm names checked against the registry 2026-10-14 (pi 1.2.0, omp 18.10.4,
# opencode 1.19.0 were latest then). @mariozechner/pi-coding-agent is deprecated
# in favour of @earendil-works/pi-coding-agent. A wrong name fails loudly.
declare -A PKG=( [pi]=@earendil-works/pi-coding-agent [omp]=@oh-my-pi/pi-coding-agent [opencode]=opencode-ai )
declare -A WANT=( [pi]="${PI_VERSION:-latest}" [omp]="${OMP_VERSION:-latest}" [opencode]="${OPENCODE_VERSION:-latest}" )
# npm now blocks dependency install scripts unless allowed by name. These are
# the ones each agent needs (from the first build's warnings): native addons and
# opencode's binary link. Without them the agents install but do not run.
declare -A ALLOW=( [pi]=@google/genai,protobufjs,koffi [omp]=onnxruntime-node,protobufjs [opencode]=opencode-ai )
declare -A GOT
NPM_BIN="$(npm prefix -g)/bin"
echo "npm global bin: $NPM_BIN"
for a in pi omp opencode; do
  v="$(npm view "${PKG[$a]}@${WANT[$a]}" version | tail -1)"   # resolve "latest" to an exact version
  [ -n "$v" ] || { echo "cannot resolve ${PKG[$a]}@${WANT[$a]}" >&2; exit 1; }
  npm install -g --allow-scripts="${ALLOW[$a]}" "${PKG[$a]}@$v"
  GOT[$a]="$v"
done

# The global npm bin dir is not on PATH in this image; link the agents in.
for bin in pi omp opencode; do ln -sf "$NPM_BIN/$bin" "/usr/local/bin/$bin"; done

# droid installs per-user via Factory's script, which always fetches the latest
# build. Its version is read back from the binary. Pinning a droid version on
# rebuild depends on the installer supporting it (UNVERIFIED): the snapshot
# itself is the reproducible artifact.
su - agent -c 'curl -fsSL https://app.factory.ai/cli | sh'
ln -sf /home/agent/.local/bin/droid /usr/local/bin/droid
GOT[droid]="$(droid --version 2>/dev/null | head -1 | tr -d '\r')"
[ -n "${GOT[droid]}" ] || { echo "droid --version failed" >&2; exit 1; }

# Fail if any agent binary is missing; then write the manifest.
for bin in pi omp opencode droid bpftrace; do
  command -v "$bin" >/dev/null || { echo "MISSING: $bin" >&2; exit 1; }
  # Each agent must actually start, not just exist (catches skipped install scripts).
  [ "$bin" = bpftrace ] || "$bin" --version >/dev/null 2>&1 || { echo "BROKEN: $bin --version failed" >&2; "$bin" --version || true; exit 1; }
done
jq -n \
  --arg built "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg os "$(. /etc/os-release && echo "$PRETTY_NAME")" \
  --arg kernel "$(uname -r)" \
  --arg bun "$(bun --version)" --arg node "$(node --version)" --arg bpftrace "$(bpftrace --version | head -1)" \
  --arg pi "${GOT[pi]}" --arg pi_pkg "${PKG[pi]}" \
  --arg omp "${GOT[omp]}" --arg omp_pkg "${PKG[omp]}" \
  --arg opencode "${GOT[opencode]}" --arg opencode_pkg "${PKG[opencode]}" \
  --arg droid "${GOT[droid]}" \
  '{built: $built, os: $os, kernel: $kernel,
    runtimes: {bun: $bun, node: $node, bpftrace: $bpftrace},
    agents: {pi: {package: $pi_pkg, version: $pi}, omp: {package: $omp_pkg, version: $omp},
             opencode: {package: $opencode_pkg, version: $opencode},
             droid: {installer: "https://app.factory.ai/cli", version: $droid}}}' \
  > /opt/lyd/manifest.json
cat /opt/lyd/manifest.json

# Leave no build caches the agent could mine for hints.
rm -rf /root/.npm /root/.cache /tmp/*
echo PROVISION_OK
