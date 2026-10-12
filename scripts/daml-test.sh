#!/usr/bin/env bash
# Build both packages and run all scenarios inside the pinned Daml SDK image.
# Fails if a scenario fails or if any non-Archive choice is never exercised.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${DAML_IMAGE:-digitalasset/daml-sdk:3.4.0-rc2}"
# The image runs as user `daml`; let it write .daml/ build output here.
chmod -R a+rwX .
log="$(mktemp)"
set +e
docker run --rm -v "$PWD:/w" -w /w "$image" \
  sh -c 'daml build --all && cd test && daml test --show-coverage --all' 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then
  echo "::error::daml build or daml test failed"
  exit "$status"
fi
if grep -E ': failed' "$log"; then
  echo "::error::a scenario failed"
  exit 1
fi
# Coverage gate: the never-exercised list may only contain built-in Archive.
unexercised="$(sed -n '/template choices never exercised: [1-9]/,/^- /p' "$log" \
  | grep -E '^ +zuecan-rwa:' | grep -v ':Archive$' || true)"
if [ -n "$unexercised" ]; then
  echo "::error::choices never exercised by any scenario:"
  echo "$unexercised"
  exit 1
fi
echo "all scenarios passed; every non-Archive choice is exercised"
