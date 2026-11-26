import asyncio
import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse
from livekit import api, rtc

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


def speech_status():
    return oauth.speech_view()


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
    return {"ok": True, "service": "agent", "room": ROOM}


@app.get("/anschluesse")
def anschluesse():
    return {"speech": speech_status(), "livekit": PUBLIC_URL, "room": ROOM}


@app.post("/token")
def token():
    return {"url": PUBLIC_URL, "room": ROOM, "token": token_for("kunde"), "speech": speech_status()}


def audio_bearer() -> str:
    token, _source = oauth.bearer()
    return token


def transcribe(wav: bytes) -> str:
    speech_key = audio_bearer()
    if not speech_key or not wav:
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
            subprocess.check_call(["espeak-ng", "-v", "de", "-s", "140", "-w", str(target), text])
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
        await asyncio.sleep(samples / rate)


async def agent_loop():
    spoken: set[str] = set()
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
            while room.connection_state == rtc.ConnectionState.CONN_CONNECTED:
                await asyncio.sleep(1)
        except Exception as error:
            print(f"LiveKit noch nicht bereit: {error}")
        await asyncio.sleep(2)


async def speak(room: rtc.Room):
    source = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("hinweis", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    await play(source, synthesize(DISCLOSURE))
    await room.local_participant.publish_data(DISCLOSURE.encode(), reliable=True, topic="hinweis")


async def amain():
    asyncio.create_task(agent_loop())
    config = uvicorn.Config(app, host="0.0.0.0", port=int(os.environ.get("AGENT_PORT", "4010")))
    await uvicorn.Server(config).serve()


def main():
    asyncio.run(amain())


if __name__ == "__main__":
    main()
