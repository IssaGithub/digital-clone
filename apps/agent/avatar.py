import struct
from typing import Tuple

import clone_store
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


def face_frame(level: float, shift=None) -> rtc.VideoFrame:
    photo = clone_store.portrait()
    dx, dy = (shift or [0, 0])[:2]
    buf = bytearray(b"\x1c\x19\x15\xff" * (WIDTH * HEIGHT))
    if photo:
        for y in range(HEIGHT):
            source_y = y - int(dy)
            if source_y < 0 or source_y >= HEIGHT:
                continue
            left = max(0, int(dx))
            right = min(WIDTH, WIDTH + int(dx))
            if left >= right:
                continue
            dest = (y * WIDTH + left) * 4
            src = (source_y * WIDTH + left - int(dx)) * 4
            buf[dest:dest + (right - left) * 4] = photo[src:src + (right - left) * 4]
        open_px = 2 + int(max(0.0, min(level, 1.0)) * 10)
        _disc(buf, 160 + int(dx), 176 + int(dy), 14, open_px, (90, 36, 40))
    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, buf)


def level_from_pcm(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    count = len(pcm) // 2
    samples = struct.unpack("<" + "h" * count, pcm[: count * 2])
    energy = sum(abs(sample) for sample in samples) / count / 32768
    return min(energy * 4, 1.0)
