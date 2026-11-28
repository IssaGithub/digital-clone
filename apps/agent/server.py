import asyncio
import importlib.util
import os
from typing import Optional
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse, Response
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
    allow_origins=[
        os.environ.get("CALL_ORIGIN", "http://127.0.0.1:4200").split("/klon")[0],
        "http://127.0.0.1:4200",
        "http://168.119.242.47",
        "https://168.119.242.47",
    ],
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
    return bool(shutil.which("espeak-ng")) and importlib.util.find_spec("faster_whisper") is not None


def speech_status():
    if not local_mode():
        return oauth.speech_view()
    ready = local_tools_ready()
    return {
        "provider": "local",
        "label": "Lokale Sprache",
        "purpose": "STT und TTS",
        "connected": ready,
        "detail": "verbunden" if ready else "lokale Spracherkennung oder Sprachausgabe nicht bereit",
        "login": None,
        "loginHint": "",
        "llm": OLLAMA_MODEL if ollama_ready() else "regelbasierte lokale Antwort",
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
        body["llm"] = speech["llm"]
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


def _clone_file(kind: str):
    found = clone_store.blob(kind)
    if found:
        data, media = found
        return Response(data, media_type=media, headers={"Cache-Control": "no-store"})
    if kind == "foto":
        image = clone_store.jpeg()
        if image:
            return Response(image, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
    raise HTTPException(status_code=404, detail="noch keine Aufnahme")


@app.get("/klon/bild")
def klon_bild():
    return _clone_file("foto")


@app.get("/klon/foto")
def klon_foto():
    return _clone_file("foto")


@app.get("/klon/stimme")
def klon_stimme():
    return _clone_file("stimme")


@app.get("/klon/video")
def klon_video():
    return _clone_file("video")


@app.get("/klon/ansage")
def klon_ansage():
    return Response(synthesize(DISCLOSURE), media_type="audio/wav")


@app.post("/klon")
async def create_clone(
    photo: UploadFile = File(...),
    voice: UploadFile = File(...),
    video: UploadFile = File(...),
    name: str = Form(""),
):
    try:
        return await asyncio.to_thread(
            clone_store.save,
            await photo.read(),
            await voice.read(),
            await video.read(),
            name,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def audio_bearer() -> str:
    token, _source = oauth.bearer()
    return token


def complete(prompt: str) -> str:
    if not ollama_ready():
        return ""
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
    import numpy

    with tempfile.SpooledTemporaryFile() as raw:
        raw.write(wav)
        raw.seek(0)
        with wave.open(raw, "rb") as handle:
            if (
                handle.getnchannels() != 1
                or handle.getsampwidth() != 2
                or handle.getframerate() != 16000
            ):
                raise RuntimeError("Lokales STT erwartet WAV mit 16 kHz, mono und 16 Bit")
            pcm = handle.readframes(handle.getnframes())
    audio = numpy.frombuffer(pcm, dtype="<i2").astype(numpy.float32) / 32768.0
    segments, _info = whisper_model().transcribe(audio, language="de")
    text = " ".join(segment.text.strip() for segment in segments).strip()
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


def answer(text: str) -> str:
    if ollama_ready():
        prompt = (
            "Du bist ein freundlicher digitaler Klon in einem Live-Gespräch. "
            "Antworte auf Deutsch, knapp und natürlich in höchstens drei Sätzen.\n\n"
            f"Nutzer: {text}\nKlon:"
        )
        generated = complete(prompt)
        if generated:
            return generated
    lowered = text.casefold()
    if any(word in lowered for word in ("hallo", "guten morgen", "guten tag", "guten abend")):
        return "Hallo! Schön, dass du da bist. Wie kann ich dir helfen?"
    if "wie geht" in lowered:
        return "Danke, mir geht es gut. Wie kann ich dich heute unterstützen?"
    return "Danke, ich habe dich verstanden. Erzähl mir bitte noch etwas mehr dazu."


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
    asyncio.create_task(keep_face_alive())
    print("Klon-Gesicht im Raum")


speaking = False
conversation_lock = asyncio.Lock()


async def keep_face_alive():
    while avatar_source is not None:
        if not speaking:
            first = (clone_store.shifts() or [[0, 0]])[0]
            avatar_source.capture_frame(avatar.face_frame(0, first))
        await asyncio.sleep(1)


async def play(source: rtc.AudioSource, wav: bytes):
    with tempfile.SpooledTemporaryFile() as raw:
        raw.write(wav)
        raw.seek(0)
        with wave.open(raw, "rb") as handle:
            rate = handle.getframerate()
            channels = handle.getnchannels()
            pcm = handle.readframes(handle.getnframes())
    width = 2 * channels
    chunk = max(width, rate // 50 * width)
    global speaking
    speaking = True
    try:
        motion = clone_store.shifts()
        shown = -1
        for start in range(0, len(pcm), chunk):
            piece = pcm[start : start + chunk]
            samples = len(piece) // width
            if samples == 0:
                continue
            frame = rtc.AudioFrame(piece, rate, channels, samples)
            await source.capture_frame(frame)
            if avatar_source is not None and motion:
                index = min(len(motion) - 1, int((start / max(len(pcm), 1)) * len(motion)))
                if index != shown:
                    avatar_source.capture_frame(avatar.face_frame(avatar.level_from_pcm(piece), motion[index]))
                    shown = index
            elif avatar_source is not None and shown < 0:
                avatar_source.capture_frame(avatar.face_frame(avatar.level_from_pcm(piece)))
                shown = 0
            await asyncio.sleep(samples / rate)
    finally:
        speaking = False
        if avatar_source is not None:
            avatar_source.capture_frame(avatar.face_frame(0))


def pcm_wav(pcm: bytes, rate: int = 16000) -> bytes:
    with tempfile.SpooledTemporaryFile() as raw:
        with wave.open(raw, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(pcm)
        raw.seek(0)
        return raw.read()


def pcm_level(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    samples = memoryview(pcm).cast("h")
    return sum(abs(sample) for sample in samples) / len(samples) / 32768


async def say(room: rtc.Room, text: str, topic: str = "antwort"):
    wav = await asyncio.to_thread(synthesize, text)
    with tempfile.SpooledTemporaryFile() as raw:
        raw.write(wav)
        raw.seek(0)
        with wave.open(raw, "rb") as handle:
            rate = handle.getframerate()
            channels = handle.getnchannels()
    source = rtc.AudioSource(rate, channels)
    track = rtc.LocalAudioTrack.create_audio_track(topic, source)
    publication = await room.local_participant.publish_track(
        track,
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
    )
    try:
        await play(source, wav)
        await room.local_participant.publish_data(text.encode(), reliable=True, topic=topic)
    finally:
        await room.local_participant.unpublish_track(publication.sid)


async def handle_utterance(room: rtc.Room, wav: bytes):
    if conversation_lock.locked():
        return
    async with conversation_lock:
        await room.local_participant.publish_data(
            "Ich höre zu …".encode(), reliable=True, topic="status"
        )
        try:
            text = await asyncio.to_thread(transcribe, wav)
        except Exception as error:
            print(f"Spracherkennung fehlgeschlagen: {error}")
            await room.local_participant.publish_data(
                "Die Spracherkennung ist fehlgeschlagen.".encode(),
                reliable=True,
                topic="status",
            )
            return
        if not text:
            await room.local_participant.publish_data(
                "Ich habe nichts verstanden. Bitte sprich noch einmal.".encode(),
                reliable=True,
                topic="status",
            )
            return
        await room.local_participant.publish_data(
            f"Du: {text}".encode(), reliable=True, topic="transkript"
        )
        response = await asyncio.to_thread(answer, text)
        await say(room, response)


async def listen_to_track(room: rtc.Room, track: rtc.Track, identity: str):
    print(f"Höre auf Mikrofon von {identity}")
    stream = rtc.AudioStream(
        track=track,
        sample_rate=16000,
        num_channels=1,
        frame_size_ms=20,
        capacity=200,
    )
    pre_roll: list[bytes] = []
    utterance: list[bytes] = []
    active = False
    speech_ms = 0.0
    silence_ms = 0.0
    async for event in stream:
        frame = event.frame
        pcm = bytes(frame.data)
        frame_ms = frame.samples_per_channel / max(frame.sample_rate, 1) * 1000
        if speaking:
            active = False
            utterance.clear()
            pre_roll.clear()
            speech_ms = 0.0
            silence_ms = 0.0
            continue
        loud = pcm_level(pcm) >= 0.012
        started = False
        if not active:
            pre_roll.append(pcm)
            pre_roll = pre_roll[-10:]
            if not loud:
                continue
            active = True
            utterance.extend(pre_roll)
            pre_roll.clear()
            started = True
        if not started:
            utterance.append(pcm)
        if loud:
            speech_ms += frame_ms
            silence_ms = 0.0
        else:
            silence_ms += frame_ms
        utterance_ms = sum(len(piece) for piece in utterance) / 2 / 16000 * 1000
        if (silence_ms >= 900 and speech_ms >= 350) or utterance_ms >= 15000:
            audio = pcm_wav(b"".join(utterance))
            asyncio.create_task(handle_utterance(room, audio))
            active = False
            utterance.clear()
            speech_ms = 0.0
            silence_ms = 0.0


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

    @room.on("track_subscribed")
    def on_track(track, _publication, participant):
        if participant.identity == "klon" or track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        asyncio.create_task(listen_to_track(room, track, participant.identity))

    while True:
        try:
            await room.connect(URL, token_for("klon"))
            print(f"Agent im Raum {ROOM}")
            await ensure_avatar(room)
            for participant in list(room.remote_participants.values()):
                on_join(participant)
            if local_mode() and not warmed:
                warmed = True
                asyncio.create_task(asyncio.to_thread(whisper_model))
            while room.connection_state == rtc.ConnectionState.CONN_CONNECTED:
                await asyncio.sleep(1)
        except Exception as error:
            print(f"LiveKit noch nicht bereit: {error}")
        await asyncio.sleep(2)


async def speak(room: rtc.Room):
    await ensure_avatar(room)
    if avatar_source is not None:
        avatar_source.capture_frame(avatar.face_frame(0, (clone_store.shifts() or [[0, 0]])[0]))
    async with conversation_lock:
        await say(room, DISCLOSURE, "hinweis")


async def amain():
    asyncio.create_task(agent_loop())
    config = uvicorn.Config(app, host="0.0.0.0", port=int(os.environ.get("AGENT_PORT", "4010")))
    await uvicorn.Server(config).serve()


def main():
    asyncio.run(amain())


if __name__ == "__main__":
    main()
