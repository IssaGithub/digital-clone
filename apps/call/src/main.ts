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
type Heygen = { connected: boolean; label: string; detail: string };
type TokenResponse = { url: string; token: string; speech: Speech; heygen: Heygen };

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
      @if (heygen() && !heygen()!.connected) {
        <section class="card">
          <strong>HeyGen-Anschluss fehlt</strong>
          <p class="warn">{{ heygen()?.detail }}</p>
        </section>
      }
      <button type="button" (click)="join()" [disabled]="busy()">Gespräch starten</button>
      <p>{{ status() }}</p>
      <video #remote autoplay playsinline></video>
    </main>
  `,
})
export class CallComponent {
  speech = signal<Speech | null>(null);
  heygen = signal<Heygen | null>(null);
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
      .then((body: { speech: Speech; heygen?: Heygen }) => {
        this.speech.set(body.speech);
        if (body.heygen) this.heygen.set(body.heygen);
        this.loginHref = body.speech.login ? `${this.api}${body.speech.login}` : "";
      })
      .catch(() => undefined);
  }

  loginHref = "";

  private api: string;

  async join() {
    this.busy.set(true);
    this.status.set("Verbinde mit LiveKit…");
    const response = await fetch(`${this.api}/token`, { method: "POST" });
    const body = (await response.json()) as TokenResponse;
    this.speech.set(body.speech);
    this.heygen.set(body.heygen);
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
