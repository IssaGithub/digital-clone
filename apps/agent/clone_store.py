import json
import os
import shutil
import struct
import subprocess
import wave
from pathlib import Path

ROOT = Path(os.environ.get("CLONE_DIR", Path(__file__).resolve().parents[2] / "data" / "clones"))
ACTIVE = ROOT / "aktiv"


def view() -> dict:
    profile = load()
    if not profile:
        return {
            "ready": False,
            "label": "Noch kein Klon",
            "live": {},
            "raw": {},
        }
    return {
        "ready": True,
        "label": "Eigener Klon",
        "raw": {
            "movement": "keine auswertbare Bewegung im Video" if not profile.get("shifts") else "",
            "voiceClone": "keine Stimmkopie, nur Tonhöhe",
        },
        "live": {
            "face": "Foto als Videobild im Raum",
            "voice": "lokales TTS mit der Tonhöhe der Stimmprobe",
            "movement": "Gesicht verschiebt sich mit dem Video" if profile.get("shifts") else "",
        },
        "pitch": profile.get("pitch", 50),
        "shifts": profile.get("shifts") or [],
    }


def load() -> dict:
    path = ACTIVE / "profil.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def jpeg() -> bytes:
    raw = portrait()
    if not raw or not shutil.which("ffmpeg"):
        return b""
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
            "-s", "320x240", "-i", "pipe:0", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
        ],
        input=raw,
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else b""


def portrait() -> bytes:
    path = ACTIVE / "portrait.rgba"
    if path.is_file() and path.stat().st_size == 320 * 240 * 4:
        return path.read_bytes()
    return b""


def pitch() -> int:
    value = int(load().get("pitch", 50))
    return max(0, min(99, value))


def shifts() -> list:
    refresh()
    return load().get("shifts") or []


def refresh() -> None:
    profile = load()
    video = ACTIVE / "video"
    if not profile or profile.get("shifts") or not video.is_file():
        return
    profile["shifts"] = _shifts(video)
    (ACTIVE / "profil.json").write_text(json.dumps(profile))


def save(photo: bytes, voice: bytes, video: bytes) -> dict:
    if not photo or not voice or not video:
        raise RuntimeError("Video, Stimmprobe und Foto werden gebraucht")
    if max(len(photo), len(voice), len(video)) > 40_000_000:
        raise RuntimeError("Datei ist größer als 40 MB")
    if ACTIVE.exists():
        shutil.rmtree(ACTIVE)
    ACTIVE.mkdir(parents=True)
    (ACTIVE / "foto").write_bytes(photo)
    (ACTIVE / "stimme").write_bytes(voice)
    (ACTIVE / "video").write_bytes(video)
    _portrait(ACTIVE / "foto", ACTIVE / "portrait.rgba")
    wav = ACTIVE / "stimme.wav"
    _to_wav(ACTIVE / "stimme", wav)
    found = _pitch(wav)
    motion = _shifts(ACTIVE / "video")
    (ACTIVE / "profil.json").write_text(json.dumps({
        "pitch": found,
        "shifts": motion,
        "photoBytes": len(photo),
        "voiceBytes": len(voice),
        "videoBytes": len(video),
    }))
    return view()


def _run(command: list) -> None:
    subprocess.check_call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _portrait(source: Path, target: Path) -> None:
    if not shutil.which("ffmpeg"):
        return
    _run([
        "ffmpeg", "-y", "-i", str(source),
        "-vf", "scale=320:240:force_original_aspect_ratio=increase,crop=320:240",
        "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", str(target),
    ])


def _to_wav(source: Path, target: Path) -> None:
    if not shutil.which("ffmpeg"):
        if source.read_bytes()[:4] == b"RIFF":
            target.write_bytes(source.read_bytes())
        return
    _run(["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "16000", str(target)])


def _shifts(video: Path) -> list:
    if not shutil.which("ffmpeg"):
        return []
    raw = ACTIVE / "motion.raw"
    try:
        _run([
            "ffmpeg", "-y", "-i", str(video),
            "-vf", "fps=8,scale=32:24", "-frames:v", "64",
            "-pix_fmt", "gray", "-f", "rawvideo", str(raw),
        ])
    except subprocess.CalledProcessError:
        return []
    data = raw.read_bytes()
    raw.unlink(missing_ok=True)
    size = 32 * 24
    count = len(data) // size
    if count < 2:
        return []
    frames = [data[i * size:(i + 1) * size] for i in range(count)]
    points = []
    for previous, current in zip(frames, frames[1:]):
        mass = 0
        sx = 0
        sy = 0
        for index, (left, right) in enumerate(zip(previous, current)):
            delta = abs(left - right)
            if delta < 18:
                continue
            mass += delta
            sx += delta * (index % 32)
            sy += delta * (index // 32)
        if mass < 200:
            points.append([0, 0])
            continue
        points.append([
            max(-16, min(16, int((sx / mass - 16) / 2))),
            max(-12, min(12, int((sy / mass - 12) / 2))),
        ])
    if not any(point != [0, 0] for point in points):
        return []
    return points


def _pitch(wav_path: Path) -> int:
    if not wav_path.is_file():
        return 50
    with wave.open(str(wav_path), "rb") as handle:
        rate = handle.getframerate()
        frames = handle.readframes(min(handle.getnframes(), rate))
        width = handle.getsampwidth()
    if width != 2 or rate < 8000 or len(frames) < rate:
        return 50
    count = len(frames) // 2
    samples = struct.unpack("<" + "h" * count, frames[: count * 2])
    low, high = int(rate / 250), int(rate / 80)
    best_lag, best = low, 0
    for lag in range(low, min(high, count // 2)):
        score = sum(samples[i] * samples[i + lag] for i in range(0, count - lag, 8))
        if score > best:
            best, best_lag = score, lag
    if best <= 0:
        return 50
    hz = rate / best_lag
    return max(0, min(99, int((hz - 80) / 170 * 99)))
