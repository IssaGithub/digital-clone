import type { SecretBag } from "./crypto.js";
import { recallApiBase } from "./env.js";
import { buildQuotationBody, type DraftLine } from "./offers.js";

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function readError(response: Response) {
  const text = await response.text();
  return text.slice(0, 500) || response.statusText;
}

export async function llmComplete(secret: SecretBag, system: string, user: string) {
  if (!secret.apiKey) throw new IntegrationError("Sprachmodell ist nicht angeschlossen");
  const base = (secret.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: secret.model || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content || "";
}

export async function transcribeWav(secret: SecretBag, wav: Buffer) {
  if (!secret.apiKey) throw new IntegrationError("Sprachmodell ist nicht angeschlossen");
  const base = (secret.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const form = new FormData();
  form.set("model", "whisper-1");
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret.apiKey}` },
    body: form,
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as { text?: string };
  return json.text || "";
}

export async function elevenLabsMp3(apiKey: string, voiceId: string, text: string) {
  if (!apiKey) throw new IntegrationError("ElevenLabs ist nicht angeschlossen");
  if (!voiceId) throw new IntegrationError("ElevenLabs-Stimme am Klon fehlt");
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return Buffer.from(await response.arrayBuffer());
}

export async function recallCreateBot(apiKey: string, input: {
  meetingUrl: string;
  joinAt: string;
  botName: string;
  websocketUrl: string;
  bookingId: string;
}) {
  if (!apiKey) throw new IntegrationError("Recall.ai ist nicht angeschlossen");
  const response = await fetch(`${recallApiBase()}/api/v1/bot/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meeting_url: input.meetingUrl,
      join_at: input.joinAt,
      bot_name: input.botName,
      metadata: { bookingId: input.bookingId },
      recording_config: {
        audio_mixed_raw: {},
        realtime_endpoints: [
          {
            type: "websocket",
            url: input.websocketUrl,
            events: ["audio_mixed_raw.data", "transcript.data"],
          },
        ],
      },
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new IntegrationError("Recall hat keine Bot-Id geliefert");
  return json.id;
}

export async function recallOutputAudio(apiKey: string, botId: string, mp3: Buffer) {
  const response = await fetch(`${recallApiBase()}/api/v1/bot/${botId}/output_audio/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "mp3",
      b64_data: mp3.toString("base64"),
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
}

export async function lexwareCreateQuotation(apiKey: string, input: {
  customerName: string;
  lines: DraftLine[];
  voucherDate: string;
  finalize: boolean;
}) {
  if (!apiKey) throw new IntegrationError("Lexware ist nicht angeschlossen");
  const response = await fetch("https://api.lexware.io/v1/quotations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildQuotationBody(input)),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new IntegrationError("Lexware hat keine Angebots-Id geliefert");
  return json.id;
}

export async function lexwareQuotationPdf(apiKey: string, quotationId: string) {
  const response = await fetch(`https://api.lexware.io/v1/quotations/${quotationId}/file`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/pdf",
    },
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return Buffer.from(await response.arrayBuffer());
}

export async function heygenCreatePortrait(apiKey: string, input: {
  avatarId: string;
  voiceId: string;
  text: string;
}) {
  if (!apiKey) throw new IntegrationError("HeyGen ist nicht angeschlossen");
  if (!input.avatarId || !input.voiceId) throw new IntegrationError("HeyGen-Avatar oder Stimme am Klon fehlt");
  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_inputs: [
        {
          character: { type: "avatar", avatar_id: input.avatarId, avatar_style: "normal" },
          voice: { type: "text", input_text: input.text, voice_id: input.voiceId },
          background: { type: "color", value: "#111111" },
        },
      ],
      dimension: { width: 1080, height: 1920 },
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as { data?: { video_id?: string }; error?: { message?: string } };
  const videoId = json.data?.video_id;
  if (!videoId) throw new IntegrationError(json.error?.message || "HeyGen hat keine Video-Id geliefert");
  return videoId;
}

export async function heygenStatus(apiKey: string, videoId: string) {
  const response = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
    headers: { "X-Api-Key": apiKey },
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  const json = (await response.json()) as {
    data?: { status?: string; video_url?: string; error?: { message?: string } };
  };
  return {
    status: json.data?.status || "unknown",
    videoUrl: json.data?.video_url || "",
    error: json.data?.error?.message || "",
  };
}

export function googleAuthUrl(input: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email https://www.googleapis.com/auth/gmail.send");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function microsoftAuthUrl(input: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "offline_access User.Read Mail.Send");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGoogleCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshGoogleToken(input: { refreshToken: string; clientId: string; clientSecret: string }) {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return (await response.json()) as { access_token: string; expires_in: number };
}

export async function googleEmail(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return "";
  const json = (await response.json()) as { email?: string };
  return json.email || "";
}

export async function exchangeMicrosoftCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshMicrosoftToken(input: { refreshToken: string; clientId: string; clientSecret: string }) {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    scope: "offline_access User.Read Mail.Send",
  });
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
  return (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function microsoftEmail(accessToken: string) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return "";
  const json = (await response.json()) as { mail?: string; userPrincipalName?: string };
  return json.mail || json.userPrincipalName || "";
}

function encodeRawMail(input: { to: string; subject: string; text: string; pdf: Buffer; filename: string }) {
  const boundary = "klon-boundary";
  const message = [
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.text,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${input.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${input.filename}"`,
    "",
    input.pdf.toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendGmailPdf(accessToken: string, input: { to: string; subject: string; text: string; pdf: Buffer }) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: encodeRawMail({ ...input, filename: "Angebot.pdf" }),
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
}

export async function sendOutlookPdf(accessToken: string, input: { to: string; subject: string; text: string; pdf: Buffer }) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: { contentType: "Text", content: input.text },
        toRecipients: [{ emailAddress: { address: input.to } }],
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "Angebot.pdf",
            contentType: "application/pdf",
            contentBytes: input.pdf.toString("base64"),
          },
        ],
      },
      saveToSentItems: true,
    }),
  });
  if (!response.ok) throw new IntegrationError(await readError(response), response.status);
}
