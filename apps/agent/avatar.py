import struct

import clone_store
from livekit import rtc

WIDTH = clone_store.WIDTH
HEIGHT = clone_store.HEIGHT


def face_frame(level: float, shift=None) -> rtc.VideoFrame:
    buf = clone_store.compose_portrait(clone_store.portrait(), level, shift)
    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, buf)


def level_from_pcm(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    count = len(pcm) // 2
    samples = struct.unpack("<" + "h" * count, pcm[: count * 2])
    energy = sum(abs(sample) for sample in samples) / count / 32768
    return min(energy * 4, 1.0)
