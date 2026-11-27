import json
import os
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from typing import Optional, Tuple

ROOT = Path(os.environ.get("CLONE_DIR", Path(__file__).resolve().parents[2] / "data" / "clones"))
ACTIVE = ROOT / "aktiv"
WIDTH = 640
HEIGHT = 480
_OLD = (320, 240)


def view() -> dict:
    profile = load()
    if not profile:
        return {
            "ready": False,
            "name": "",
            "label": "Noch kein Klon",
            "live": {},
            "raw": {},
            "hints": [],
            "shifts": [],
        }
    motion = profile.get("shifts") or []
    hints = []
    if not motion:
        hints.append("Im Video war wenig Bewegung. Eine neue Aufnahme mit leichter Kopfbewegung wirkt lebendiger.")
    name = profile.get("name") or ""
    return {
        "ready": True,
        "name": name,
        "label": name or "Eigener Klon",
        "raw": {
            "movement": "" if motion else "keine auswertbare Bewegung im Video",
            "voiceClone": "keine Stimmkopie, nur Tonhöhe",
        },
        "live": {
            "face": "Foto als Bild im Gespräch",
            "voice": "Stimme folgt der Tonhöhe deiner Probe",
            "movement": "Leichte Bewegung aus dem Video" if motion else "",
        },
        "hints": hints,
        "pitch": profile.get("pitch", 50),
        "shifts": motion,
        "voiceSeconds": profile.get("voiceSeconds"),
        "videoSeconds": profile.get("videoSeconds"),
    }


def load() -> dict:
    path = ACTIVE / "profil.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def jpeg() -> bytes:
    found = blob("foto")
    if found and found[1].startswith("image/"):
        return found[0]
    raw = portrait()
    if not raw or not shutil.which("ffmpeg"):
        return b""
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
            "-s", f"{WIDTH}x{HEIGHT}", "-i", "pipe:0", "-frames:v", "1",
            "-q:v", "2", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
        ],
        input=raw,
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else b""


def blob(kind: str) -> Optional[Tuple[bytes, str]]:
    filename = {"foto": "foto", "stimme": "stimme", "video": "video"}.get(kind)
    if not filename:
        return None
    path = ACTIVE / filename
    if not path.is_file():
        return None
    data = path.read_bytes()
    fallback = {"foto": "image/jpeg", "stimme": "audio/webm", "video": "video/webm"}[kind]
    media = (load().get("types") or {}).get(kind) or fallback
    if media == "application/octet-stream":
        media = _sniff(data, fallback)
    elif kind == "foto" and not str(media).startswith("image/"):
        media = _sniff(data, fallback)
    return data, media


def portrait() -> bytes:
    path = ACTIVE / "portrait.rgba"
    if not path.is_file():
        return b""
    raw = path.read_bytes()
    if len(raw) == WIDTH * HEIGHT * 4:
        return raw
    old_w, old_h = _OLD
    if len(raw) == old_w * old_h * 4:
        return _nearest(raw, old_w, old_h, WIDTH, HEIGHT)
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


def check_parts(photo: bytes, voice: bytes, video: bytes) -> None:
    if not photo or not voice or not video:
        raise RuntimeError("Foto, Stimmprobe und Video werden gebraucht.")
    if max(len(photo), len(voice), len(video)) > 40_000_000:
        raise RuntimeError("Eine Datei ist größer als 40 MB.")
    if len(photo) < 8_000:
        raise RuntimeError("Das Foto ist zu klein.")
    if len(voice) < 4_000:
        raise RuntimeError("Die Stimmprobe ist zu kurz.")
    if len(video) < 8_000:
        raise RuntimeError("Das Video ist zu kurz.")


def save(photo: bytes, voice: bytes, video: bytes, name: str = "") -> dict:
    check_parts(photo, voice, video)
    folder = ROOT / "neu"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    try:
        (folder / "foto").write_bytes(photo)
        (folder / "stimme").write_bytes(voice)
        (folder / "video").write_bytes(video)
        try:
            _portrait(folder / "foto", folder / "portrait.rgba")
            wav = folder / "stimme.wav"
            _to_wav(folder / "stimme", wav)
        except subprocess.CalledProcessError as error:
            raise RuntimeError("Foto oder Ton ließ sich nicht verarbeiten.") from error
        if shutil.which("ffmpeg") and not (folder / "portrait.rgba").is_file():
            raise RuntimeError("Das Foto ließ sich nicht lesen. Bitte noch einmal aufnehmen.")
        found = _pitch(wav)
        motion = _shifts(folder / "video")
        voice_seconds = _seconds(wav if wav.is_file() else folder / "stimme")
        video_seconds = _seconds(folder / "video")
        if voice_seconds >= 0 and voice_seconds < 3:
            raise RuntimeError("Die Stimmprobe ist kürzer als 3 Sekunden.")
        if video_seconds >= 0 and video_seconds < 4:
            raise RuntimeError("Das Video ist kürzer als 4 Sekunden.")
        (folder / "profil.json").write_text(json.dumps({
            "name": _name(name),
            "pitch": found,
            "shifts": motion,
            "photoBytes": len(photo),
            "voiceBytes": len(voice),
            "videoBytes": len(video),
            "voiceSeconds": None if voice_seconds < 0 else round(voice_seconds, 2),
            "videoSeconds": None if video_seconds < 0 else round(video_seconds, 2),
            "types": {
                "foto": _sniff(photo, "image/jpeg"),
                "stimme": _sniff(voice, "audio/webm"),
                "video": _sniff(video, "video/webm"),
            },
        }))
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    if ACTIVE.exists():
        shutil.rmtree(ACTIVE)
    folder.rename(ACTIVE)
    return view()


def compose_portrait(photo: bytes, level: float = 0.0, shift=None) -> bytearray:
    dx, dy = 0, 0
    if shift:
        dx = int(shift[0]) * WIDTH // 320
        dy = int(shift[1]) * HEIGHT // 240
    buf = bytearray(b"\x14\x12\x10\xff" * (WIDTH * HEIGHT))
    if len(photo) != WIDTH * HEIGHT * 4:
        return buf
    _blit(buf, photo, dx, dy)
    open_px = int(round(max(0.0, min(float(level), 1.0)) * 14))
    if open_px:
        _jaw(buf, open_px)
    return buf


def _name(name: str) -> str:
    cleaned = "".join(ch for ch in name if ch >= " " and ch != "\x7f")
    return " ".join(cleaned.split())[:80]


def _sniff(data: bytes, fallback: str) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"\x1aE\xdf\xa3":
        return fallback if "webm" in fallback else "video/webm"
    if b"ftyp" in data[:16]:
        return "video/mp4"
    return fallback


def _run(command: list) -> None:
    subprocess.check_call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _portrait(source: Path, target: Path) -> None:
    if not shutil.which("ffmpeg"):
        return
    _run([
        "ffmpeg", "-y", "-i", str(source),
        "-vf", f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},unsharp=3:3:0.4",
        "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", str(target),
    ])


def _to_wav(source: Path, target: Path) -> None:
    if not shutil.which("ffmpeg"):
        if source.read_bytes()[:4] == b"RIFF":
            target.write_bytes(source.read_bytes())
        return
    _run(["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "16000", str(target)])


def _seconds(path: Path) -> float:
    if not path.is_file() or not shutil.which("ffprobe"):
        return -1
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        seconds = float(result.stdout.strip())
        if seconds > 0:
            return seconds
    except ValueError:
        pass
    # MediaRecorder schreibt WebM ohne abschließende Container-Dauer. Die
    # Zeitstempel der Pakete bleiben aber vollständig und sind verlässlicher
    # als Dateigröße oder Angaben aus dem Browser.
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_packets",
            "-show_entries", "packet=pts_time,dts_time,duration_time",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        packets = json.loads(result.stdout).get("packets") or []
    except (json.JSONDecodeError, AttributeError):
        return -1
    end = 0.0
    for packet in packets:
        try:
            start = float(packet.get("pts_time", packet.get("dts_time", 0)))
            duration = float(packet.get("duration_time", 0))
        except (TypeError, ValueError):
            continue
        end = max(end, start + duration)
    return end if end > 0 else -1


def _shifts(video: Path) -> list:
    if not shutil.which("ffmpeg"):
        return []
    raw = video.parent / "motion.raw"
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


def _blit(buf: bytearray, photo: bytes, dx: int, dy: int) -> None:
    for y in range(HEIGHT):
        source_y = y - dy
        if source_y < 0 or source_y >= HEIGHT:
            continue
        left = max(0, dx)
        right = min(WIDTH, WIDTH + dx)
        if left >= right:
            continue
        span = (right - left) * 4
        dest = (y * WIDTH + left) * 4
        src = (source_y * WIDTH + left - dx) * 4
        buf[dest:dest + span] = photo[src:src + span]


def _jaw(buf: bytearray, open_px: int) -> None:
    src = bytes(buf)
    mouth = int(HEIGHT * 0.62)
    chin = int(HEIGHT * 0.82)
    span = max(1, chin - mouth)
    for y in range(mouth, HEIGHT):
        if y < chin + open_px:
            rel = (y - mouth) / (span + open_px)
            source_y = mouth + int(rel * span)
        else:
            source_y = y - open_px
        if source_y < 0 or source_y >= HEIGHT:
            continue
        start = y * WIDTH * 4
        origin = source_y * WIDTH * 4
        buf[start:start + WIDTH * 4] = src[origin:origin + WIDTH * 4]


def _nearest(raw: bytes, sw: int, sh: int, dw: int, dh: int) -> bytes:
    out = bytearray(dw * dh * 4)
    for y in range(dh):
        sy = min(sh - 1, y * sh // dh)
        for x in range(dw):
            sx = min(sw - 1, x * sw // dw)
            src = (sy * sw + sx) * 4
            dest = (y * dw + x) * 4
            out[dest:dest + 4] = raw[src:src + 4]
    return bytes(out)
