import struct
from typing import Tuple

from livekit import rtc

WIDTH = 320
HEIGHT = 240


def _put(buf: bytearray, x: int, y: int, color: Tuple[int, int, int]) -> None:
    if x < 0 or y < 0 or x >= WIDTH or y >= HEIGHT:
        return
    index = (y * WIDTH + x) * 4
    buf[index : index + 3] = bytes(color)


def _fill(buf: bytearray, color: Tuple[int, int, int]) -> None:
    pixel = bytes(color) + b"\xff"
    buf[:] = pixel * (WIDTH * HEIGHT)


def _disc(buf: bytearray, cx: int, cy: int, rx: int, ry: int, color: Tuple[int, int, int]) -> None:
    for y in range(cy - ry, cy + ry + 1):
        for x in range(cx - rx, cx + rx + 1):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                _put(buf, x, y, color)


def face_frame(level: float) -> rtc.VideoFrame:
    buf = bytearray(WIDTH * HEIGHT * 4)
    _fill(buf, (28, 25, 21))
    _disc(buf, 160, 118, 78, 96, (214, 176, 148))
    _disc(buf, 128, 108, 10, 6, (40, 32, 28))
    _disc(buf, 192, 108, 10, 6, (40, 32, 28))
    open_px = 3 + int(max(0.0, min(level, 1.0)) * 28)
    _disc(buf, 160, 168, 22, open_px, (120, 48, 52))
    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, buf)


def level_from_pcm(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    count = len(pcm) // 2
    samples = struct.unpack("<" + "h" * count, pcm[: count * 2])
    energy = sum(abs(sample) for sample in samples) / count / 32768
    return min(energy * 4, 1.0)
