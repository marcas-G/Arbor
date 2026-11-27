#!/usr/bin/env bash
# Local parallel functional-lane sweep: surface ALL failures in one pass.
# Each shard gets its own TMPDIR (per-test isolation is already fixture-level).
set -u
cd /home/lgao/work/web/arbor
OUT=/tmp/funct-sweep
rm -rf "$OUT"; mkdir -p "$OUT"
mapfile -t FILES < <(find tests/functional -name "*.functional.test.ts" | sort)
N=${1:-8}
TOTAL=${#FILES[@]}
PER=$(( (TOTAL + N - 1) / N ))
for ((s=0; s<N; s++)); do
  (
    SH=$((s+1))
    DIR="$OUT/shard-$SH"; mkdir -p "$DIR"; RWT="/home/lgao/work/web/arbor/.sweep-tmp/shard-$SH"; mkdir -p "$RWT"
    START=$((s*PER)); END=$((START+PER))
    PART=("${FILES[@]:START:PER}")
    [ ${#PART[@]} -eq 0 ] && exit 0
    TMPDIR="$RWT" TEMP="$RWT" TMP="$RWT" \
      pnpm vitest run "${PART[@]}" --config tests/configs/vitest.functional.config.ts \
      > "$DIR/run.log" 2>&1
    echo "exit=$?" > "$DIR/exit"
  ) &
done
wait
echo "=== SWEEP DONE ==="
for ((s=0; s<N; s++)); do
  SH=$((s+1)); DIR="$OUT/shard-$SH"
  E=$(cat "$DIR/exit" 2>/dev/null || echo "no-run")
  F=$(grep -c "FAIL " "$DIR/run.log" 2>/dev/null || echo 0)
  echo "shard $SH: $E failures=$F"
done
grep -h "FAIL " "$OUT"/shard-*/run.log 2>/dev/null | sort -u | head -40
