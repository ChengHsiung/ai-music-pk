"""Builds src/fonts/huninn.woff2: the rounded font jf open 粉圓 (Huninn, SIL OFL 1.1) cut down to
the characters this app can show, so the single-file build stays small and works offline.

Keeps every character used in the source, the 5,401 common characters of Big5 level 1 (so the
cloud AI's song titles also use the font), Latin, bopomofo and punctuation.

    npm pack @fontsource/huninn@5.3.0 && tar xzf fontsource-huninn-5.3.0.tgz
    python3 -m pip install fonttools brotli
    python3 scripts/subset-font.py package
"""

import glob
import os
import re
import sys
import tempfile

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def unicode_ranges(css: str) -> dict[str, set[int]]:
    """The code points of each slice of the font, from its @font-face rules."""
    slices = {}
    for name, ranges in re.findall(r"/\* huninn-\[?([\w-]+)\]?-400-normal \*/.*?unicode-range: ([^;]+);", css, re.S):
        points = set()
        for part in ranges.split(','):
            part = part.strip().removeprefix('U+')
            lo, _, hi = part.partition('-')
            points.update(range(int(lo, 16), int(hi or lo, 16) + 1))
        slices[name] = points
    return slices


def big5_level1() -> set[int]:
    points = set()
    for hi in range(0xA4, 0xC7):
        for lo in [*range(0x40, 0x7F), *range(0xA1, 0xFF)]:
            if hi == 0xC6 and lo > 0x7E:
                break
            try:
                points.add(ord(bytes([hi, lo]).decode('big5')))
            except UnicodeDecodeError:
                pass
    return points


def wanted() -> set[int]:
    points = big5_level1()
    for path in [*glob.glob(f'{ROOT}/src/**/*.ts', recursive=True), f'{ROOT}/index.html']:
        with open(path, encoding='utf-8') as f:
            points.update(ord(c) for c in f.read())
    for lo, hi in [(0x20, 0x7F), (0xA0, 0x100), (0x2000, 0x2070), (0x2190, 0x2200), (0x2460, 0x2500),
                   (0x25A0, 0x2700), (0x3000, 0x3040), (0x3100, 0x3130), (0xFF00, 0xFFF0)]:
        points.update(range(lo, hi))
    return points


def main(package: str):
    with open(f'{package}/index.css', encoding='utf-8') as f:
        slices = unicode_ranges(f.read())
    need = wanted()
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for name, points in slices.items():
            keep = sorted(points & need)
            if not keep:
                continue
            font = TTFont(f'{package}/files/huninn-{name}-400-normal.woff2')
            font.flavor = None
            options = subset.Options()
            options.layout_features = ['*']
            options.name_IDs = ['*']
            sub = subset.Subsetter(options)
            sub.populate(unicodes=keep)
            sub.subset(font)
            parts.append(f'{tmp}/{name}.ttf')
            font.save(parts[-1])
        merged = Merger().merge(parts)
    merged.flavor = 'woff2'
    out = f'{ROOT}/src/fonts/huninn.woff2'
    merged.save(out)
    print(f'{out}: {len(merged.getBestCmap())} characters, {os.path.getsize(out) // 1024} KB')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'package')
