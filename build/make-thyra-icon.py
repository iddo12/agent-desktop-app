"""Draws the THYRA icons (plain geometry, no text): an amber disc with a white bell; the -badge variant adds a red dot.
Run: python build/make-thyra-icon.py   -> build/icon-thyra.ico/.png and build/icon-thyra-badge.ico/.png (relative to this file)."""
import os
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024  # draw large, shrink for smooth edges

def draw(badge):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.ellipse([24, 24, S - 24, S - 24], fill=(245, 158, 11, 255))               # amber disc
    w = (255, 255, 255, 255)
    d.pieslice([250, 190, 774, 714], 180, 360, fill=w)                           # bell dome
    d.polygon([(250, 452), (774, 452), (860, 770), (164, 770)], fill=w)          # bell flare
    d.rounded_rectangle([140, 740, 884, 810], radius=35, fill=w)                 # rim
    d.ellipse([432, 800, 592, 920], fill=w)                                      # clapper
    d.rounded_rectangle([472, 120, 552, 230], radius=30, fill=w)                 # top knob
    if badge:
        d.ellipse([600, 40, 1000, 440], fill=(255, 255, 255, 255)); d.ellipse([635, 75, 965, 405], fill=(220, 38, 38, 255))   # red count dot
    return im

for name, badge in (("icon-thyra", False), ("icon-thyra-badge", True)):
    big = draw(badge)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [big.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[-1].save(os.path.join(HERE, name + ".png"))
    imgs[-1].save(os.path.join(HERE, name + ".ico"), sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
