<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Brake Health Cloud

Brake backend with durable ingestion, receipts, history and service-scoped reset.
<a id="sdv-lab-entry"></a>

For the **complete vehicle demo**, use the
[SDV Lab README](https://github.com/alexmaninblack/aosedge-sdv-demo); its build prepares this component automatically.
The standalone path below serves only this backend on loopback and does not
provision a Unit, sign/publish packages or simulate incoming vehicle records.

## 1 Prepare macOS and the pinned Node toolchain

Run blocks in order in a native Apple Silicon Terminal; stop on error.
This revised walkthrough has not been executed during the documentation update.
It is a component-only check, not a vehicle deployment.

```sh
uname -m
printf 'Mounted external APFS volume (for example /Volumes/BUILD): '
read -r SDV_VOLUME
diskutil info "$SDV_VOLUME"
df -h "$SDV_VOLUME"
```

Expect `arm64` and an already mounted external APFS volume. Do not create a
missing mount directory. After confirming the volume:

```sh
SDV_WORK="$SDV_VOLUME/sdv-components"
mkdir -p "$SDV_WORK/tools" "$SDV_VOLUME/tmp"
export TMPDIR="$SDV_VOLUME/tmp"
export npm_config_cache="$SDV_WORK/cache/npm"
git --version
```

If Git is missing, use `xcode-select --install` and complete Apple's dialog.
Use Node **26.0.0** and npm **11.12.1**, not a floating latest version.
If both exact tools already exist, skip download/extraction and verify them
below. Otherwise obtain the official macOS ARM64 distribution:

```sh
mkdir -p "$SDV_WORK/tools/node-download"
cd "$SDV_WORK/tools/node-download"
curl --fail --location --remote-name https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz
curl --fail --location --remote-name https://nodejs.org/dist/v26.0.0/SHASUMS256.txt
test "$(shasum -a 256 node-v26.0.0-darwin-arm64.tar.gz | cut -d ' ' -f 1)" = "$(awk '$2 == "node-v26.0.0-darwin-arm64.tar.gz" {print $1}' SHASUMS256.txt)" && printf 'Checksum matches\n'
```

Continue only after `Checksum matches`; extract once, not over an existing
installation:

```sh
test ! -e "$SDV_WORK/tools/node-v26.0.0-darwin-arm64" && tar -xzf node-v26.0.0-darwin-arm64.tar.gz -C "$SDV_WORK/tools"
export PATH="$SDV_WORK/tools/node-v26.0.0-darwin-arm64/bin:$PATH"
```

For both an existing and a newly extracted installation:

```sh
node --version
node -p 'process.arch'
npm --version
```

Expect `v26.0.0`, `arm64`, `11.12.1`. The
[Node archive](https://nodejs.org/en/download/archive/v26.0.0) owns these
downloads. Use a short SSD volume name: macOS Unix sockets have path limits.

## 2 Clone this component

```sh
git clone --branch main https://github.com/alexmaninblack/brake-health-cloud.git "$SDV_WORK/brake-health-cloud"
cd "$SDV_WORK/brake-health-cloud"
git rev-parse HEAD
```

Record that revision with results. `main` is component development; complete
candidate reproduction instead uses the product repository's frozen pins.

## 3 Prepare and check the component

Install the locked dependencies, check types, run tests, then build:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run quality
```

Expect all commands to exit successfully; compiled backend output is
`out/backend/main.js`. Build and test commands can recreate `out/`, which
must not contain personal files. The React Dashboard is a **non-live fixture**;
it is not the integrated Presenter and does not demonstrate vehicle telemetry.

## 4 Start a separate local backend

Do not run this over an integrated demo backend. The example uses port
**18491**, separate from the normal integrated port. If that port is occupied,
stop here; do not kill another owner. Create a fresh, private, short data path:

```sh
umask 077
SDV_RUN="$(mktemp -d "$SDV_VOLUME/tmp/brake.XXXXXX")"
printf 'Local data: %s\n' "$SDV_RUN"
node out/backend/main.js --port 18491 \
  --database-path "$SDV_RUN/data.sqlite" \
  --admin-socket-path "$SDV_RUN/admin.sock" \
  --migrations-directory "$PWD/migrations"
```

Leave that terminal running. In a **second Terminal**:

```sh
curl --fail --silent --show-error http://127.0.0.1:18491/health/live
curl --fail --silent --show-error http://127.0.0.1:18491/health/ready
curl --silent --show-error --include http://127.0.0.1:18491/health/context
```

Expect `LIVE`, storage `ready: true` / schema 5, and **HTTP 503 /
CURRENT_UNIT_CONTEXT_UNAVAILABLE** for context. That last result is expected:
no vehicle has been provisioned/bound in this standalone check. Do not invent a
Unit UID or mark context ready to make the screen green. Real context and
container lifecycle belong to Demo Control.

## 5 Stop and retain the data

Press **Ctrl-C in the first Terminal**, then check from the second:

```sh
lsof -nP -iTCP:18491 -sTCP:LISTEN
```

No output (normally exit status 1) means no listener remains on that port.
The private data directory is retained; stopping is not reset or deletion.
For an installed demo, use its owner to stop only the relevant containers;
leave Docker Engine and unrelated workloads running.

## Component documentation

- [Advisory integration](docs/advisory-demo-control.md)
- [Freshness behavior](docs/demo-freshness.md)
- [License](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)

## Backend reference

This component owns durable Brake product ingestion, receipts, queries,
function observations and notification-only SSE. It does not sign or publish
vehicle software. Its current backend-only container does not ship the
source-only fixture Dashboard.

- [HTTP interface](apps/backend/src/brake-data-http.ts)
- [Closed product schemas](apps/backend/src/brake-data-contract.ts)
- [Durable store](apps/backend/src/brake-data-store.ts) and [database migrations](migrations/)
- [Advisory control](docs/advisory-demo-control.md)
- [Freshness interpretation](docs/demo-freshness.md)
- [Container build inputs](container-build.json)

Preserve database migrations and original product provenance when upgrading.
Cloud status, backend receipt and native driver advisory are separate
observations. Use Demo Control to operate the installed backend, not a second
standalone process against its data directory.

## Security and license

Keep OEM/SP certificates, tokens and operational databases outside Git.
Original work is Apache-2.0 under `maninblack`; see [LICENSE](LICENSE),
[NOTICE](NOTICE), [SECURITY.md](SECURITY.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
