#!/usr/bin/env python3
"""Generate macos/MARVIN/SymbolsIconMap.swift from the Symbols icon theme.

Antigravity bundles the Symbols icon theme (Miguel Solorio, MIT) and ships it
as the default — NOT Seti, which is what MARVIN wrongly ported first. This
script reads the theme manifest out of the installed Antigravity bundle (or a
path given on the command line) and emits the Swift lookup tables.

The SVG assets themselves are vendored separately into
macos/MARVIN/Resources/Symbols/{files,folders}; re-copy them whenever this is
re-run against a newer Antigravity.

    python3 scripts/generate-symbols-icon-map.py [path/to/symbol-icon-theme.json]
"""
import json
import pathlib
import sys

DEFAULT = (
    "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/"
    "theme-symbols/src/symbol-icon-theme.json"
)
OUT = pathlib.Path(__file__).resolve().parent.parent / "macos/MARVIN/SymbolsIconMap.swift"

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT)
theme = json.loads(src.read_text())
defs = theme["iconDefinitions"]


def rel(name):
    """icon-definition key -> 'files/foo' | 'folders/bar' (no extension)."""
    path = defs.get(name, {}).get("iconPath")
    if not path:
        return None
    parts = path.split("/")  # ./icons/files/foo.svg
    return f"{parts[-2]}/{parts[-1][:-4]}"


def table(mapping, label):
    rows = [
        f"        {json.dumps(k)}: {json.dumps(rel(mapping[k]))},"
        for k in sorted(mapping)
        if rel(mapping[k])
    ]
    return f"    static let {label}: [String: String] = [\n" + "\n".join(rows) + "\n    ]\n"


header = f'''// SymbolsIconMap — GENERATED. Do not hand-edit.
//
// Ported from the **Symbols** icon theme (Miguel Solorio, MIT) exactly as
// Antigravity ships it: `Antigravity IDE.app/Contents/Resources/app/
// extensions/theme-symbols/src/symbol-icon-theme.json`. Antigravity bundles
// Symbols and uses it by default — it is NOT Seti, which is why MARVIN's
// earlier Seti port could never match the reference screenshots (Seti has no
// folder icons at all; Symbols has 72, keyed by folder NAME, which is the
// "their directories have also something else" the user pointed at,
// 2026-08-29).
//
// Regenerate with `scripts/generate-symbols-icon-map.py`. Values are paths
// under `Resources/Symbols/`, minus the `.svg` — `files/yaml`,
// `folders/folder-docs`.

enum SymbolsIconMap {{
'''

body = (
    table(theme["fileExtensions"], "byExtension")
    + "\n"
    + table(theme["fileNames"], "byFileName")
    + "\n"
    + table(theme["languageIds"], "byLanguageId")
    + "\n"
    + table(theme["folderNames"], "byFolderName")
    + f'\n    static let defaultFile = {json.dumps(rel(theme["file"]))}\n'
    + f'    static let defaultFolder = {json.dumps(rel(theme["folder"]))}\n'
)

OUT.write_text(header + body + "}\n")
print(f"wrote {OUT} from {src}")
