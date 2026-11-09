import math, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
SP = sys.argv[1]
W, H, S = 1200, 630, 2                      # draw at 2x, downsample for smooth edges
BAND = (115, 515)                           # the 3:1 strip Cherry shows (cover crop, centered)
import numpy as np
# Smooth glow computed in float + ~1 level of dither, so the dark gradient has no visible rings (banding).
ys, xs = np.mgrid[0:H*S, 0:W*S].astype(np.float64)
g = np.exp(-(((xs - W*S*0.5) / (W*S*0.30))**2 + ((ys - H*S*0.46) / (H*S*0.30))**2))
base = np.array([5, 6, 15], dtype=np.float64)
pink = np.array([110, 22, 62], dtype=np.float64)
rgb = base + (pink - base) * (0.62 * g)[..., None]
rng = np.random.default_rng(7)
rgb += rng.uniform(-0.9, 0.9, size=rgb.shape[:2])[..., None]   # same noise on all channels: no colour speckle
img = Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8), 'RGB')

def petal(cx, cy, size, angle, color, alpha):
    """Sakura petal: narrow at the stem, wide rounded tip with a small notch, soft lighter centre."""
    import math as m
    n = int(size*2.6)
    layer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = n/2
    pts = []
    for i in range(120):
        t = 2*m.pi*i/120
        y = -m.cos(t)                       # -1 tip .. +1 stem
        widen = 0.62*(1 - 0.55*max(0, y))   # taper toward the stem
        x = m.sin(t)*widen
        if y < -0.80 and abs(x) < 0.14:     # notch at the tip
            y = -0.80 + (0.14 - abs(x))*0.9
        pts.append((c + x*size, c + y*size))
    d.polygon(pts, fill=color + (alpha,))
    hi = tuple(int(v + (255 - v)*0.22) for v in color)   # lighter centre, same opacity
    d.ellipse([c-size*0.20, c-size*0.55, c+size*0.20, c+size*0.0], fill=hi + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(max(1, size*0.02)))
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
    img.paste(layer, (int(cx - layer.width/2), int(cy - layer.height/2)), layer)

random.seed(7)
# petals drift across the left and right thirds; keep the wordmark area and the bottom-centre (avatar) clear
spots = [(0.05,0.55,46),(0.12,0.30,30),(0.20,0.72,38),(0.25,0.86,22),(0.09,0.85,28),(0.33,0.80,20),
         (0.95,0.50,44),(0.88,0.28,28),(0.80,0.70,36),(0.76,0.88,20),(0.92,0.86,26),(0.67,0.82,18),
         (0.17,0.10,22),(0.84,0.10,20),(0.40,0.12,14),(0.61,0.14,16)]
for fx, fy, sz in spots:
    shade = random.choice([(255, 183, 206), (255, 143, 182), (255, 210, 225)])
    petal(fx*W*S, fy*H*S, sz*S, random.uniform(-70, 70), shade, random.choice([150, 190, 230]))

img = img.resize((W, H), Image.LANCZOS)
d = ImageDraw.Draw(img)
font = ImageFont.truetype('/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf', 112)
small = ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-SemiBold.otf', 30)
a, b = 'Petal', 'Deck'
wa, wb = d.textlength(a, font=font), d.textlength(b, font=font)
x0 = (W - wa - wb) / 2
band_h = BAND[1] - BAND[0]
y = BAND[0] + band_h*0.20                   # wordmark sits in the upper-middle of the visible strip
d.text((x0, y), a, font=font, fill=(255, 155, 178))
d.text((x0 + wa, y), b, font=font, fill=(245, 246, 250))
tag = 'From chat to chart'
tw = d.textlength(tag, font=small)
d.text(((W - tw)/2, y + 140), tag, font=small, fill=(176, 180, 192))
img.save(f'{SP}/petaldeck-banner-v2.png', optimize=True)

# Preview: how Cherry's room header shows it (3:1 cover crop, back + settings buttons, round icon bottom-centre)
pw = 831
crop = img.crop((0, BAND[0], W, BAND[1])).resize((pw, pw//3), Image.LANCZOS)
prev = Image.new('RGB', (899, 520), (5, 6, 15))
mask = Image.new('L', crop.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, crop.width, crop.height], 32, fill=255)
prev.paste(crop, (34, 30), mask)
pd = ImageDraw.Draw(prev)
for cx in (95, 808):
    pd.ellipse([cx-40, 57, cx+40, 137], fill=(10, 12, 22), outline=(60, 64, 80), width=2)
icon = Image.open('/home/user/cherry-launch-room/public/brand/petaldeck-icon.png').convert('RGB').resize((160, 160), Image.LANCZOS)
m = Image.new('L', (160, 160), 0); ImageDraw.Draw(m).ellipse([0, 0, 159, 159], fill=255)
pd.ellipse([365, 220, 535, 390], fill=(5, 6, 15))
prev.paste(icon, (370, 225), m)
pd.text((450, 430), 'PetalDeck', font=ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-Bold.otf', 40), fill='white', anchor='mm')
prev.save(f'{SP}/banner-in-cherry-preview.png')
print('ok')
