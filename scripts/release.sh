#!/usr/bin/env bash
# Cuts a release of the community edition: bumps every package version, commits "Release vX.Y.Z" and creates the annotated tag vX.Y.Z.
# Pushing the tag makes GitHub Actions (.github/workflows/release.yml) publish the GitHub release with the CHANGELOG notes, so the
# repository page always shows which version is the latest.
#
#   scripts/release.sh 1.2.0            commit and tag locally, print the push command
#   scripts/release.sh 1.2.0 --push     also push the branch and the tag
#
# Before running: add a "## [1.2.0] - YYYY-MM-DD" section to CHANGELOG.md and commit everything else. For a security release add the line
# "[security]" to the section; a minimum version that may upgrade straight to it as "min-from: x.y.z" (read by the cloud release manifest).
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-}"; die() { echo "$*" >&2; exit 1; }
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh X.Y.Z [--push]"
git rev-parse --git-dir >/dev/null 2>&1 || die "run this in a git checkout"
git diff --quiet && git diff --cached --quiet || die "the working tree has uncommitted changes"
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && die "tag v$V already exists"
grep -q "^## \[$V\]" CHANGELOG.md || die "CHANGELOG.md has no section '## [$V]'"
NOTES="$(awk -v v="$V" '$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md)"
for f in package.json packages/*/package.json modules/*/package.json; do
  [ -f "$f" ] && sed -i -E '0,/"version": *"[^"]+"/s//"version": "'"$V"'"/' "$f"
done
git add -A && git commit -q -m "Release v$V"
git tag -a "v$V" -m "Veqsio $V"$'\n\n'"$NOTES"
echo "Created commit and tag v$V."
if [ "${2:-}" = "--push" ]; then git push origin HEAD "v$V"; else echo "Publish with: git push origin HEAD v$V"; fi
