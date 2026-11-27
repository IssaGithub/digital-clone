import "zone.js";
import { Component, ElementRef, OnDestroy, signal, viewChild } from "@angular/core";
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
  name?: string;
  label: string;
  live: { face?: string; voice?: string; movement?: string };
  shifts?: number[][];
  hints?: string[];
  raw?: { movement?: string; voiceClone?: string };
};
type TokenResponse = { url: string; token: string; speech: Speech; clone: CloneProfile };
type Screen = "home" | "studio" | "call";
type Phase = "prepare" | "live" | "countdown" | "recording" | "review" | "error";

@Component({
  selector: "app-call",
  template: `
    <main>
      <header class="topbar">
        <button type="button" class="brand" (click)="goHome()">Klon Studio</button>
        <nav>
          <button type="button" [class.on]="screen() !== 'call'" (click)="goHome()">Studio</button>
          <button type="button" [class.on]="screen() === 'call'" (click)="openCall()" [disabled]="!cloneProfile()?.ready">Gespräch</button>
        </nav>
      </header>
      <audio #ansage class="ansage"></audio>

      @if (screen() === 'home') {
        <section class="home">
          @if (notice()) {
            <p class="banner">{{ notice() }}</p>
          }
          @if (!secure) {
            <p class="note">Kamera und Mikrofon gehen hier nur über https.</p>
          }
          @if (cloneProfile()?.ready) {
            <article class="card avatar-card">
              @if (!sampleBroken()) {
                <video [src]="mediaUrl('video')" [poster]="faceSrc()" controls playsinline (error)="sampleBroken.set(true)"></video>
              } @else {
                <img class="face" alt="Foto des Klons" [src]="faceSrc()" (error)="faceFailed()" />
              }
              <div>
                <p class="kicker">Dein Klon</p>
                <h1>{{ cloneProfile()?.label }}</h1>
                <p class="lead">{{ cloneProfile()?.live?.face }}. {{ cloneProfile()?.live?.voice }}.</p>
                @if (cloneProfile()?.live?.movement) {
                  <p>{{ cloneProfile()?.live?.movement }}.</p>
                }
                @for (hint of cloneProfile()?.hints ?? []; track hint) {
                  <p class="note">{{ hint }}</p>
                }
                <div class="actions">
                  <button type="button" class="primary" (click)="openCall()">Gespräch starten</button>
                  <button type="button" class="ghost" (click)="startStudio()">Neu aufnehmen</button>
                </div>
                <audio [src]="mediaUrl('stimme')" controls></audio>
              </div>
            </article>
          } @else {
            <article class="card hero">
              <p class="kicker">Digitaler Klon</p>
              <h1>Foto, Stimme, kurzes Video.</h1>
              <p class="lead">Nimm alles direkt im Browser auf. In der Vorschau prüfst du die drei Aufnahmen, danach legst du den Klon an.</p>
              <button type="button" class="primary" (click)="startStudio()">Klon erstellen</button>
            </article>
          }
          <ol class="flow">
            <li><span>1</span><strong>Foto</strong><p>Gesicht mittig, Licht von vorn.</p></li>
            <li><span>2</span><strong>Stimme</strong><p>Einen Satz deutlich vorlesen.</p></li>
            <li><span>3</span><strong>Video</strong><p>Kurz in die Kamera sprechen.</p></li>
            <li><span>4</span><strong>Vorschau</strong><p>Prüfen, dann den Klon anlegen.</p></li>
          </ol>
        </section>
      }

      @if (screen() === 'studio') {
        <section>
          <ol class="stepper">
            @for (item of steps; track item.id) {
              <li [class.current]="step() === item.id" [class.done]="step() > item.id">
                <button type="button" (click)="goto(item.id)" [disabled]="!canGoto(item.id)">
                  <span>{{ item.id + 1 }}</span>{{ item.label }}
                </button>
              </li>
            }
          </ol>
          <div class="studio">
            <div class="stage-wrap" [class.paper]="step() === 1 || step() === 3">
              @if (step() === 3) {
                <div class="preview-grid">
                  @if (photoUrl()) {
                    <img [src]="photoUrl()" alt="Vorschau des Fotos" />
                  }
                  @if (videoUrl()) {
                    <video [src]="videoUrl()" controls playsinline></video>
                  }
                  @if (voiceUrl()) {
                    <audio [src]="voiceUrl()" controls></audio>
                  }
                </div>
              } @else if (step() === 1) {
                <div class="script-stage">
                  <p class="script">{{ script }}</p>
                  <div class="meter" aria-hidden="true">
                    @for (bar of bars(); track $index) {
                      <span [style.height.%]="bar"></span>
                    }
                  </div>
                  @if (phase() === 'review' && voiceUrl()) {
                    <audio [src]="voiceUrl()" controls></audio>
                  }
                </div>
              } @else {
                @if (showCamera()) {
                  <video #stageVideo class="mirror" autoplay muted playsinline></video>
                }
                @if (step() === 0 && phase() === 'review' && photoUrl()) {
                  <img [src]="photoUrl()" alt="Aufgenommenes Foto" />
                }
                @if (step() === 2 && phase() === 'review' && videoUrl()) {
                  <video [src]="videoUrl()" controls playsinline></video>
                }
                @if (showGuide()) {
                  <div class="guide" aria-hidden="true"></div>
                }
              }
              @if (countdown() > 0) {
                <div class="count">{{ countdown() }}</div>
              }
              @if (phase() === 'recording') {
                <div class="rec"><i></i>{{ elapsedLabel() }}</div>
              }
            </div>
            <aside class="card side">
              <p class="kicker">Schritt {{ step() + 1 }} von 4</p>
              <h2>{{ titles[step()] }}</h2>
              <p>{{ help[step()] }}</p>
              @if (step() === 0) {
                <ul>
                  <li>Gesicht im Oval</li>
                  <li>Licht von vorn</li>
                  <li>Ruhiger Hintergrund</li>
                </ul>
              }
              @if (step() === 1 || step() === 2) {
                <p class="script-side">{{ script }}</p>
              }
              @if (step() === 3) {
                <ul class="checks">
                  <li [class.ok]="hasPhoto()">Foto</li>
                  <li [class.ok]="hasVoice()">Stimme{{ voiceSeconds() ? ', ' + voiceSeconds() + ' s' : '' }}</li>
                  <li [class.ok]="hasVideo()">Video{{ videoSeconds() ? ', ' + videoSeconds() + ' s' : '' }}</li>
                </ul>
                <label class="field">
                  Name
                  <input type="text" maxlength="80" [value]="name()" (input)="onName($event)" placeholder="Zum Beispiel: Mein Klon" />
                </label>
              }
              <p class="note" aria-live="polite">{{ note() }}</p>
              <div class="actions">
                @if (step() < 3 && phase() === 'review') {
                  <button type="button" class="primary" (click)="weiter()">Weiter</button>
                  <button type="button" class="ghost" (click)="retake()">Nochmal</button>
                }
                @if (step() < 3 && phase() === 'recording') {
                  <button type="button" class="primary danger" (click)="stopEarly()">Stopp</button>
                }
                @if (step() < 3 && (phase() === 'live' || phase() === 'prepare' || phase() === 'countdown')) {
                  <button type="button" class="primary" (click)="shutter()" [disabled]="working() || phase() !== 'live'">{{ actionLabel() }}</button>
                }
                @if (phase() === 'error') {
                  <button type="button" class="primary" (click)="retake()">Erneut versuchen</button>
                }
                @if (step() === 3) {
                  <button type="button" class="primary" (click)="saveClone()" [disabled]="uploading() || !hasPhoto() || !hasVoice() || !hasVideo()">
                    {{ uploading() ? 'Klon wird angelegt…' : 'Klon anlegen' }}
                  </button>
                  <button type="button" class="ghost" (click)="restart()" [disabled]="uploading()">Von vorn</button>
                }
              </div>
            </aside>
          </div>
        </section>
      }

      @if (screen() === 'call') {
        <section class="call-screen">
          <article class="card stage-card">
            <p class="kicker">Gespräch</p>
            <h1>Dein Klon im Raum</h1>
            <img class="face" alt="Klon" [attr.src]="faceSrc() || null" [hidden]="!faceSrc()" (error)="faceFailed()" />
            @if (!faceSrc()) {
              <p class="note">Noch kein Foto gespeichert. Nimm zuerst Foto, Stimme und Video auf.</p>
            }
            <p>{{ status() }}</p>
            <video #callVideo class="call" autoplay playsinline></video>
            <button type="button" class="primary" (click)="join()" [disabled]="busy()">Erneut verbinden</button>
          </article>
          <article class="card">
            <strong>{{ speech()?.label || 'OpenAI Sprache' }}</strong>
            <p [class.note]="!speech()?.connected">{{ speech()?.purpose || 'STT und TTS' }}: {{ speech()?.detail || 'fehlender Anschluss' }}</p>
            <p>Im Gespräch folgt die Stimme der Tonhöhe deiner Probe.</p>
            @if (loginHref) {
              <a [href]="loginHref">Mit OpenAI anmelden</a>
            }
            @if (speech()?.loginHint) {
              <p>{{ speech()?.loginHint }}</p>
            }
          </article>
        </section>
      }
    </main>
  `,
})
export class CallComponent implements OnDestroy {
  readonly steps = [
    { id: 0, label: "Foto" },
    { id: 1, label: "Stimme" },
    { id: 2, label: "Video" },
    { id: 3, label: "Vorschau" },
  ];
  readonly titles = ["Foto aufnehmen", "Stimme aufnehmen", "Kurzes Video", "Vorschau"];
  readonly help = [
    "Positioniere dein Gesicht im Oval. Das Licht kommt von vorn, der Hintergrund bleibt ruhig.",
    "Lies den Satz in normaler Lautstärke. Die Probe bestimmt die Tonhöhe im Gespräch.",
    "Schau in die Kamera, bewege den Kopf leicht und sprich denselben Satz.",
    "Prüfe Foto, Stimme und Video. Wenn alles passt, legst du den Klon an.",
  ];
  readonly script = "Hallo, hier spricht meine Stimme für den digitalen Klon. Ich spreche deutlich, ruhig und in normaler Lautstärke.";
  readonly secure = window.isSecureContext;

  screen = signal<Screen>("home");
  step = signal(0);
  phase = signal<Phase>("live");
  countdown = signal(0);
  elapsed = signal(0);
  level = signal(0);
  photoUrl = signal("");
  voiceUrl = signal("");
  videoUrl = signal("");
  hasPhoto = signal(false);
  hasVoice = signal(false);
  hasVideo = signal(false);
  voiceSeconds = signal(0);
  videoSeconds = signal(0);
  name = signal("");
  note = signal("");
  notice = signal("");
  uploading = signal(false);
  working = signal(false);
  speech = signal<Speech | null>(null);
  cloneProfile = signal<CloneProfile | null>(null);
  faceSrc = signal("");
  sampleBroken = signal(false);
  status = signal("Bereit.");
  busy = signal(false);
  loginHref = "";

  private photoBlob: Blob | null = null;
  private voiceBlob: Blob | null = null;
  private videoBlob: Blob | null = null;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private room?: Room;
  private ansageOk = false;
  private prepareGen = 0;
  private autoStop = 0;
  private tick = 0;
  private drawTimer = 0;
  private stamp = 0;
  private meter?: { ctx: AudioContext; timer: number };
  private readonly stageVideo = viewChild<ElementRef<HTMLVideoElement>>("stageVideo");
  private readonly ansage = viewChild<ElementRef<HTMLAudioElement>>("ansage");
  private readonly api: string;

  constructor() {
    const origin = location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:4010"
      : location.origin;
    this.api = origin.includes(":4010") ? origin : `${location.origin}/klon-agent`;
    fetch(`${this.api}/anschluesse`)
      .then((response) => response.json())
      .then((body: { speech: Speech; clone?: CloneProfile }) => {
        this.speech.set(body.speech);
        if (body.clone) this.cloneProfile.set(body.clone);
        if (body.clone?.ready) this.showFace();
        if (body.clone?.name) this.name.set(body.clone.name);
        this.loginHref = body.speech.login ? `${this.api}${body.speech.login}` : "";
      })
      .catch(() => undefined);
  }

  ngOnDestroy() {
    this.releaseStudio();
    this.clearTakes();
    void this.room?.disconnect();
  }

  goHome() {
    this.releaseStudio();
    void this.room?.disconnect();
    this.room = undefined;
    this.screen.set("home");
  }

  startStudio() {
    void this.room?.disconnect();
    this.room = undefined;
    this.clearTakes();
    this.name.set(this.cloneProfile()?.name || "");
    this.step.set(0);
    this.note.set("");
    this.notice.set("");
    this.phase.set("prepare");
    this.screen.set("studio");
    void this.prepareStep(0);
  }

  openCall() {
    if (!this.cloneProfile()?.ready || this.busy()) return;
    this.releaseStudio();
    this.screen.set("call");
    void this.join();
  }

  canGoto(index: number): boolean {
    if (this.phase() === "recording" || this.countdown() > 0 || this.uploading()) return index === this.step();
    return index <= this.step();
  }

  goto(index: number) {
    if (!this.canGoto(index) || index === this.step()) return;
    const ready = [this.hasPhoto(), this.hasVoice(), this.hasVideo(), true][index];
    this.step.set(index);
    this.note.set("");
    this.phase.set(index < 3 && ready ? "review" : "prepare");
    void this.prepareStep(index);
  }

  weiter() {
    const current = this.step();
    if (current === 0 && !this.hasPhoto()) return;
    if (current === 1 && !this.hasVoice()) return;
    if (current === 2 && !this.hasVideo()) return;
    if (current >= 3) return;
    this.step.set(current + 1);
    this.note.set("");
    this.phase.set(current + 1 === 3 ? "review" : "prepare");
    void this.prepareStep(current + 1);
  }

  retake() {
    if (this.step() === 0) this.clearPhoto();
    if (this.step() === 1) this.clearVoice();
    if (this.step() === 2) this.clearVideo();
    this.note.set("");
    this.phase.set("prepare");
    void this.prepareStep(this.step());
  }

  restart() {
    this.clearTakes();
    this.step.set(0);
    this.note.set("");
    this.phase.set("prepare");
    void this.prepareStep(0);
  }

  showCamera(): boolean {
    const current = this.step();
    return (current === 0 || current === 2) && this.phase() !== "review";
  }

  showGuide(): boolean {
    return this.showCamera() && this.phase() !== "error";
  }

  bars(): number[] {
    const amount = this.level();
    return Array.from({ length: 12 }, (_, index) => {
      const shape = 0.45 + 0.55 * Math.sin(((index + 0.5) / 12) * Math.PI);
      return Math.round(8 + amount * shape * 92);
    });
  }

  elapsedLabel(): string {
    const seconds = Math.max(0, Math.floor(this.elapsed()));
    return `0:${String(seconds).padStart(2, "0")}`;
  }

  actionLabel(): string {
    if (this.phase() === "prepare") return "Gerät startet…";
    if (this.phase() === "countdown") return "Gleich…";
    return ["Foto aufnehmen", "Stimme aufnehmen", "Video aufnehmen"][this.step()] || "Aufnehmen";
  }

  onName(event: Event) {
    this.name.set((event.target as HTMLInputElement).value);
  }

  mediaUrl(kind: "foto" | "stimme" | "video"): string {
    return `${this.api}/klon/${kind}?t=${this.stamp}`;
  }

  async shutter() {
    if (this.working() || this.phase() !== "live") return;
    this.working.set(true);
    this.note.set("");
    try {
      const stay = await this.countDown();
      if (!stay) return;
      if (this.step() === 0) await this.snapPhoto();
      if (this.step() === 1) await this.recordClip("voice");
      if (this.step() === 2) await this.recordClip("video");
    } catch (error) {
      this.phase.set("error");
      this.note.set(this.describe(error));
    } finally {
      this.working.set(false);
      this.countdown.set(0);
    }
  }

  stopEarly() {
    if (this.autoStop) window.clearTimeout(this.autoStop);
    this.autoStop = 0;
    if (this.recorder && this.recorder.state === "recording") this.recorder.stop();
  }

  async saveClone() {
    if (!this.photoBlob || !this.voiceBlob || !this.videoBlob || this.uploading()) return;
    const data = new FormData();
    data.append("photo", this.photoBlob, `foto.${this.ext(this.photoBlob, "jpg")}`);
    data.append("voice", this.voiceBlob, `stimme.${this.ext(this.voiceBlob, "webm")}`);
    data.append("video", this.videoBlob, `video.${this.ext(this.videoBlob, "webm")}`);
    data.append("name", this.name().trim());
    this.uploading.set(true);
    this.note.set("Speichere Foto, Stimme und Video…");
    try {
      const response = await fetch(`${this.api}/klon`, { method: "POST", body: data });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const detail = payload && typeof payload.detail === "string" ? payload.detail : "Der Klon konnte nicht angelegt werden.";
        throw new Error(detail);
      }
      const profile = (await response.json()) as CloneProfile;
      this.cloneProfile.set(profile);
      this.showFace();
      this.notice.set("Klon angelegt. Du kannst das Gespräch jetzt starten.");
      this.releaseStudio();
      this.clearTakes();
      this.screen.set("home");
    } catch (error) {
      this.note.set(this.describe(error));
    }
    this.uploading.set(false);
  }

  faceFailed() {
    if (this.faceSrc().includes("/klon/foto")) {
      this.faceSrc.set(`${this.api}/klon/bild?t=${Date.now()}`);
      return;
    }
    this.faceSrc.set("");
  }

  async join() {
    this.busy.set(true);
    this.ansageOk = false;
    this.playAnsage();
    this.status.set("Verbinde mit LiveKit…");
    try {
      const response = await fetch(`${this.api}/token`, { method: "POST" });
      const body = (await response.json()) as TokenResponse;
      this.speech.set(body.speech);
      this.cloneProfile.set(body.clone);
      const room = new Room();
      this.room = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && this.ansageOk) return;
        if (track.kind === Track.Kind.Video) {
          const slot = document.querySelector("video.call");
          if (slot instanceof HTMLMediaElement) track.attach(slot);
          return;
        }
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach();
          element.autoplay = true;
          element.className = "remote";
          document.body.append(element);
        }
      });
      room.on(RoomEvent.DataReceived, (payload) => {
        this.status.set(new TextDecoder().decode(payload));
      });
      const url = location.protocol === "https:" && body.url.startsWith("ws://")
        ? `wss://${body.url.slice(5)}`
        : body.url;
      await room.connect(url, body.token);
      this.status.set("Im Raum. Der Klon spricht den Hinweis.");
      await room.localParticipant.setMicrophoneEnabled(true).catch(() => undefined);
    } catch {
      this.status.set("Foto und Ansage laufen. Der LiveKit-Raum war nicht erreichbar.");
    }
    this.busy.set(false);
  }

  private async prepareStep(index: number) {
    const gen = ++this.prepareGen;
    this.stopCapture();
    this.stopStream();
    if (index === 3 || this.phase() === "review") return;
    this.phase.set("prepare");
    try {
      if (index === 0) await this.openStream(true, false, gen);
      if (index === 1) await this.openStream(false, true, gen);
      if (index === 2) await this.openStream(true, true, gen);
      if (gen !== this.prepareGen) return;
      this.phase.set("live");
    } catch (error) {
      if (gen !== this.prepareGen) return;
      this.stopStream();
      this.phase.set("error");
      this.note.set(this.describe(error));
    }
  }

  private async openStream(video: boolean, audio: boolean, gen: number) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Kamera und Mikrofon gehen hier nur über https.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } : false,
    });
    if (gen !== this.prepareGen) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (video) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await this.sleep(attempt === 0 ? 0 : 40);
        const element = this.stageVideo()?.nativeElement;
        if (!element) continue;
        element.srcObject = stream;
        element.muted = true;
        await element.play().catch(() => undefined);
        break;
      }
    }
    if (gen !== this.prepareGen) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    if (audio) this.startMeter(stream);
  }

  private async countDown(): Promise<boolean> {
    const gen = this.prepareGen;
    this.phase.set("countdown");
    for (const value of [3, 2, 1]) {
      if (gen !== this.prepareGen) return false;
      this.countdown.set(value);
      await this.sleep(800);
    }
    this.countdown.set(0);
    return gen === this.prepareGen;
  }

  private async snapPhoto() {
    const video = this.stageVideo()?.nativeElement;
    if (!video || !video.videoWidth) throw new Error("Die Kamera zeigt noch kein Bild.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Das Foto ist fehlgeschlagen.");
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/jpeg", 0.92));
    if (!blob || blob.size < 8_000) throw new Error("Das Foto ist zu klein. Bitte näher an die Kamera.");
    this.setPhoto(blob);
    this.stopStream();
    this.phase.set("review");
    this.note.set("Foto liegt bereit. Weiter oder noch einmal aufnehmen.");
  }

  private recordClip(kind: "voice" | "video"): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.reject(new Error("Das Gerät ist nicht bereit."));
    const mixed = kind === "video" ? this.mirroredStream(stream) : stream;
    const mime = this.pickMime(kind === "video" ? "video" : "audio");
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
    } catch {
      return Promise.reject(new Error("Dieses Format kann der Browser nicht aufnehmen."));
    }
    this.recorder = recorder;
    const chunks: Blob[] = [];
    const min = kind === "voice" ? 4 : 5;
    const max = kind === "voice" ? 12_000 : 10_000;
    const started = Date.now();
    this.elapsed.set(0);
    this.phase.set("recording");
    this.tick = window.setInterval(() => this.elapsed.set((Date.now() - started) / 1000), 200);
    return new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        this.clearTick();
        reject(new Error("Die Aufnahme ist fehlgeschlagen."));
      };
      recorder.onstop = () => {
        void this.finishClip(kind, chunks, recorder.mimeType, started, min, resolve);
      };
      try {
        recorder.start(200);
      } catch (error) {
        this.clearTick();
        reject(error instanceof Error ? error : new Error("Die Aufnahme ist fehlgeschlagen."));
        return;
      }
      this.autoStop = window.setTimeout(() => this.stopEarly(), max);
    });
  }

  private async finishClip(
    kind: "voice" | "video",
    chunks: Blob[],
    mime: string,
    started: number,
    min: number,
    resolve: () => void,
  ) {
    this.clearTick();
    this.stopDraw();
    if (this.autoStop) window.clearTimeout(this.autoStop);
    this.autoStop = 0;
    const seconds = (Date.now() - started) / 1000;
    const type = mime || (kind === "voice" ? "audio/webm" : "video/webm");
    const blob = new Blob(chunks, { type });
    this.recorder = undefined;
    this.stopStream();
    if (seconds < min || blob.size < 4_000) {
      this.phase.set("prepare");
      await this.prepareStep(this.step());
      this.note.set(`Bitte mindestens ${min} Sekunden aufnehmen.`);
      resolve();
      return;
    }
    if (kind === "voice") {
      this.setVoice(blob, Math.round(seconds));
      this.note.set("Stimmprobe liegt bereit. Hör sie an oder nimm sie neu auf.");
    } else {
      this.setVideo(blob, Math.round(seconds));
      this.note.set("Video liegt bereit. Spiel es ab oder nimm es neu auf.");
    }
    this.phase.set("review");
    resolve();
  }

  private mirroredStream(stream: MediaStream): MediaStream {
    const video = this.stageVideo()?.nativeElement;
    if (!video?.videoWidth || typeof HTMLCanvasElement.prototype.captureStream !== "function") return stream;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return stream;
    const draw = () => {
      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0);
      ctx.restore();
      this.drawTimer = requestAnimationFrame(draw);
    };
    draw();
    const mixed = canvas.captureStream(30);
    for (const track of stream.getAudioTracks()) mixed.addTrack(track);
    return mixed;
  }

  private showFace() {
    this.stamp = Date.now();
    this.sampleBroken.set(false);
    this.faceSrc.set(`${this.api}/klon/foto?t=${this.stamp}`);
  }

  private playAnsage() {
    const ansage = this.ansage()?.nativeElement;
    if (!ansage) return;
    const shifts = this.cloneProfile()?.shifts || [];
    this.showFace();
    ansage.src = `${this.api}/klon/ansage?t=${Date.now()}`;
    ansage.ontimeupdate = () => {
      const face = document.querySelector("img.face") as HTMLImageElement | null;
      if (!face || !shifts.length || !ansage.duration) return;
      const point = shifts[Math.min(shifts.length - 1, Math.floor((ansage.currentTime / ansage.duration) * shifts.length))];
      face.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
    };
    ansage.onended = () => {
      const face = document.querySelector("img.face") as HTMLImageElement | null;
      if (face) face.style.transform = "translate(0px, 0px)";
    };
    ansage
      .play()
      .then(() => {
        this.ansageOk = true;
      })
      .catch(() => {
        this.ansageOk = false;
        this.status.set("Ton blockiert: Wiedergabe im Browser erlauben und nochmal starten.");
      });
  }

  private setPhoto(blob: Blob) {
    this.revoke(this.photoUrl());
    this.photoBlob = blob;
    this.photoUrl.set(URL.createObjectURL(blob));
    this.hasPhoto.set(true);
  }

  private setVoice(blob: Blob, seconds: number) {
    this.revoke(this.voiceUrl());
    this.voiceBlob = blob;
    this.voiceUrl.set(URL.createObjectURL(blob));
    this.hasVoice.set(true);
    this.voiceSeconds.set(seconds);
  }

  private setVideo(blob: Blob, seconds: number) {
    this.revoke(this.videoUrl());
    this.videoBlob = blob;
    this.videoUrl.set(URL.createObjectURL(blob));
    this.hasVideo.set(true);
    this.videoSeconds.set(seconds);
  }

  private clearPhoto() {
    this.revoke(this.photoUrl());
    this.photoBlob = null;
    this.photoUrl.set("");
    this.hasPhoto.set(false);
  }

  private clearVoice() {
    this.revoke(this.voiceUrl());
    this.voiceBlob = null;
    this.voiceUrl.set("");
    this.hasVoice.set(false);
    this.voiceSeconds.set(0);
  }

  private clearVideo() {
    this.revoke(this.videoUrl());
    this.videoBlob = null;
    this.videoUrl.set("");
    this.hasVideo.set(false);
    this.videoSeconds.set(0);
  }

  private clearTakes() {
    this.clearPhoto();
    this.clearVoice();
    this.clearVideo();
  }

  private revoke(url: string) {
    if (url) URL.revokeObjectURL(url);
  }

  private startMeter(stream: MediaStream) {
    this.stopMeter();
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const sample = (value - 128) / 128;
        sum += sample * sample;
      }
      this.level.set(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
    }, 80);
    this.meter = { ctx, timer };
  }

  private stopMeter() {
    if (!this.meter) return;
    window.clearInterval(this.meter.timer);
    void this.meter.ctx.close();
    this.meter = undefined;
    this.level.set(0);
  }

  private stopStream() {
    this.stopMeter();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    const video = this.stageVideo()?.nativeElement;
    if (video) video.srcObject = null;
  }

  private stopCapture() {
    this.countdown.set(0);
    this.clearTick();
    this.stopDraw();
    if (this.autoStop) window.clearTimeout(this.autoStop);
    this.autoStop = 0;
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = undefined;
  }

  private stopDraw() {
    if (this.drawTimer) cancelAnimationFrame(this.drawTimer);
    this.drawTimer = 0;
  }

  private clearTick() {
    if (this.tick) window.clearInterval(this.tick);
    this.tick = 0;
  }

  private releaseStudio() {
    this.prepareGen += 1;
    this.stopCapture();
    this.stopStream();
  }

  private pickMime(kind: "audio" | "video"): string {
    const list = kind === "audio"
      ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    return list.find((item) => MediaRecorder.isTypeSupported(item)) || "";
  }

  private ext(blob: Blob, fallback: string): string {
    if (blob.type.includes("mp4")) return "mp4";
    if (blob.type.includes("wav")) return "wav";
    if (blob.type.includes("png")) return "png";
    if (blob.type.includes("jpeg") || blob.type.includes("jpg")) return "jpg";
    return fallback;
  }

  private describe(error: unknown): string {
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
      return "Bitte erlaube Kamera und Mikrofon im Browser.";
    }
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return "Keine Kamera oder kein Mikrofon gefunden.";
    }
    if (error instanceof Error && error.message) return error.message;
    return "Die Aufnahme ist fehlgeschlagen.";
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

bootstrapApplication(CallComponent).catch((error) => console.error(error));
