#!/usr/bin/env bash
# Run every scenario against a real Canton participant: a Canton sandbox with
# static time, the DARs uploaded over the Ledger API, and the scenarios run in
# sequence by Test.Canton:allScenarios. Same Docker image as daml-test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${DAML_IMAGE:-digitalasset/daml-sdk:3.4.0-rc2}"
chmod -R a+rwX .
set +e
docker run --rm -v "$PWD:/w" -w /tmp "$image" sh -c '
  set -e
  cd /w && daml build --all > /tmp/build.log 2>&1 || { tail -30 /tmp/build.log; exit 1; }
  cd /tmp
  daml sandbox --static-time --port 6865 --json-api-port 7575 --port-file /tmp/port > /tmp/sandbox.log 2>&1 &
  for i in $(seq 1 300); do [ -s /tmp/port ] && break; sleep 1; done
  [ -s /tmp/port ] || { echo "sandbox did not start"; tail -40 /tmp/sandbox.log; exit 1; }
  echo "Canton sandbox up after ${i}s"
  status=0
  daml script --dar /w/test/.daml/dist/zuecan-rwa-test-0.1.0.dar \
    --script-name Test.Canton:allScenarios \
    --ledger-host localhost --ledger-port 6865 --static-time --upload-dar yes > /tmp/script.log 2>&1 || status=$?
  grep -oE "running [A-Za-z0-9.]+" /tmp/script.log || true
  if [ "$status" -ne 0 ]; then
    echo "---- daml script output (stack frames omitted) ----"
    grep -vE "^[[:space:]]+at |^\[INFO\]" /tmp/script.log | cut -c1-400 | tail -40
  fi
  exit $status
' 2>&1 | tee /tmp/canton-test.log
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then
  echo "::error::scenarios failed on the Canton sandbox"
  exit "$status"
fi
echo "all scenarios passed on a Canton participant"
