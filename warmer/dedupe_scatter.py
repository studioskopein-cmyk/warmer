#!/usr/bin/env python3
"""Collapse duplicate Figma scatter-stamp <g> blocks in onboarding SVG markup.

Figma exports one <g id="strokeN_276_649"> per stroke, each wrapping an
identical scatter-dot <path>. Only the geometry is duplicated; the <use>
elements elsewhere in the file give each stroke its own position/rotation.
This keeps one canonical <g> per distinct scatter path, drops the rest, and
repoints their <use xlink:href="#strokeN_276_649"> references to the
survivor.
"""
import re
import sys

GROUP_RE = re.compile(
    r'<g id="(stroke\d+_276_649)" data-figma-scatter-ref="[^"]*" '
    r'data-figma-scatter="[^"]*">(.*?)</g>',
    re.DOTALL,
)


def dedupe(html):
    seen = {}
    redirects = {}
    spans = []

    for m in GROUP_RE.finditer(html):
        gid, content = m.group(1), m.group(2)
        if content in seen:
            redirects[gid] = seen[content]
            spans.append((m.start(), m.end()))
        else:
            seen[content] = gid

    for start, end in sorted(spans, reverse=True):
        html = html[:start] + html[end:]

    for dup_id, canonical in redirects.items():
        html = html.replace(f'xlink:href="#{dup_id}"', f'xlink:href="#{canonical}"')

    return html, len(redirects)


def self_test():
    demo = '''<svg><defs>
<g id="stroke0_276_649" data-figma-scatter-ref="stroke0_276_649_ref" data-figma-scatter="x">
<path d="SAME"/>
</g>
<path id="stroke0_276_649_ref" d="A"/>
<g id="stroke1_276_649" data-figma-scatter-ref="stroke1_276_649_ref" data-figma-scatter="y">
<path d="SAME"/>
</g>
<path id="stroke1_276_649_ref" d="B"/>
</defs>
<use xlink:href="#stroke0_276_649" transform="t0"/>
<use xlink:href="#stroke1_276_649" transform="t1"/>
</svg>'''
    out, dropped = dedupe(demo)
    assert dropped == 1, f"expected 1 dropped, got {dropped}"
    assert 'id="stroke1_276_649"' not in out, "duplicate group not removed"
    assert out.count('xlink:href="#stroke0_276_649"') == 2, "use refs not repointed"
    assert 'id="stroke1_276_649_ref"' in out, "unrelated _ref path was touched"
    print("demo ok")


def main():
    if len(sys.argv) == 1:
        self_test()
        return

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        html = f.read()

    before = len(html.encode("utf-8"))
    out, dropped = dedupe(html)
    after = len(out.encode("utf-8"))

    with open(path, "w", encoding="utf-8") as f:
        f.write(out)

    pct = (1 - after / before) * 100
    print(
        f"dropped {dropped} duplicate stamps, {before:,} -> {after:,} bytes "
        f"({pct:.1f}% smaller)"
    )


if __name__ == "__main__":
    main()
