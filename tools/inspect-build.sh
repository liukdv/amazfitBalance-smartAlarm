#!/bin/bash
# Opens the latest built package and shows what each target really contains.
# Useful to verify the app-service is inside: the build does not fail if it is not.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT=$ROOT/inspect
rm -rf "$OUT"
mkdir -p "$OUT"

ZAB=$(ls -t "$ROOT"/probe/dist/*.zab | head -1)
echo "package: $(basename "$ZAB")"
unzip -o -q "$ZAB" -d "$OUT/zab"

i=0
for zpk in "$OUT"/zab/*.zpk; do
  i=$((i+1))
  unzip -o -q "$zpk" -d "$OUT/zpk$i"
  if [ -f "$OUT/zpk$i/device.zip" ]; then
    unzip -o -q "$OUT/zpk$i/device.zip" -d "$OUT/dev$i"
    echo ""
    echo "--- target $i ---"
    dw=$(grep -o '"designWidth":[0-9]*' "$OUT/dev$i/app.json" || true)
    src=$(grep -o '"deviceSource":[0-9]*' "$OUT/dev$i/app.json" | head -3 | tr '\n' ' ' || true)
    echo "  $dw | $src"
    find "$OUT/dev$i" -type f -name '*.bin' -exec basename {} \; | sort | sed 's/^/  bin: /'
    if find "$OUT/dev$i" -type d -name 'app-service' | grep -q .; then
      echo "  APP-SERVICE: present"
    else
      echo "  APP-SERVICE: MISSING  <-- problem"
    fi
  fi
done
