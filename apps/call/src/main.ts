import "zone.js";
import { Component, signal } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { Room, RoomEvent, Track } from "livekit-client";

type Speech = {
  label: string;
  purpose: string;
  connected: boolean;
  detail: string;
  login?: string | null;
  loginHint?: string;
};
type CloneProfile = {
  ready: boolean;
  label: string;
  live: { face?: string; voice?: string; movement?: string };
  raw: { movement?: string; voiceClone?: string };
};
type TokenResponse = { url: string; token: string; speech: Speech; clone: CloneProfile };

@Component({
  selector: "app-call",
  template: `
    <main>
      <h1>Videocall</h1>
      <p>LiveKit-Raum: klon</p>
      <p>Der Klon tritt über LiveKit bei und spricht zuerst den Hinweis, dass ein digitaler Klon spricht.</p>
      <section class="card">
        <strong>{{ speech()?.label || "OpenAI Sprache" }}</strong>
        <p [class.warn]="!speech()?.connected">
          {{ speech()?.purpose || "STT und TTS" }}: {{ speech()?.detail || "fehlender Anschluss" }}
        </p>
        @if (loginHref) {
          <a [href]="loginHref">Mit OpenAI anmelden</a>
        }
        @if (speech()?.loginHint) {
          <p>{{ speech()?.loginHint }}</p>
        }
      </section>
      <section class="card">
        <strong>{{ cloneProfile()?.label || "Noch kein Klon" }}</strong>
        @if (cloneProfile()?.ready) {
          <p>Live: {{ cloneProfile()?.live?.face }}. {{ cloneProfile()?.live?.voice }}. {{ cloneProfile()?.live?.movement }}</p>
          <p class="warn">Roh: {{ cloneProfile()?.raw?.voiceClone }} {{ cloneProfile()?.raw?.movement }}</p>
        }
        <video class="preview" autoplay muted playsinline></video>
        <button type="button" (click)="takePhoto()" [disabled]="uploading()">Foto machen</button>
        <button type="button" (click)="recordVoice()" [disabled]="uploading()">Stimme aufnehmen</button>
        <button type="button" (click)="recordVideo()" [disabled]="uploading()">Video aufnehmen</button>
        <button type="button" (click)="saveClone()" [disabled]="uploading() || !photoBlob || !voiceBlob || !videoBlob">Klon anlegen</button>
        <p>{{ uploadStatus() }}</p>
      </section>
      <button type="button" (click)="join()" [disabled]="busy()">Gespräch starten</button>
      <p>{{ status() }}</p>
      <video class="call" autoplay playsinline></video>
    </main>
  `,
})
export class CallComponent {
  speech = signal<Speech | null>(null);
  cloneProfile = signal<CloneProfile | null>(null);
  uploading = signal(false);
  uploadStatus = signal("");
  status = signal("Bereit.");
  busy = signal(false);
  private room?: Room;
  private view?: HTMLVideoElement;

  constructor() {
    const origin = location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:4010"
      : `${location.origin}`;
    this.api = origin.includes(":4010") ? origin : `${location.origin}/klon-agent`;
    fetch(`${this.api}/anschluesse`)
      .then((response) => response.json())
      .then((body: { speech: Speech; clone?: CloneProfile }) => {
        this.speech.set(body.speech);
        if (body.clone) this.cloneProfile.set(body.clone);
        this.loginHref = body.speech.login ? `${this.api}${body.speech.login}` : "";
      })
      .catch(() => undefined);
  }

  loginHref = "";

  private api: string;

  photoBlob: Blob | null = null;
  voiceBlob: Blob | null = null;
  videoBlob: Blob | null = null;
  private voiceRecorder?: MediaRecorder;
  private videoRecorder?: MediaRecorder;

  private preview(): HTMLVideoElement {
    return document.querySelector("video.preview") as HTMLVideoElement;
  }

  private async media(video: boolean, audio: boolean): Promise<MediaStream> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Kamera und Mikrofon gehen hier nur über https");
    }
    return navigator.mediaDevices.getUserMedia({
      video: video ? { facingMode: "user" } : false,
      audio,
    });
  }

  private stop(stream: MediaStream) {
    stream.getTracks().forEach((track) => track.stop());
    const preview = this.preview();
    if (preview) preview.srcObject = null;
  }

  async takePhoto() {
    this.uploadStatus.set("Kamera…");
    try {
      const stream = await this.media(true, false);
      const preview = this.preview();
      preview.srcObject = stream;
      await preview.play();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const canvas = document.createElement("canvas");
      canvas.width = preview.videoWidth || 640;
      canvas.height = preview.videoHeight || 480;
      canvas.getContext("2d")?.drawImage(preview, 0, 0);
      this.photoBlob = await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
      this.stop(stream);
      this.uploadStatus.set(this.photoBlob ? "Foto liegt bereit." : "Foto fehlgeschlagen.");
    } catch (error) {
      this.uploadStatus.set(error instanceof Error ? error.message : "Foto fehlgeschlagen.");
    }
  }

  async recordVoice() {
    if (this.voiceRecorder?.state === "recording") {
      this.voiceRecorder.stop();
      return;
    }
    try {
      const stream = await this.media(false, true);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      this.voiceRecorder = recorder;
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        this.voiceBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        this.stop(stream);
        this.voiceRecorder = undefined;
        this.uploadStatus.set("Stimmprobe liegt bereit.");
      };
      recorder.start();
      this.uploadStatus.set("Stimme läuft, nochmal tippen stoppt.");
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 6000);
    } catch (error) {
      this.uploadStatus.set(error instanceof Error ? error.message : "Stimme fehlgeschlagen.");
    }
  }

  async recordVideo() {
    if (this.videoRecorder?.state === "recording") {
      this.videoRecorder.stop();
      return;
    }
    try {
      const stream = await this.media(true, true);
      const preview = this.preview();
      preview.srcObject = stream;
      await preview.play();
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      this.videoRecorder = recorder;
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        this.videoBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        this.stop(stream);
        this.videoRecorder = undefined;
        this.uploadStatus.set("Video liegt bereit.");
      };
      recorder.start();
      this.uploadStatus.set("Video läuft, nochmal tippen stoppt.");
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 8000);
    } catch (error) {
      this.uploadStatus.set(error instanceof Error ? error.message : "Video fehlgeschlagen.");
    }
  }

  async saveClone() {
    if (!this.photoBlob || !this.voiceBlob || !this.videoBlob) return;
    const data = new FormData();
    data.append("photo", this.photoBlob, "foto.jpg");
    data.append("voice", this.voiceBlob, "stimme.webm");
    data.append("video", this.videoBlob, "video.webm");
    this.uploading.set(true);
    this.uploadStatus.set("Speichere Foto, Stimme und Video…");
    try {
      const response = await fetch(`${this.api}/klon`, { method: "POST", body: data });
      if (!response.ok) throw new Error("Upload abgelehnt");
      this.cloneProfile.set((await response.json()) as CloneProfile);
      this.uploadStatus.set("Klon gespeichert.");
    } catch {
      this.uploadStatus.set("Der Klon konnte nicht gespeichert werden.");
    }
    this.uploading.set(false);
  }

  async join() {
    this.busy.set(true);
    this.status.set("Verbinde mit LiveKit…");
    const response = await fetch(`${this.api}/token`, { method: "POST" });
    const body = (await response.json()) as TokenResponse;
    this.speech.set(body.speech);
    this.cloneProfile.set(body.clone);
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio || track.kind === Track.Kind.Video) {
        const element = track.attach();
        if (element instanceof HTMLVideoElement) {
          element.autoplay = true;
          element.playsInline = true;
          element.style.width = "100%";
          element.style.minHeight = "240px";
          element.style.background = "#111";
          element.style.borderRadius = "12px";
          document.querySelector("video.call")?.replaceWith(element);
        } else {
          element.autoplay = true;
          document.body.append(element);
        }
      }
    });
    room.on(RoomEvent.DataReceived, (payload) => {
      this.status.set(new TextDecoder().decode(payload));
    });
    await room.connect(body.url, body.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    this.status.set("Im Raum. Der Klon spricht den Hinweis.");
    this.busy.set(false);
  }
}

bootstrapApplication(CallComponent).catch((error) => console.error(error));
