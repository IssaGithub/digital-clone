import { createServer } from "node:http";
import { appUrl, callMcpTool, cloneSystemPrompt, loadEnv, pcm16ToWav, readToolRequest, recallOutputAudio, toolCatalogPrompt, transcribeWav, voiceSharedSecret, elevenLabsMp3, llmComplete } from "@klon/core";
import { prisma } from "@klon/db";
import { enqueue, loadCloneMcp, readSecrets } from "@klon/domain";
import { WebSocketServer, type RawData } from "ws";

loadEnv();

type Turn = {
  pcm: Buffer[];
  lastUtterance: string;
  busy: boolean;
  disclosed: boolean;
};

const turns = new Map<string, Turn>();

function turnFor(botId: string) {
  const existing = turns.get(botId);
  if (existing) return existing;
  const created: Turn = { pcm: [], lastUtterance: "", busy: false, disclosed: false };
  turns.set(botId, created);
  return created;
}

async function sessionForBot(botId: string) {
  return prisma.callSession.findFirst({
    where: { recallBotId: botId },
    include: { booking: { include: { clone: { include: { priceItems: true } } } } },
  });
}

async function appendTranscript(botId: string, speaker: string, text: string) {
  const session = await sessionForBot(botId);
  if (!session || !text.trim()) return session;
  const line = `${speaker}: ${text.trim()}`;
  await prisma.callSession.update({
    where: { id: session.id },
    data: {
      transcript: session.transcript ? `${session.transcript}\n${line}` : line,
      status: "live",
      startedAt: session.startedAt ?? new Date(),
    },
  });
  await prisma.booking.update({ where: { id: session.bookingId }, data: { status: "live" } });
  return session;
}

async function speak(botId: string, text: string, disclosure: boolean) {
  const session = await sessionForBot(botId);
  if (!session) return;
  const userId = session.booking.clone.userId;
  const eleven = await readSecrets(userId, "elevenlabs");
  const recall = await readSecrets(userId, "recall");
  const voiceId = session.booking.clone.voiceId;
  if (!eleven?.apiKey || !voiceId || !recall?.apiKey) {
    await appendTranscript(botId, "Klon", text);
    await prisma.callSession.update({
      where: { id: session.id },
      data: {
        lastError: "Gesprochene Ausgabe braucht ElevenLabs, eine Stimme am Klon und Recall.ai.",
        disclosurePlayed: disclosure ? session.disclosurePlayed : session.disclosurePlayed,
      },
    });
    return;
  }
  const mp3 = await elevenLabsMp3(eleven.apiKey, voiceId, text);
  await recallOutputAudio(recall.apiKey, botId, mp3);
  if (disclosure) {
    await prisma.callSession.update({ where: { id: session.id }, data: { disclosurePlayed: true } });
  }
  await appendTranscript(botId, "Klon", text);
}

async function ensureDisclosure(botId: string) {
  const state = turnFor(botId);
  if (state.disclosed) return;
  const session = await sessionForBot(botId);
  if (!session || session.disclosurePlayed) {
    state.disclosed = true;
    return;
  }
  state.disclosed = true;
  await speak(botId, session.booking.clone.disclosureText, true);
}

async function replyTo(botId: string, utterance: string) {
  const state = turnFor(botId);
  if (!utterance.trim() || utterance === state.lastUtterance || state.busy) return;
  state.busy = true;
  state.lastUtterance = utterance;
  try {
    await ensureDisclosure(botId);
    const session = await appendTranscript(botId, "Gegenüber", utterance);
    if (!session) return;
    const fresh = await sessionForBot(botId);
    if (!fresh) return;
    const clone = fresh.booking.clone;
    const llm = await readSecrets(clone.userId, "llm");
    const mcp = await loadCloneMcp(clone.id);
    const basePrompt = cloneSystemPrompt({
      name: clone.name,
      knowledge: clone.knowledge,
      items: clone.priceItems.filter((item) => item.active),
    });
    let answer = "Ich habe dich gehört. Ohne Sprachmodell kann ich den Inhalt nicht beantworten.";
    if (llm?.apiKey) {
      let context = fresh.transcript;
      const system = `${basePrompt}${toolCatalogPrompt(mcp.tools)}`;
      for (let step = 0; step < 3; step += 1) {
        const raw = await llmComplete(llm, system, context);
        const request = readToolRequest(raw);
        if (!request) {
          answer = raw;
          break;
        }
        const tool = mcp.tools.find((item) => item.alias === request.name);
        const endpoint = tool ? mcp.endpoints.get(tool.serverName) : undefined;
        let result = "Werkzeug ist nicht verbunden.";
        if (tool && endpoint) {
          try {
            result = await callMcpTool(endpoint, tool.name, request.arguments);
          } catch (error) {
            result = error instanceof Error ? error.message : "MCP-Server nicht erreichbar";
          }
        }
        const note = `Werkzeug ${request.name} mit ${JSON.stringify(request.arguments)}: ${result}`;
        context = `${context}\n${note}`;
        await appendTranscript(botId, "Werkzeug", note);
        if (step === 2) {
          answer = await llmComplete(llm, basePrompt, `${context}\nAntworte jetzt nur gesprochen, ohne TOOL-Zeile.`);
        }
      }
    }
    await speak(botId, answer.slice(0, 800), false);
  } catch (error) {
    const session = await sessionForBot(botId);
    if (session) {
      await prisma.callSession.update({
        where: { id: session.id },
        data: { lastError: error instanceof Error ? error.message : "Voice-Fehler" },
      });
    }
  } finally {
    state.busy = false;
  }
}

async function flushAudio(botId: string) {
  const state = turnFor(botId);
  if (!state.pcm.length || state.busy) return;
  const pcm = Buffer.concat(state.pcm);
  state.pcm = [];
  if (pcm.length < 16000) return;
  const session = await sessionForBot(botId);
  if (!session) return;
  const llm = await readSecrets(session.booking.clone.userId, "llm");
  if (!llm?.apiKey) return;
  try {
    const text = await transcribeWav(llm, pcm16ToWav(pcm));
    if (text.trim()) await replyTo(botId, text);
  } catch (error) {
    await prisma.callSession.update({
      where: { id: session.id },
      data: { lastError: error instanceof Error ? error.message : "Transkription fehlgeschlagen" },
    });
  }
}

async function onAudio(botId: string, buffer: string) {
  await ensureDisclosure(botId);
  const state = turnFor(botId);
  state.pcm.push(Buffer.from(buffer, "base64"));
  const bytes = state.pcm.reduce((sum, chunk) => sum + chunk.length, 0);
  if (bytes >= 16000 * 2 * 3) await flushAudio(botId);
}

function textFromTranscriptEvent(data: unknown) {
  const words = (data as { words?: { text?: string }[]; participant?: { is_host?: boolean; name?: string } })?.words;
  if (!words?.length) return "";
  return words.map((word) => word.text || "").join(" ").trim();
}

async function finish(botId: string) {
  const session = await sessionForBot(botId);
  if (!session) return;
  await prisma.callSession.update({
    where: { id: session.id },
    data: { status: "ended", endedAt: new Date() },
  });
  await prisma.booking.update({ where: { id: session.bookingId }, data: { status: "ended" } });
  await enqueue("draft_offer", { bookingId: session.bookingId });
  turns.delete(botId);
}

const port = Number(process.env.VOICE_PORT || 3001);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "voice" }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ server, path: "/recall" });

wss.on("connection", (socket, request) => {
  const url = new URL(request.url || "/", appUrl());
  const secret = url.searchParams.get("secret") || request.headers["x-voice-secret"];
  if (!voiceSharedSecret() || secret !== voiceSharedSecret()) {
    socket.close(4001, "Secret fehlt");
    return;
  }
  socket.on("message", (raw: RawData) => {
    void handleMessage(raw.toString());
  });
});

async function handleMessage(raw: string) {
  let message: { event?: string; data?: { data?: { buffer?: string; words?: { text?: string }[] }; bot?: { id?: string } } };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const botId = message.data?.bot?.id;
  if (!botId) return;
  if (message.event === "audio_mixed_raw.data" && message.data?.data?.buffer) {
    await onAudio(botId, message.data.data.buffer);
    return;
  }
  if (message.event === "transcript.data") {
    const text = textFromTranscriptEvent(message.data?.data);
    if (text) await replyTo(botId, text);
    return;
  }
  if (message.event === "bot.call_ended" || message.event === "bot.done") {
    await finish(botId);
  }
}

server.listen(port, () => {
  console.log(`Voice-Dienst hört auf :${port}/recall`);
});

setInterval(() => {
  for (const botId of turns.keys()) void flushAudio(botId);
}, 4000);
