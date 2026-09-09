#!/usr/bin/env python3
"""Regenerate CLI themes from two-face's pinned, compiled Syntect bundle.

Run: python3 scripts/generate-cli-themes.py [--bundle /path/to/themes.bin]

Use the compiled bundle rather than similarly named upstream tmTheme files:
two-face merges Syntect defaults and bat patches, and duplicate source filenames
can resolve to different variants. The pinned hash makes this narrow Bincode
reader safe against upstream schema drift. Source/license notices are maintained
in static/vendor/cli-themes.LICENSE.txt; update them when changing the pin.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
from urllib.request import urlopen
import zlib

REVISION = "33f7e243b6174e8f0c63fd7698ec5736d715e355"
SHA256 = "be28f0c1a167469c5bd1e5311d4d3503e6503b378791f2afb9e3e5f2f7f4642e"
URL = f"https://raw.githubusercontent.com/CosmicHorrorDev/two-face/{REVISION}/generated/themes.bin"
NAMES = """1337 ansi base16 base16-256 base16-eighties-dark base16-mocha-dark
base16-ocean-dark base16-ocean-light catppuccin-frappe catppuccin-latte
catppuccin-macchiato catppuccin-mocha coldark-cold coldark-dark dark-neon dracula
github gruvbox-dark gruvbox-light inspired-github monokai-extended
monokai-extended-bright monokai-extended-light monokai-extended-origin nord
one-half-dark one-half-light solarized-dark solarized-light sublime-snazzy
two-dark zenburn""".split()

# Syntect 5.3.0 ThemeSettings serde field order. Only the first two fields affect
# syntax rendering; consume all fields to reach the scope rules exactly.
SETTINGS_TYPES = (
    "color color color color color color color string string color enum color "
    "color enum color enum color color color color color color color color "
    "color color color color color color"
).split()


class Reader:
    def __init__(self, data):
        self.data = data
        self.position = 0

    def raw(self, length):
        result = self.data[self.position:self.position + length]
        self.position += length
        if len(result) != length:
            raise ValueError("Truncated theme bundle")
        return result

    def integer(self):
        return struct.unpack("<Q", self.raw(8))[0]

    def byte(self):
        return self.raw(1)[0]

    def string(self):
        return self.raw(self.integer()).decode("utf-8")

    def optional(self, read):
        flag = self.byte()
        if flag not in (0, 1):
            raise ValueError("Invalid optional value")
        return read() if flag else None

    def color(self):
        # Preserve alpha: 00 = indexed ANSI, 01 = terminal default.
        return "#" + self.raw(4).hex()

    def sequence(self, read):
        return [read() for _ in range(self.integer())]

    def stack(self):
        if self.sequence(lambda: self.sequence(self.string)):
            raise ValueError("Unexpected clear stack in theme selector")
        return " ".join(self.sequence(self.string))

    def selector(self):
        path = self.stack()
        return path + "".join(" - " + item for item in self.sequence(self.stack))

    def finish(self):
        if self.position != len(self.data):
            raise ValueError("Unconsumed theme bundle data")

    def theme(self, name):
        self.optional(self.string)  # Display name; replaced by CLI name.
        self.optional(self.string)  # Author; retained in license notices.
        base = {}
        readers = {
            "color": self.color,
            "string": self.string,
            "enum": lambda: struct.unpack("<I", self.raw(4))[0],
        }
        for index, kind in enumerate(SETTINGS_TYPES):
            value = self.optional(readers[kind])
            if index < 2 and value is not None:
                base[("foreground", "background")[index]] = value
        settings = [{"settings": base}]
        for _ in range(self.integer()):
            scope = ", ".join(self.sequence(self.selector))
            foreground = self.optional(self.color)
            background = self.optional(self.color)
            font = self.optional(self.byte)
            style = {}
            if foreground is not None:
                style["foreground"] = foreground
            if background is not None:
                style["background"] = background
            if font is not None:
                style["fontStyle"] = " ".join(
                    label for bit, label in ((1, "bold"), (2, "underline"), (4, "italic"))
                    if font & bit
                )
            settings.append({"scope": scope, "settings": style})
        self.finish()
        return {"name": name, "settings": settings}


def generate(bundle):
    if hashlib.sha256(bundle).hexdigest() != SHA256:
        raise ValueError("Theme bundle differs from the pinned source")
    reader = Reader(bundle)
    themes = {}
    normalize = lambda name: re.sub(r"[^a-z0-9]", "", name.lower())
    for _ in range(reader.integer()):
        name = reader.string()
        data = reader.raw(reader.integer())
        themes[normalize(name)] = Reader(zlib.decompress(data)).theme(name)
    reader.finish()
    if set(themes) != {normalize(name) for name in NAMES}:
        raise ValueError("CLI theme names differ from embedded bundle")
    return {name: {**themes[normalize(name)], "name": name} for name in NAMES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--output", type=Path, default=(
        Path(__file__).resolve().parent.parent / "src/webview/cli-themes.json"
    ))
    args = parser.parse_args()
    if args.bundle:
        bundle = args.bundle.read_bytes()
    else:
        with urlopen(URL, timeout=30) as response:
            bundle = response.read()
    args.output.write_text(json.dumps(generate(bundle), indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
