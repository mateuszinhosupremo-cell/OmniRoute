#!/bin/sh
# Builds dist/Mark5_SymIndustries_v2_3.mcaddon (BP + RP) from pack/.
set -eu
cd "$(dirname "$0")/.."
OUT="$(pwd)/dist/Mark5_SymIndustries_v2_3.mcaddon"
mkdir -p dist
rm -f "$OUT"
cd pack
# deterministic order, no OS junk
find Mark5_BP Mark5_RP -type f ! -name '.DS_Store' ! -name 'Thumbs.db' | LC_ALL=C sort > ../dist/.filelist
zip -X -q -9 "$OUT" -@ < ../dist/.filelist
rm -f ../dist/.filelist
cd ..
python3 -I - "$OUT" <<'EOF'
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = [n for n in z.namelist() if n.endswith('.json') and not json.loads(z.read(n).decode('utf-8')) is not None]
print(f"{sys.argv[1]}: {len(z.namelist())} files, {sum(i.file_size for i in z.infolist())/1024:.0f} KiB uncompressed")
EOF
