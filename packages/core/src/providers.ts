export const CONNECTION_PROVIDERS = [
  {
    id: "calendly",
    label: "Calendly",
    mode: "keys",
    blurb: "Buchungen über invitee.created. Die Signatur wird mit dem Schlüssel dieses Nutzers geprüft.",
    fields: [
      { key: "apiKey", label: "Personal Access Token", secret: true },
      { key: "webhookSigningKey", label: "Webhook-Signaturschlüssel", secret: true },
    ],
  },
  {
    id: "lexware",
    label: "Lexware Office",
    mode: "keys",
    blurb: "Angebote über POST /v1/quotations. Ohne Schlüssel bleibt der Entwurf lokal.",
    fields: [{ key: "apiKey", label: "API-Schlüssel", secret: true }],
  },
  {
    id: "google",
    label: "Google (Gmail)",
    mode: "oauth",
    blurb: "Versand des Angebots-PDF. Braucht GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET der Plattform.",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    fields: [],
  },
  {
    id: "microsoft",
    label: "Microsoft (Outlook)",
    mode: "oauth",
    blurb: "Versand des Angebots-PDF über Microsoft Graph.",
    env: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    fields: [],
  },
  {
    id: "recall",
    label: "Recall.ai",
    mode: "keys",
    blurb: "Bot mit join_at. Audio kommt als audio_mixed_raw zum Voice-Dienst.",
    fields: [{ key: "apiKey", label: "API-Schlüssel", secret: true }],
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    mode: "keys",
    blurb: "Stimme des Klons im Call und Sprechertext für Reels.",
    fields: [{ key: "apiKey", label: "API-Schlüssel", secret: true }],
  },
  {
    id: "heygen",
    label: "HeyGen",
    mode: "keys",
    blurb: "Vertikales Video, 1080×1920. Download nur in der App.",
    fields: [{ key: "apiKey", label: "API-Schlüssel", secret: true }],
  },
  {
    id: "llm",
    label: "Sprachmodell",
    mode: "keys",
    blurb: "Gesprächsantworten, Extraktion und Reel-Skript. OpenAI-kompatible API.",
    fields: [
      { key: "apiKey", label: "API-Schlüssel", secret: true },
      { key: "baseUrl", label: "Basis-URL", secret: false, placeholder: "https://api.openai.com/v1" },
      { key: "model", label: "Modell", secret: false, placeholder: "gpt-4o-mini" },
    ],
  },
] as const;

export type ProviderId = (typeof CONNECTION_PROVIDERS)[number]["id"];

export function providerMeta(id: string) {
  return CONNECTION_PROVIDERS.find((item) => item.id === id);
}
