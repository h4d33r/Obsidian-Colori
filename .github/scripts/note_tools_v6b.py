from pathlib import Path

source = Path('.github/scripts/note_tools_v6.py').read_text(encoding='utf-8')
source = source.replace("    'text: \"Connections\"',\n", "    '\"Connections\"',\n", 1)
exec(compile(source, '.github/scripts/note_tools_v6.py', 'exec'))
