export type CatalogItem = {
  id: string;
  name: string;
  description: string;
  unit: string;
  unitPriceCents: number;
  taxPercent: number;
  currency: string;
};

export type DraftLine = {
  id: string;
  label: string;
  description: string;
  quantity: number;
  priceItemId: string | null;
  unitPriceCents: number | null;
  unit: string | null;
  currency: string;
  taxPercent: number | null;
  unclear: boolean;
  reason: string;
  dropped: boolean;
};

export type LlmLine = {
  label?: string;
  quantity?: number;
  priceItemId?: string | null;
};

const HINT = /(stunde|paket|lizenz|modul|workshop|beratung|seite|video|artikel|zusätzlich|noch |außerdem|extra|leistung)/i;

function quantityOf(value: number | undefined, fallbackWindow?: string) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100000) {
    return Math.round(value * 100) / 100;
  }
  if (!fallbackWindow) return 1;
  const match = fallbackWindow.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return 1;
  const parsed = Number(match[1].replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) return 1;
  return Math.round(parsed * 100) / 100;
}

function matchedLine(item: CatalogItem, quantity: number, index: number): DraftLine {
  return {
    id: `line-${index}`,
    label: item.name,
    description: item.description,
    quantity,
    priceItemId: item.id,
    unitPriceCents: item.unitPriceCents,
    unit: item.unit,
    currency: item.currency,
    taxPercent: item.taxPercent,
    unclear: false,
    reason: "",
    dropped: false,
  };
}

function unclearLine(label: string, reason: string, index: number): DraftLine {
  return {
    id: `line-${index}`,
    label: label.slice(0, 240),
    description: "",
    quantity: 1,
    priceItemId: null,
    unitPriceCents: null,
    unit: null,
    currency: "EUR",
    taxPercent: null,
    unclear: true,
    reason,
    dropped: false,
  };
}

function findItem(items: CatalogItem[], line: LlmLine) {
  if (line.priceItemId) {
    const byId = items.find((item) => item.id === line.priceItemId);
    if (byId) return byId;
  }
  const label = (line.label || "").trim().toLowerCase();
  if (!label) return null;
  return (
    items.find((item) => item.name.toLowerCase() === label) ||
    items.find((item) => label.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(label)) ||
    null
  );
}

export function linesFromTranscript(transcript: string, items: CatalogItem[]): DraftLine[] {
  const active = items.filter((item) => item.name.trim().length > 1);
  const lines: DraftLine[] = [];
  const lower = transcript.toLowerCase();
  for (const item of active) {
    const index = lower.indexOf(item.name.toLowerCase());
    if (index < 0) continue;
    const window = transcript.slice(Math.max(0, index - 32), index + item.name.length + 32);
    lines.push(matchedLine(item, quantityOf(undefined, window), lines.length));
  }
  const known = active.map((item) => item.name.toLowerCase());
  for (const sentence of transcript.split(/[.\n!?]+/)) {
    const text = sentence.trim();
    if (text.length < 8) continue;
    if (known.some((name) => text.toLowerCase().includes(name))) continue;
    if (!HINT.test(text)) continue;
    lines.push(unclearLine(text, "Keine Position in der Preisliste", lines.length));
    if (lines.length >= 12) break;
  }
  if (lines.length === 0) {
    lines.push(unclearLine("Gespräch ohne zuordenbare Leistung", "Keine Position in der Preisliste", 0));
  }
  return lines;
}

export function linesFromModel(raw: LlmLine[], items: CatalogItem[], transcript: string): DraftLine[] {
  if (!raw.length) return linesFromTranscript(transcript, items);
  const lines: DraftLine[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = findItem(items, entry);
    if (item) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      lines.push(matchedLine(item, quantityOf(entry.quantity), lines.length));
      continue;
    }
    const label = (entry.label || "").trim();
    if (!label) continue;
    lines.push(unclearLine(label, "Keine Position in der Preisliste. Preis wurde verworfen.", lines.length));
  }
  if (!lines.length) return linesFromTranscript(transcript, items);
  return lines;
}

export function hasBlockingUnclear(lines: DraftLine[]) {
  return lines.some((line) => line.unclear && !line.dropped);
}

export function canFinalize(lines: DraftLine[]) {
  const billable = lines.filter((line) => !line.unclear && !line.dropped && line.priceItemId && line.unitPriceCents != null);
  return billable.length > 0 && !hasBlockingUnclear(lines);
}

export function billableLines(lines: DraftLine[]) {
  return lines.filter((line) => !line.unclear && !line.dropped && line.priceItemId && line.unitPriceCents != null);
}

export function buildQuotationBody(input: {
  customerName: string;
  lines: DraftLine[];
  voucherDate: string;
  finalize: boolean;
}) {
  const billable = billableLines(input.lines);
  return {
    voucherDate: input.voucherDate,
    address: {
      name: input.customerName,
      countryCode: "DE",
    },
    lineItems: billable.map((line) => ({
      type: "custom",
      name: line.label,
      description: line.description,
      quantity: line.quantity,
      unitName: line.unit || "Stück",
      unitPrice: {
        currency: line.currency || "EUR",
        netAmount: Number(((line.unitPriceCents || 0) / 100).toFixed(2)),
        taxRatePercentage: line.taxPercent ?? 19,
      },
    })),
    taxConditions: { taxType: "net" },
    title: "Angebot",
    introduction: "Angebot nach dem Gespräch mit dem digitalen Klon.",
    remark: input.finalize
      ? "Im Dashboard freigegeben."
      : "Entwurf. Unklare Posten sind nicht enthalten und werden nicht finalisiert.",
    finalize: input.finalize,
  };
}
