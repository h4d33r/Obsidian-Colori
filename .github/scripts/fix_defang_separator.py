from pathlib import Path
p = Path('main.js')
s = p.read_text(encoding='utf-8')
old = 'return `${label} — ${defangDestination(destination)}`;'
new = 'return `${label} - ${defangDestination(destination)}`;'
if old not in s:
    raise SystemExit('Expected defang separator not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
