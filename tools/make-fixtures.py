"""生成 e2e 测试素材：一张参考图 + 一段 2 秒音频 + 一段 35 秒音频（用于验证时长上限）。
运行：python tools/make-fixtures.py
"""
import os
import struct
import wave

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tmp-fixtures")


def make_png(path, size=(320, 320)):
    img = Image.new("RGB", size, (255, 154, 61))
    d = ImageDraw.Draw(img)
    d.ellipse([60, 60, size[0] - 60, size[1] - 60], fill=(30, 20, 10))
    img.save(path, "PNG")


def make_wav(path, seconds, rate=8000):
    """生成一段 440Hz 正弦波 WAV，时长精确可控。"""
    n = int(rate * seconds)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(n):
            frames += struct.pack("<h", int(12000 * ((i % 20) / 10.0 - 1)))
        w.writeframes(bytes(frames))


def main():
    os.makedirs(OUT, exist_ok=True)
    make_png(os.path.join(OUT, "ref.png"))
    make_wav(os.path.join(OUT, "short.wav"), 2)
    make_wav(os.path.join(OUT, "long.wav"), 35)
    for f in ("ref.png", "short.wav", "long.wav"):
        p = os.path.join(OUT, f)
        print(f"{f}: {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()
