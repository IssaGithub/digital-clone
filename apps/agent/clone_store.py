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
        "live": {
            "face": "Foto als Videobild im Raum",
            "voice": "lokales TTS mit der Tonhöhe der Stimmprobe",
        },
        "raw": {
            "movement": "Videodatei gespeichert, Bewegung wird nicht auf das Gesicht übertragen",
            "voiceClone": "keine Stimmkopie, nur Tonhöhe",
        },
        "pitch": profile.get("pitch", 50),
    }


def load() -> dict:
    path = ACTIVE / "profil.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def portrait() -> bytes:
    path = ACTIVE / "portrait.rgba"
    if path.is_file() and path.stat().st_size == 320 * 240 * 4:
        return path.read_bytes()
    return b""


def pitch() -> int:
    value = int(load().get("pitch", 50))
    return max(0, min(99, value))


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
    (ACTIVE / "profil.json").write_text(json.dumps({
        "pitch": found,
        "photoBytes": len(photo),
        "voiceBytes": len(voice),
        "videoBytes": len(video),
        "live": ["foto", "tonhoehe"],
        "raw": ["bewegung", "stimmkopie"],
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
