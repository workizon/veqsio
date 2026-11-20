#!/usr/bin/env python3
"""Adds translations for ONE language to lib/i18n/auto-<lang>.ts without touching existing entries.
usage: i18n-append.py <lang> <dir> [--keys keys.json]
<dir> holds in-*.json (JSON lists of English strings) and out-<lang>-*-*.json (JSON objects English -> translation).
Checks: every input string translated, no empty values, same {placeholders}. Existing entries in the auto file win."""
import json, sys, glob, os, re

lang, d = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'i18n')
name = 'auto' + lang.capitalize()
keys = [k for f in sorted(glob.glob(os.path.join(d, 'in-*.json'))) for k in json.load(open(f))]
tr = {}
for f in sorted(glob.glob(os.path.join(d, f'out-{lang}-*-*.json'))):
    tr.update(json.load(open(f)))
ph = lambda s: sorted(re.findall(r'\{[a-zA-Z]+\}', s))
missing = [k for k in keys if k not in tr]
extra = [k for k in tr if k not in set(keys)]
bad = [k for k in keys if k in tr and (not tr[k].strip() or ph(k) != ph(tr[k]))]
print(f'{lang}: {len(keys)} keys, {len(tr)} translated, missing {len(missing)}, unknown {len(extra)}, bad {len(bad)}')
for k in missing[:8]: print('  missing:', repr(k)[:100])
for k in bad[:8]: print('  bad:', repr(k)[:100], '->', repr(tr[k])[:100])
if '--check' in sys.argv: sys.exit(1 if missing or bad else 0)

path = os.path.join(root, f'auto-{lang}.ts')
cur = {}
for m in re.finditer(r'^  ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$', open(path, encoding='utf-8').read(), re.M):
    cur[json.loads(m.group(1))] = json.loads(m.group(2))
for k in keys:
    if k in tr and k not in cur and tr[k].strip() and ph(k) == ph(tr[k]) and tr[k] != k:
        cur[k] = tr[k]
body = ',\n'.join(f'  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}' for k, v in sorted(cur.items()))
hdr = open(path, encoding='utf-8').read().split('\n')[0]
open(path, 'w', encoding='utf-8').write(f'{hdr}\nexport const {name}: Record<string, string> = {{\n{body},\n}}\n')
print(f'{lang}: wrote {len(cur)} entries to {os.path.basename(path)}')
