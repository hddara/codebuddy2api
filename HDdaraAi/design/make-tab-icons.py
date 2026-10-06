#!/usr/bin/env python3
"""Draws the tabBar icons for HDdaraAi.

Companion to `make-app-icon.py`, and deliberately separate: the app icon is a
single 1024px mark, while a tabBar needs four small glyphs (two tabs × normal and
selected) at a size where a filled shape reads and an outline does not.

Run from the HDdaraAi directory:

    python3 design/make-tab-icons.py

Design notes that matter at 48px:

- The glyphs are drawn filled, not stroked. A 1.5px outline that looks refined at
  1024px collapses into a smudge at 48px; solid shapes survive.
- Only the *selected* variant carries the accent colour. The unselected one is a
  neutral grey so the tab bar stays quiet until something is active.
- Each glyph is positioned inside a common 24-unit box, so the two tabs share an
  optical weight and baseline instead of drifting apart.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/static/tabbar"

# Rendered large then downsampled: PIL has no antialiased shape primitives, and
# drawing at 48px directly produces visibly jagged edges.
SIZE = 81
SUPERSAMPLE = 4

ACCENT = (10, 132, 255, 255)  # #0A84FF, the app's accent
NEUTRAL = (138, 143, 153, 255)  # #8a8f99, matches the tabBar text colour


def rounded(draw: ImageDraw.ImageDraw, box, radius: float, fill) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def circle(draw: ImageDraw.ImageDraw, centre, radius: float, fill) -> None:
    cx, cy = centre
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)


def draw_chat(draw: ImageDraw.ImageDraw, colour) -> None:
    """A speech bubble with two short lines: 'conversations'."""
    # Body
    rounded(draw, (150, 190, 660, 560), 96, colour)
    # Tail — rooted well inside the body so the corner radius cannot cut it loose
    # (the same trap the app icon hit).
    draw.polygon([(250, 470), (250, 700), (430, 500)], fill=colour)
    # Lines. Painted in opaque white rather than punched through: the tabBar's
    # background is white, so a transparent hole would reveal whatever is behind
    # the bar instead of reading as part of the glyph.
    for y, w in ((300, 260), (400, 170)):
        rounded(draw, (240, y, 240 + w, y + 48), 24, (255, 255, 255, 255))


def draw_gear(draw: ImageDraw.ImageDraw, colour) -> None:
    """A cog: 'settings'.

    The teeth are short and blunt on purpose. A first attempt used long thin
    teeth, which at 48px read as a sun or a steering wheel rather than a cog —
    the silhouette has to look like a gear when the detail is gone, and that
    means few, thick, stubby teeth.
    """
    import math

    centre = (405, 405)
    # Small enough that the teeth stay well inside the canvas.
    body_radius = 178
    tooth_inner = 150
    tooth_outer = 250
    tooth_half_width = 66

    for index in range(6):
        angle = index * math.pi / 3
        dx, dy = math.cos(angle), math.sin(angle)
        px, py = -dy, dx  # perpendicular

        points = [
            (centre[0] + dx * tooth_inner + px * tooth_half_width,
             centre[1] + dy * tooth_inner + py * tooth_half_width),
            (centre[0] + dx * tooth_outer + px * tooth_half_width,
             centre[1] + dy * tooth_outer + py * tooth_half_width),
            (centre[0] + dx * tooth_outer - px * tooth_half_width,
             centre[1] + dy * tooth_outer - py * tooth_half_width),
            (centre[0] + dx * tooth_inner - px * tooth_half_width,
             centre[1] + dy * tooth_inner - py * tooth_half_width),
        ]
        draw.polygon(points, fill=colour)

    circle(draw, centre, body_radius, colour)

    # Hub hole. Drawn white rather than left transparent: the tabBar sits on a
    # white background, and a see-through hole would reveal whatever is behind
    # the tab bar instead of reading as a hole.
    circle(draw, centre, 78, (255, 255, 255, 0))


def render(glyph, colour, path: Path) -> None:
    # Draw into an 810-unit design space, upscale, then downsample. Going through
    # two steps keeps the geometry expressed in readable coordinates while the
    # final resize does the antialiasing PIL's shapes lack.
    scratch = Image.new("RGBA", (810, 810), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(scratch), colour)

    big = SIZE * SUPERSAMPLE
    out = scratch.resize((big, big), Image.Resampling.LANCZOS).resize(
        (SIZE, SIZE),
        Image.Resampling.LANCZOS,
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path, format="PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {out.size[0]}x{out.size[1]}")


def main() -> None:
    print("tabBar icons")
    for name, glyph in (("chat", draw_chat), ("gear", draw_gear)):
        render(glyph, NEUTRAL, OUT / f"{name}.png")
        render(glyph, ACCENT, OUT / f"{name}-active.png")

    print("done")


if __name__ == "__main__":
    main()
