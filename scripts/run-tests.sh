#!/usr/bin/env bash
#
# Runs every *.test.ts in its own ts-node process.
#
# The test files in this repo are plain Node scripts: they call a top-level
# run() and process.exit(1) on failure (no jest). Running each in a separate
# process keeps that contract and isolates state between suites.
#
# Usage:
#   npm test                # all suites
#   npm test -- <substr>    # only suites whose path contains <substr>

set -uo pipefail
cd "$(dirname "$0")/.."

TSNODE="./node_modules/.bin/ts-node"
if [[ ! -x "$TSNODE" ]]; then
    echo "ts-node not found at $TSNODE — run 'npm install' first." >&2
    exit 1
fi

filter="${1:-}"

mapfile -t files < <(
    find orchestrator packages -name '*.test.ts' \
        -not -path '*/node_modules/*' \
        -not -path '*/dist/*' |
        sort
)

pass=0
fail=0
failed=()

for f in "${files[@]}"; do
    if [[ -n "$filter" && "$f" != *"$filter"* ]]; then
        continue
    fi
    if "$TSNODE" "$f" >/tmp/yui-test.log 2>&1; then
        echo "  ✓ $f"
        ((pass++))
    else
        echo "  ✗ $f"
        sed 's/^/      /' /tmp/yui-test.log
        ((fail++))
        failed+=("$f")
    fi
done

echo
echo "Tests: $pass passed, $fail failed"
if ((fail > 0)); then
    printf '  failed: %s\n' "${failed[@]}"
    exit 1
fi
