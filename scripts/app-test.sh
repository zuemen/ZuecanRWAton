#!/usr/bin/env bash
# Run the JSON Ledger API app (app/) end to end against a Canton sandbox with
# wall-clock time: build the DAR, start the sandbox with it, run the flow and
# write the regulator's page to app/out/. Needs Docker and Node >= 22.18.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${DAML_IMAGE:-digitalasset/daml-sdk:3.4.0-rc2}"
name="zuecan-app-sandbox-$$"
chmod -R a+rwX .
docker run --rm -v "$PWD:/w" -w /w "$image" daml build --all > /tmp/zuecan-build.log 2>&1 \
  || { tail -30 /tmp/zuecan-build.log; exit 1; }
# The JSON API listens on localhost inside the container, so share the host
# network rather than publishing ports.
docker run -d --rm --name "$name" --network host -v "$PWD:/w" -w /tmp "$image" sh -c \
  'daml sandbox --wall-clock-time --port 6865 --json-api-port 7575 --port-file /tmp/port \
     --dar /w/main/.daml/dist/zuecan-rwa-0.1.0.dar > /tmp/sandbox.log 2>&1; sleep infinity' > /dev/null
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
for i in $(seq 1 150); do
  docker exec "$name" test -s /tmp/port 2> /dev/null && break
  sleep 2
done
docker exec "$name" test -s /tmp/port || { docker exec "$name" tail -40 /tmp/sandbox.log; exit 1; }
echo "Canton sandbox up after $((i * 2))s"
(cd app && node --test test/*.test.ts && LEDGER_URL=http://localhost:7575 node src/flow.ts)
