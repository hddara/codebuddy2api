#!/usr/bin/env python3
"""Draws the HDdaraAi app icon and writes every platform size.

The icon is drawn from primitives rather than shipped as a bitmap so it stays
crisp at any size and can be regenerated after a palette change. Run:

    python3 design/make-app-icon.py

Concept: a speech bubble whose tail points down-left, holding three left-aligned
bars that shorten downwards — the shape a streaming reply makes as it is written.
The shortest bar ends in a caret, because the product's core promise is watching
an answer arrive live.

Only the *glyph* is transparent-backgrounded; every binary platform (iOS,
Android) composites it onto a filled rounded square, since both stores require
an opaque icon. Android's adaptive foreground is exported separately and keeps
its alpha, because the system draws its own background mask there.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

SUPERSAMPLE = 4

# Palette. #0A84FF is the app's primary accent (it is the same blue the session
# list already uses for the active time-window chip), so the icon reads as part
# of the same product rather than as a separate brand.
GRADIENT_TOP = (10, 132, 255)  # #0A84FF
GRADIENT_BOTTOM = (0, 92, 214)  # #005CD6
GLYPH = (255, 255, 255)
GLYPH_SOFT = (255, 255, 255, 235)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def make_vertical_gradient(size: int) -> Image.Image:
    """Top-to-bottom gradient, drawn one row at a time (fast enough at 4x)."""
    image = Image.new("RGB", (1, size))
    pixels = image.load()

    for y in range(size):
        t = y / max(size - 1, 1)
        pixels[0, y] = (
            int(round(lerp(GRADIENT_TOP[0], GRADIENT_BOTTOM[0], t))),
            int(round(lerp(GRADIENT_TOP[1], GRADIENT_BOTTOM[1], t))),
            int(round(lerp(GRADIENT_TOP[2], GRADIENT_BOTTOM[2], t))),
        )

    return image.resize((size, size), Image.Resampling.BILINEAR)


def rounded_square_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=int(size * radius_ratio),
        fill=255,
    )

    return mask


def draw_glyph(
    canvas: Image.Image,
    scale: float,
    offset: tuple[float, float],
    bubble_fill: tuple[int, int, int, int],
    bar_fill: tuple[int, int, int, int],
    caret_fill: tuple[int, int, int, int],
) -> None:
    """Draws the bubble + bars onto an RGBA canvas.

    All geometry below is expressed in a 1024-unit design space and then scaled,
    so the same numbers describe the 1024px master and the 48px drawer icon.

    Colours are parameters because the two icon variants invert each other: a
    blue bubble with knocked-out bars is unreadable on the blue background, so
    the master uses a white bubble and paints the bars in the gradient blue.
    """
    draw = ImageDraw.Draw(canvas)
    ox, oy = offset

    def px(value: float) -> float:
        return value * scale

    def point(x: float, y: float) -> tuple[float, float]:
        return (ox + px(x), oy + px(y))

    # ---- speech bubble -------------------------------------------------
    # A rounded rect with a triangular tail on the lower-left. Drawn as a
    # polygon+rounded-rect union: the tail's base is hidden under the body, so
    # no seam is visible.
    body = (232.0, 236.0, 792.0, 664.0)
    # The tail has to reach well *above* the bottom-left corner radius (112),
    # otherwise the rounded corner slices the join and the tail floats free —
    # a gap that is invisible at 1024px and glaring at 48px. Rooting it at
    # y=470 puts its top edge deep inside the body's straight section.
    tail = [(296.0, 470.0), (296.0, 742.0), (470.0, 508.0)]

    draw.rounded_rectangle(
        (px(body[0]), px(body[1]), px(body[2]), px(body[3])),
        radius=px(112.0),
        fill=bubble_fill,
    )
    draw.polygon([point(x, y) for x, y in tail], fill=bubble_fill)

    # ---- streaming bars ------------------------------------------------
    # Tapering widths read as "still being written"; the caret marks the cursor.
    bar_height = 54.0
    bar_radius = bar_height / 2
    bar_left = 320.0
    widths = (320.0, 232.0, 128.0)
    tops = (356.0, 466.0, 576.0)

    for width, top in zip(widths, tops):
        draw.rounded_rectangle(
            (
                px(bar_left),
                px(top),
                px(bar_left + width),
                px(top + bar_height),
            ),
            radius=px(bar_radius),
            fill=bar_fill,
        )

    # Caret sits right after the last (shortest) bar.
    caret_size = 54.0
    caret_left = bar_left + widths[-1] + 30.0
    draw.rounded_rectangle(
        (
            px(caret_left),
            px(tops[-1]),
            px(caret_left + caret_size),
            px(tops[-1] + bar_height),
        ),
        radius=px(bar_radius * 0.55),
        fill=caret_fill,
    )


def render_master(size: int, *, with_background: bool, radius_ratio: float) -> Image.Image:
    """Renders the icon at `size`, optionally flattened onto a rounded square."""
    big = size * SUPERSAMPLE

    if with_background:
        canvas = make_vertical_gradient(big).convert("RGBA")
    else:
        canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # Scale the 1024-unit design space onto the (supersampled) canvas.
    # White bubble, blue bars: a blue bubble would not separate from the field.
    draw_glyph(
        canvas,
        scale=big / 1024.0,
        offset=(0.0, 0.0),
        bubble_fill=(*GLYPH, 255),
        bar_fill=(*GRADIENT_TOP, 255),
        caret_fill=(*GRADIENT_TOP, 200),
    )

    if with_background:
        mask = rounded_square_mask(big, radius_ratio)
        # The gradient must be *behind* the glyph, so paste the gradient through
        # the mask and let the glyph's alpha sit on top.
        backed = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        gradient = make_vertical_gradient(big).convert("RGBA")
        backed.paste(gradient, (0, 0), mask)
        backed.alpha_composite(canvas)
        canvas = backed

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def write(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {image.size[0]}x{image.size[1]}")


def main() -> None:
    design = ROOT / "design"
    android_res = ROOT / "dcloud-android/shell/simpleDemo/src/main/res"
    ios_iconset = (
        ROOT
        / "dcloud-ios/SDK/HBuilder-Hello/HBuilder-Hello/Assets.xcassets/AppIcon.appiconset"
    )

    # Store icons are masked by the OS, so a generous radius keeps the art from
    # being clipped at the corners. iOS's own mask is ~22.4% of the side.
    master = render_master(1024, with_background=True, radius_ratio=0.235)

    print("design")
    write(design / "app-icon-1024.png", master)

    # Smaller previews: what the icon actually looks like in a launcher.
    for preview in (180, 120, 80, 48):
        write(design / f"preview/app-icon-{preview}.png", render_master(
            preview, with_background=True, radius_ratio=0.235,
        ))

    print("ios")
    write(ios_iconset / "icon1024.png", master)

    # Launch logo (`dclogo@2x/@3x`), shown by the shell's launch storyboard while
    # the webview boots. It is a *separate* asset from the app icon and was still
    # the scaffold's shopping-cart artwork, so the first frame of the app showed
    # another product's brand. Centre the glyph in a transparent square instead
    # of drawing the rounded plate, because the storyboard supplies the backdrop.
    # Sizes are copied from the assets being replaced (120 / 180 = 60pt @2x/@3x);
    # the storyboard draws them at a 60pt square, so matching the originals keeps
    # the launch layout untouched.
    print("ios launch logo")
    for suffix, px in (("2x", 120), ("3x", 180)):
        logo = Image.new("RGBA", (px * SUPERSAMPLE, px * SUPERSAMPLE), (0, 0, 0, 0))
        inset = px * SUPERSAMPLE * 0.12
        draw_glyph(
            logo,
            scale=(px * SUPERSAMPLE - inset * 2) / 1024.0,
            offset=(inset, inset),
            bubble_fill=(*GRADIENT_TOP, 255),
            bar_fill=(255, 255, 255, 255),
            caret_fill=(255, 255, 255, 220),
        )
        write(
            ROOT / f"dcloud-ios/SDK/HBuilder-Hello/HBuilder-Hello/dclogo@{suffix}.png",
            logo.resize((px, px), Image.Resampling.LANCZOS),
        )

    print("android (legacy mipmap)")
    # Named `icon.png` in the shell project; the density buckets determine the
    # pixel size the launcher picks.
    densities = {
        "drawable-mdpi": 48,
        "drawable-hdpi": 72,
        "drawable-xhdpi": 96,
        "drawable-xxhdpi": 144,
        "drawable-xxxhdpi": 192,
    }

    for folder, px in densities.items():
        write(android_res / folder / "icon.png", render_master(
            px, with_background=True, radius_ratio=0.235,
        ))

    # Adaptive icon foreground: the system applies its own mask, and the safe
    # zone is the middle 66% of the canvas, so the glyph is scaled down and the
    # background stays transparent.
    print("android (legacy mipmap, for roundIcon on API < 26)")
    # `mipmap-anydpi-v26/ic_launcher.xml` only exists from API 26, so the same
    # name must also resolve to a real bitmap on older releases — a missing
    # resource there is a startup crash, not a fallback.
    for folder, px in densities.items():
        write(
            android_res / folder.replace("drawable-", "mipmap-") / "ic_launcher.png",
            render_master(px, with_background=True, radius_ratio=0.5),
        )

    print("android (adaptive foreground)")
    for folder, px in {
        "drawable-mdpi": 108,
        "drawable-hdpi": 162,
        "drawable-xhdpi": 216,
        "drawable-xxhdpi": 324,
        "drawable-xxxhdpi": 432,
    }.items():
        canvas_px = px * SUPERSAMPLE
        fg = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))

        # Adaptive icons reserve only the middle 66% as the safe zone; anything
        # outside it may be clipped by the launcher's mask. The glyph is scaled
        # to fit that zone and centred on the *artwork's* centre — not the canvas
        # centre — because the tail makes the figure asymmetric.
        glyph_box = (232.0, 236.0, 792.0, 742.0)  # bubble + tail, design units
        glyph_w = glyph_box[2] - glyph_box[0]
        glyph_h = glyph_box[3] - glyph_box[1]

        safe = canvas_px * 0.66
        scale = min(safe / glyph_w, safe / glyph_h)
        offset = (
            (canvas_px - glyph_w * scale) / 2 - glyph_box[0] * scale,
            (canvas_px - glyph_h * scale) / 2 - glyph_box[1] * scale,
        )

        # The launcher composites this over its own background, which may be any
        # colour, so the glyph keeps the master's white plate and blue bars.
        draw_glyph(
            fg,
            scale=scale,
            offset=offset,
            bubble_fill=(*GLYPH, 255),
            bar_fill=(*GRADIENT_TOP, 255),
            caret_fill=(*GRADIENT_TOP, 200),
        )
        write(
            android_res / folder / "icon_foreground.png",
            fg.resize((px, px), Image.Resampling.LANCZOS),
        )

        # Themed icons (Android 13+) are tinted by the system, so only the alpha
        # channel is read. The bubble is the solid plate and the bars are holes
        # in it — painting them solid white would erase them and leave a blank
        # blob once the system applies its tint.
        mono = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        draw_glyph(
            mono,
            scale=scale,
            offset=offset,
            bubble_fill=(255, 255, 255, 255),
            bar_fill=(0, 0, 0, 0),
            caret_fill=(0, 0, 0, 0),
        )
        write(
            android_res / folder / "icon_monochrome.png",
            mono.resize((px, px), Image.Resampling.LANCZOS),
        )

    # Palette record, so a future restyle has the exact values at hand.
    write(
        design / "palette.json",
        Image.new("RGB", (1, 1)),
    )
    (design / "palette.json").write_text(
        json.dumps(
            {
                "gradientTop": "#%02X%02X%02X" % GRADIENT_TOP,
                "gradientBottom": "#%02X%02X%02X" % GRADIENT_BOTTOM,
                "glyph": "#%02X%02X%02X" % GLYPH,
                "cornerRadiusRatio": 0.235,
                "concept": (
                    "speech bubble holding tapering streaming bars plus a caret — "
                    "an answer being written live"
                ),
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    print("done")


if __name__ == "__main__":
    main()
