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
  live: { face?: string; voice?: string };
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
          <p>Live: {{ cloneProfile()?.live?.face }}. {{ cloneProfile()?.live?.voice }}.</p>
          <p class="warn">Roh: {{ cloneProfile()?.raw?.movement }}. {{ cloneProfile()?.raw?.voiceClone }}.</p>
        }
        <form (submit)="upload($event)">
          <label>Foto <input name="photo" type="file" accept="image/*" required /></label>
          <label>Stimmprobe <input name="voice" type="file" accept="audio/*" required /></label>
          <label>Video <input name="video" type="file" accept="video/*" required /></label>
          <button type="submit" [disabled]="uploading()">Klon anlegen</button>
        </form>
        <p>{{ uploadStatus() }}</p>
      </section>
      <button type="button" (click)="join()" [disabled]="busy()">Gespräch starten</button>
      <p>{{ status() }}</p>
      <video #remote autoplay playsinline></video>
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

  async upload(event: Event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    this.uploading.set(true);
    this.uploadStatus.set("Speichere Foto, Stimme und Video…");
    try {
      const response = await fetch(`${this.api}/klon`, { method: "POST", body: data });
      if (!response.ok) throw new Error("Upload abgelehnt");
      this.cloneProfile.set((await response.json()) as CloneProfile);
      this.uploadStatus.set("Klon gespeichert.");
      form.reset();
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
          document.querySelector("video")?.replaceWith(element);
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
