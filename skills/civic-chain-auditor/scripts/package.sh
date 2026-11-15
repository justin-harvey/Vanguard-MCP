#!/usr/bin/env bash
#
# Package the skill into an Agensi-ready zip: a single top-level folder,
# text files only, with the locally-built demo database and OS cruft excluded.
# The .sqlite is rebuilt from the shipped .sql by scripts/verify-setup.js, so it
# is never shipped; Agensi rejects binaries.
#
# Usage: scripts/package.sh [output-dir]   (defaults to ./dist)

set -euo pipefail

# The skill folder is this script's parent. Its basename is the single
# top-level folder inside the zip, which is what Agensi expects.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill_dir="$(dirname "$script_dir")"
skill_name="$(basename "$skill_dir")"
parent_dir="$(dirname "$skill_dir")"

out_dir="${1:-$skill_dir/dist}"
mkdir -p "$out_dir"
# Resolve to an absolute path so the later cd doesn't strand a relative one.
out_dir="$(cd "$out_dir" && pwd)"
zip_path="$out_dir/$skill_name.zip"
rm -f "$zip_path"

# Zip from the parent so every entry is prefixed with the skill folder name.
cd "$parent_dir"
zip -r -X "$zip_path" "$skill_name" \
    -x "$skill_name/dist/*" \
    -x "$skill_name/scripts/package.sh" \
    -x "*.sqlite" \
    -x "*.db" \
    -x "*.DS_Store" \
    -x "*/Thumbs.db" \
    -x "*/.git/*" \
    -x "*/node_modules/*"

echo
echo "Wrote $zip_path"
echo "Contents:"
unzip -l "$zip_path"

# Fail loudly if anything binary slipped through, so a bad package never ships.
# -Z1 lists entry names only, so the zip's own filename can't be a false match.
if unzip -Z1 "$zip_path" | grep -qiE '\.(sqlite|db|png|jpg|jpeg|gif|zip|gz|tar)$'; then
    echo "ERROR: the package contains a binary or archive file; Agensi rejects these." >&2
    exit 1
fi
echo "OK: text-only, single top-level folder \"$skill_name/\"."
