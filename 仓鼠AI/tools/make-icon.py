"""生成「仓鼠AI」应用图标 build/icon.ico（暖橙圆角方块 + 仓字）。
运行：python tools/make-icon.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG_FROM = (255, 178, 94)   # --accent-2
BG_TO = (242, 113, 28)     # 渐变终点
FG = (36, 19, 7)           # logo 字色
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"  # 微软雅黑 Bold
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
OUT = os.path.join(OUT_DIR, "icon.ico")


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def gradient(size, c1, c2):
    """斜向线性渐变。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = (
                round(c1[0] + (c2[0] - c1[0]) * t),
                round(c1[1] + (c2[1] - c1[1]) * t),
                round(c1[2] + (c2[2] - c1[2]) * t),
            )
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base.paste(gradient(SIZE, BG_FROM, BG_TO), (0, 0), rounded_mask(SIZE, int(SIZE * 0.22)))

    draw = ImageDraw.Draw(base)
    font = ImageFont.truetype(FONT_PATH, int(SIZE * 0.62))
    box = draw.textbbox((0, 0), "仓", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1]), "仓", font=font, fill=FG)

    sizes = [256, 128, 64, 48, 32, 16]
    base.save(OUT, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"wrote {OUT}  ({os.path.getsize(OUT)} bytes, sizes={sizes})")


if __name__ == "__main__":
    main()
