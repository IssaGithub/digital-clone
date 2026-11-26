import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseInviteeCreated, verifyCalendlySignature } from "./calendly.js";
import { parseRpcMessage, readToolRequest, toolAlias } from "./mcp.js";
import { decryptJson, deriveUserKey, encryptJson } from "./crypto.js";
import { buildQuotationBody, canFinalize, linesFromModel, linesFromTranscript } from "./offers.js";

const items = [
  {
    id: "p1",
    name: "Workshop",
    description: "Halber Tag",
    unit: "Tag",
    unitPriceCents: 120000,
    taxPercent: 19,
    currency: "EUR",
  },
];

test("Calendly-Signatur akzeptiert einen frischen HMAC", () => {
  const body = "{\"event\":\"invitee.created\"}";
  const timestamp = "1700000000";
  const signature = createHmac("sha256", "geheim").update(`${timestamp}.${body}`).digest("hex");
  assert.equal(
    verifyCalendlySignature(body, `t=${timestamp},v1=${signature}`, "geheim", 1700000000 * 1000),
    true,
  );
  assert.equal(verifyCalendlySignature(body, `t=${timestamp},v1=${signature}`, "falsch", 1700000000 * 1000), false);
});

test("invitee.created liest Meet- und Teams-Join-Links", () => {
  const meet = parseInviteeCreated({
    event: "invitee.created",
    payload: {
      name: "Ada",
      email: "ada@example.com",
      scheduled_event: {
        uri: "evt-1",
        start_time: "2026-12-01T10:00:00Z",
        event_type: "type-1",
        location: { type: "google_conference", join_url: "https://meet.google.com/abc-defg-hij" },
      },
    },
  });
  assert.equal(meet?.locationType, "google_conference");
  assert.equal(meet?.joinUrl, "https://meet.google.com/abc-defg-hij");

  const teams = parseInviteeCreated({
    event: "invitee.created",
    payload: {
      email: "ada@example.com",
      scheduled_event: {
        start_time: "2026-12-01T10:00:00Z",
        location: { type: "microsoft_teams_conference", join_url: "https://teams.microsoft.com/l/meetup-join/1" },
      },
    },
  });
  assert.equal(teams?.locationType, "microsoft_teams");
});

test("Preise kommen nur aus der Preisliste, unklare Posten blockieren", () => {
  const transcript = "Wir brauchen 2 Workshop. Außerdem noch ein Extra-Podcast.";
  const lines = linesFromTranscript(transcript, items);
  const workshop = lines.find((line) => line.priceItemId === "p1");
  assert.equal(workshop?.unitPriceCents, 120000);
  assert.equal(workshop?.quantity, 2);
  assert.equal(lines.some((line) => line.unclear), true);
  assert.equal(canFinalize(lines), false);

  const fromModel = linesFromModel(
    [
      { label: "Workshop", quantity: 3, priceItemId: "p1" },
      { label: "Geheimprodukt", quantity: 1, priceItemId: "nein" },
    ],
    items,
    transcript,
  );
  assert.equal(fromModel[0].unitPriceCents, 120000);
  assert.equal(fromModel[1].unclear, true);
  assert.equal(fromModel[1].unitPriceCents, null);

  const body = buildQuotationBody({
    customerName: "Ada",
    lines: fromModel,
    voucherDate: "2026-11-26",
    finalize: false,
  });
  assert.equal(body.finalize, false);
  assert.equal(body.lineItems.length, 1);
  assert.equal(body.lineItems[0].name, "Workshop");
  assert.equal(body.lineItems[0].unitPrice.netAmount, 1200);
});

test("MCP-Antwort und Werkzeugaufruf lassen sich lesen", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":"tools/list","result":{"tools":[]}}\n';
  assert.deepEqual(parseRpcMessage(sse), { jsonrpc: "2.0", id: "tools/list", result: { tools: [] } });
  assert.equal(toolAlias("Lager", "bestand-prüfen"), "lager__bestand_pr_fen");
  assert.deepEqual(readToolRequest('TOOL {"name":"lager__bestand","arguments":{"sku":"1"}}'), {
    name: "lager__bestand",
    arguments: { sku: "1" },
  });
  assert.equal(readToolRequest("Guten Tag."), null);
});

test("Secrets sind pro Nutzer-Schlüssel nicht mit einem fremden Salz lesbar", () => {
  const key = deriveUserKey("master-key-zum-testen", "salt-a");
  const payload = encryptJson(key, { apiKey: "lex-123" });
  assert.equal(decryptJson(key, payload).apiKey, "lex-123");
  assert.throws(() => decryptJson(deriveUserKey("master-key-zum-testen", "salt-b"), payload));
});
