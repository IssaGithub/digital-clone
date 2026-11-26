# Klon-Plattform

Dashboard, Calendly-Webhook, Recall-Bot und ein eigener Voice-Dienst. Angebote bleiben Entwurf, bis sie im Dashboard freigegeben werden. Reels werden in der App heruntergeladen.

## Start

Postgres, zum Beispiel über `docker compose up -d`.

```bash
npm run env:init
npm install
npm run db:push
npm run dev
npm run dev:voice
npm run dev:worker
```

Ohne API-Schlüssel starten Web, Voice und Worker. Jede fehlende Verbindung bleibt als Karte sichtbar.

## Dienste

- `apps/web` auf Port 3000: Dashboard, OAuth, Calendly-Webhook
- `apps/voice` auf Port 3001: WebSocket `/recall` für `audio_mixed_raw` und Transkript. Next hält diese Verbindung nicht.
- `apps/worker`: Queue für Bot-Start, Angebotsentwurf, Video-Render
- `packages/db`: Postgres und Prisma

## Ablauf

1. Klon mit Stimme, Wissen, Preisliste und Schalter für automatischen Versand.
2. `invitee.created` prüft die Calendly-Signatur. Aus `scheduled_event.location` kommen Typ und `join_url` (`google_conference` oder Microsoft Teams).
3. Der Worker legt einen Recall-Bot mit `join_at` an.
4. Der Voice-Dienst spricht zuerst den Hinweis, dass ein digitaler Klon spricht, transkribiert, antwortet mit dem Klon-Prompt und spielt Audio über Recall `output_audio`.
5. Danach Extraktion von Kunde, Leistung und Menge. Preise nur aus `PriceItem`. Unklare Posten bleiben Entwurf.
6. `POST https://api.lexware.io/v1/quotations` mit `finalize: false`. Freigabe erzeugt das finale Angebot und sendet das PDF per Gmail oder Outlook an die Calendly-E-Mail. Automatischer Versand nur, wenn keine unklare Position übrig ist.
7. Reel: Briefing, Skript, ElevenLabs-Text, vertikales HeyGen-Video, Download. Kein Instagram- oder TikTok-Upload.

`github_project` liegt als `PlannedAction` am Klon und wird nicht ausgeführt.

## Umgebungsvariablen

Pflicht, damit Anmeldung und Verschlüsselung halten:

- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `SESSION_SECRET`
- `VOICE_SHARED_SECRET`
- `APP_URL`
- `VOICE_PUBLIC_WS_URL`

Konten liegen verschlüsselt pro Nutzer im Dashboard. Zusätzlich, sonst bleiben die OAuth-Karten ohne Anschluss:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`

Optional: `DASHBOARD_PASSWORD`, `RECALL_API_BASE`, `VOICE_PORT`.

Schlüssel für Calendly, Lexware, Recall.ai, ElevenLabs, HeyGen und das Sprachmodell werden nicht als Env erwartet, sondern pro Nutzer gespeichert.
