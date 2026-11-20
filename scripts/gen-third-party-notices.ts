/**
 * Writes THIRD-PARTY-NOTICES.md: the open-source packages installed for the build (name, version, licence, home page), grouped by licence,
 * plus the notices that need more than a list entry. Run after `bun install`:  bun scripts/gen-third-party-notices.ts
 * It reads the package manifests in node_modules (the Bun store), so the list matches what the lockfile installs.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const found = new Map<string, { name: string; version: string; license: string; url: string }>()

function manifestDirs(nm: string): string[] {
  if (!existsSync(nm)) return []
  const out: string[] = []
  for (const e of readdirSync(nm, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(nm, e.name)
    if (e.name.startsWith('@')) { for (const s of readdirSync(p)) out.push(join(p, s)) } else out.push(p)
  }
  return out
}

const stores: string[] = [join(root, 'node_modules')]
for (const d of ['packages', 'modules', 'ee/modules']) {
  const base = join(root, d)
  if (existsSync(base)) for (const w of readdirSync(base)) stores.push(join(base, w, 'node_modules'))
}
const bunStore = join(root, 'node_modules', '.bun')
if (existsSync(bunStore)) for (const e of readdirSync(bunStore)) stores.push(join(bunStore, e, 'node_modules'))

for (const nm of stores) for (const dir of manifestDirs(nm)) {
  let real = dir
  try { real = realpathSync(dir) } catch { continue }
  const pj = join(real, 'package.json')
  if (!existsSync(pj)) continue
  let j: any
  try { j = JSON.parse(readFileSync(pj, 'utf8')) } catch { continue }
  if (!j.name || !j.version || String(j.name).startsWith('@veqsio')) continue
  let lic = j.license ?? j.licenses
  if (Array.isArray(lic)) lic = lic.map((x: any) => (typeof x === 'string' ? x : x.type)).join(' OR ')
  if (lic && typeof lic === 'object') lic = lic.type
  const repo = typeof j.repository === 'string' ? j.repository : j.repository?.url
  let url = String(j.homepage || repo || `https://www.npmjs.com/package/${j.name}`).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}` // "user/repo" shorthand
  if (!/^https?:\/\//.test(url)) url = `https://www.npmjs.com/package/${j.name}`
  found.set(`${j.name}@${j.version}`, { name: j.name, version: j.version, license: String(lic || 'see package'), url })
}

const rows = [...found.values()].sort((a, b) => a.license.localeCompare(b.license) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const groups = new Map<string, typeof rows>()
for (const r of rows) groups.set(r.license, [...(groups.get(r.license) ?? []), r])

let md = `# Third-party notices

Veqsio is licensed under the AGPL-3.0 (see LICENSE). It is built from the open-source packages listed here, each under its own licence. The full
licence text of every package is in its distribution (the \`LICENSE\` file inside the package, also present in the Docker images). This file is generated
by \`scripts/gen-third-party-notices.ts\`; it lists everything installed for the build, including build-time tools.

## Notices that need more than a list entry

- **Geist and Geist Mono** (fonts, Copyright (c) Vercel, in collaboration with basement.studio), SIL Open Font License 1.1, https://github.com/vercel/geist-font . The full licence text is in licenses/GEIST-OFL-1.1.txt (and in /licenses of the Docker images).
  The fonts are bundled at build time by \`next/font\`.
- **sharp-libvips** (\`@img/sharp-libvips-*\`, used by Next.js image optimisation), LGPL-3.0-or-later. It is a separate shared library that is loaded dynamically
  and not modified. Source: https://github.com/lovell/sharp-libvips and https://github.com/libvips/libvips .
- **web-push** and **axe-core**, MPL-2.0. The files are used unmodified. Source: https://github.com/web-push-libs/web-push and https://github.com/dequelabs/axe-core .
- **caniuse-lite**, CC-BY-4.0: browser-support data from https://caniuse.com/ (Alexis Deveria, Lea Verou and contributors).
- **Container images** used next to Veqsio, each under its own licence: PostgreSQL (PostgreSQL Licence), Valkey (BSD-3-Clause), Caddy (Apache-2.0), nginx (BSD-2-Clause),
  the Bun runtime (MIT) and Node.js (MIT).

## Packages by licence

${rows.length} packages.

`
for (const [lic, list] of groups) {
  md += `### ${lic} (${list.length})\n\n`
  for (const r of list) md += `- ${r.name} ${r.version} — ${r.url}\n`
  md += '\n'
}
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), md)
console.log(`THIRD-PARTY-NOTICES.md: ${rows.length} packages in ${groups.size} licences`)
