#!/usr/bin/env bash
# Fails if community code imports from the enterprise directory. Enterprise code may import community code,
# never the other way round (see ee/README.md).
# The one exception is the build-time generated, git-ignored web module registry (packages/web/lib/module-registry.generated.ts):
# it is written by packages/web/scripts/gen-module-registry.ts and is the bridge Next.js needs for static imports.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rEn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  "(from|import|require)\s*\(?\s*['\"][^'\"]*(^|/)ee/" \
  packages modules scripts 2>/dev/null | grep -v node_modules | grep -v 'module-registry.generated.ts' || true)

if [ -n "$hits" ]; then
  echo "Community code must not import from ee/:" >&2
  echo "$hits" >&2
  exit 1
fi
# Module code that is bundled into the web app (web.tsx, ui/, logic/) must not import API source by relative path:
# the web Docker image does not contain packages/api/src, so such an import breaks the production build.
web_hits=$(grep -rEn --include='*.ts' --include='*.tsx' \
  "(from|import|require)\s*\(?\s*['\"][^'\"]*packages/api/" \
  ee/modules/*/src/web.tsx ee/modules/*/src/ui ee/modules/*/src/logic 2>/dev/null | grep -v node_modules || true)
if [ -n "$web_hits" ]; then
  echo "Web-bundled module code must not import packages/api (use a local copy or the SDK):" >&2
  echo "$web_hits" >&2
  exit 1
fi
echo "ee boundary OK"
