import asyncio
import os
from typing import Optional
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse
from livekit import api, rtc

import avatar
import clone_store
import oauth

oauth.load_env_files()

DISCLOSURE = "Hinweis: In diesem Gespräch spricht ein digitaler Klon und keine natürliche Person."
ROOM = os.environ.get("LIVEKIT_ROOM", "klon")
URL = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
PUBLIC_URL = os.environ.get("LIVEKIT_PUBLIC_URL", URL)
API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
SPEECH_KEY = os.environ.get("OPENAI_API_KEY", "")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CALL_ORIGIN", "http://127.0.0.1:4200"), "http://168.119.242.47"],
    allow_methods=["*"],
    allow_headers=["*"],
)


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:0.5b")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "tiny")
TTS_ENGINE = os.environ.get("TTS_ENGINE", "espeak-ng")
_whisper = None


def local_mode() -> bool:
    return os.environ.get("SPEECH_LOCAL") == "1"


def ollama_ready() -> bool:
    try:
        response = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2)
        names = [item.get("name", "") for item in response.json().get("models", [])]
    except Exception:
        return False
    return any(name == OLLAMA_MODEL or name.startswith(OLLAMA_MODEL.split(":")[0] + ":") for name in names)


def local_tools_ready() -> bool:
    return bool(shutil.which("espeak-ng")) and ollama_ready()


def speech_status():
    if not local_mode():
        return oauth.speech_view()
    ready = local_tools_ready()
    return {
        "provider": "local",
        "label": "Lokale Sprache",
        "purpose": "STT und TTS",
        "connected": ready,
        "detail": "verbunden" if ready else "lokales Modell nicht bereit",
        "login": None,
        "loginHint": "",
        "llm": OLLAMA_MODEL,
        "stt": f"whisper-{WHISPER_MODEL}",
        "tts": TTS_ENGINE,
    }


@app.get("/openai/login")
def openai_login():
    if oauth.loopback_only():
        return PlainTextResponse(oauth.speech_view()["loginHint"], status_code=200)
    return RedirectResponse(oauth.login_url())


@app.get("/auth/callback")
def auth_callback(code: str = "", state: str = "", client_id: str = "", error: str = ""):
    target = os.environ.get("CALL_ORIGIN", "http://127.0.0.1:4200")
    if error or not code or not state:
        return RedirectResponse(target + "?openai=fehler")
    granted = oauth.exchange_code(state, code, client_id)
    access = granted.get("access_token") or ""
    api_key = granted.get("api_key") or granted.get("openai_api_key") or ""
    info = oauth.identity(access) if access else {}
    oauth.save_grant(
        api_key or access,
        granted.get("refresh_token") or "",
        int(granted.get("expires_in") or 3600),
        str(info.get("email") or ""),
        str(info.get("name") or ""),
        str(info.get("sub") or "openai"),
    )
    return RedirectResponse(target + "?openai=angemeldet")


def token_for(identity: str) -> str:
    grant = api.VideoGrants(room_join=True, room=ROOM, can_publish=True, can_subscribe=True)
    return api.AccessToken(API_KEY, API_SECRET).with_identity(identity).with_grants(grant).to_jwt()


@app.get("/health")
def health():
    body = {"ok": True, "service": "agent", "room": ROOM}
    if local_mode():
        speech = speech_status()
        body["ok"] = bool(speech["connected"])
        body["llm"] = OLLAMA_MODEL
        body["stt"] = f"whisper-{WHISPER_MODEL}"
        body["tts"] = TTS_ENGINE
    return body


@app.get("/anschluesse")
def anschluesse():
    return {"speech": speech_status(), "clone": clone_store.view(), "livekit": PUBLIC_URL, "room": ROOM}


@app.post("/token")
def token():
    return {
        "url": PUBLIC_URL,
        "room": ROOM,
        "token": token_for("kunde"),
        "speech": speech_status(),
        "clone": clone_store.view(),
    }


@app.post("/klon")
async def create_clone(
    photo: UploadFile = File(...),
    voice: UploadFile = File(...),
    video: UploadFile = File(...),
):
    try:
        return await asyncio.to_thread(
            clone_store.save, await photo.read(), await voice.read(), await video.read()
        )
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def audio_bearer() -> str:
    token, _source = oauth.bearer()
    return token


def complete(prompt: str) -> str:
    response = httpx.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
        timeout=120,
    )
    response.raise_for_status()
    return str(response.json().get("response") or "").strip()


def whisper_model():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _whisper


def transcribe_local(wav: bytes) -> str:
    folder = Path(tempfile.mkdtemp())
    target = folder / "audio.wav"
    target.write_bytes(wav)
    segments, _info = whisper_model().transcribe(str(target), language="de")
    text = " ".join(segment.text.strip() for segment in segments).strip()
    shutil.rmtree(folder, ignore_errors=True)
    return text


def transcribe(wav: bytes) -> str:
    if not wav:
        return ""
    if local_mode():
        return transcribe_local(wav)
    speech_key = audio_bearer()
    if not speech_key:
        return ""
    response = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {speech_key}"},
        files={"file": ("audio.wav", wav, "audio/wav")},
        data={"model": "whisper-1"},
        timeout=30,
    )
    response.raise_for_status()
    return str(response.json().get("text") or "")


def synthesize(text: str) -> bytes:
    if local_mode() and shutil.which("espeak-ng"):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "hinweis.wav"
            subprocess.check_call([
                "espeak-ng", "-v", "de", "-s", "140", "-p", str(clone_store.pitch()),
                "-w", str(target), text,
            ])
            return target.read_bytes()
    speech_key = audio_bearer()
    if speech_key:
        response = httpx.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {speech_key}"},
            json={"model": "tts-1", "voice": "alloy", "input": text, "response_format": "wav"},
            timeout=30,
        )
        response.raise_for_status()
        return response.content
    with tempfile.TemporaryDirectory() as folder:
        target = Path(folder) / "hinweis.wav"
        if shutil.which("say"):
            subprocess.check_call(["say", "-o", str(target), "--data-format=LEI16@48000", text])
        elif shutil.which("espeak-ng"):
            subprocess.check_call([
                "espeak-ng", "-v", "de", "-s", "140", "-p", str(clone_store.pitch()),
                "-w", str(target), text,
            ])
        else:
            return silence()
        return target.read_bytes()


def silence() -> bytes:
    path = Path(tempfile.mkstemp(suffix=".wav")[1])
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(b"\x00\x00" * 48000)
    data = path.read_bytes()
    path.unlink(missing_ok=True)
    return data


avatar_source: Optional[rtc.VideoSource] = None


async def ensure_avatar(room: rtc.Room):
    global avatar_source
    if avatar_source is not None:
        return
    source = rtc.VideoSource(avatar.WIDTH, avatar.HEIGHT)
    track = rtc.LocalVideoTrack.create_video_track("avatar", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA)
    )
    source.capture_frame(avatar.face_frame(0))
    avatar_source = source
    print("Klon-Gesicht im Raum")


async def play(source: rtc.AudioSource, wav: bytes):
    raw = tempfile.SpooledTemporaryFile()
    raw.write(wav)
    raw.seek(0)
    with wave.open(raw, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        pcm = handle.readframes(handle.getnframes())
    width = 2 * channels
    chunk = max(width, rate // 50 * width)
    for start in range(0, len(pcm), chunk):
        piece = pcm[start : start + chunk]
        samples = len(piece) // width
        if samples == 0:
            continue
        frame = rtc.AudioFrame(piece, rate, channels, samples)
        await source.capture_frame(frame)
        if avatar_source is not None:
            avatar_source.capture_frame(avatar.face_frame(avatar.level_from_pcm(piece)))
        await asyncio.sleep(samples / rate)
    if avatar_source is not None:
        avatar_source.capture_frame(avatar.face_frame(0))


async def agent_loop():
    spoken: set[str] = set()
    warmed = False
    room = rtc.Room()

    @room.on("participant_connected")
    def on_join(participant: rtc.RemoteParticipant):
        if participant.identity in spoken or participant.identity == "klon":
            return
        spoken.add(participant.identity)
        asyncio.create_task(speak(room))

    while True:
        try:
            await room.connect(URL, token_for("klon"))
            print(f"Agent im Raum {ROOM}")
            await ensure_avatar(room)
            if local_mode() and not warmed:
                warmed = True
                asyncio.create_task(asyncio.to_thread(
                    complete,
                    "Antworte nur mit OK. Der gesprochene Hinweis bleibt der vorgegebene Klon-Hinweis.",
                ))
            while room.connection_state == rtc.ConnectionState.CONN_CONNECTED:
                await asyncio.sleep(1)
        except Exception as error:
            print(f"LiveKit noch nicht bereit: {error}")
        await asyncio.sleep(2)


async def speak(room: rtc.Room):
    wav = await asyncio.to_thread(synthesize, DISCLOSURE)
    raw = tempfile.SpooledTemporaryFile()
    raw.write(wav)
    raw.seek(0)
    with wave.open(raw, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
    source = rtc.AudioSource(rate, channels)
    track = rtc.LocalAudioTrack.create_audio_track("hinweis", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    await play(source, wav)
    await room.local_participant.publish_data(DISCLOSURE.encode(), reliable=True, topic="hinweis")


async def amain():
    asyncio.create_task(agent_loop())
    config = uvicorn.Config(app, host="0.0.0.0", port=int(os.environ.get("AGENT_PORT", "4010")))
    await uvicorn.Server(config).serve()


def main():
    asyncio.run(amain())


if __name__ == "__main__":
    main()
