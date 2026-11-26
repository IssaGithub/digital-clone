import type { CatalogItem } from "./offers.js";

export const DEFAULT_DISCLOSURE =
  "Hinweis: In diesem Gespräch spricht ein digitaler Klon und keine natürliche Person.";

export function cloneSystemPrompt(input: {
  name: string;
  knowledge: string;
  items: CatalogItem[];
}) {
  const prices = input.items
    .map((item) => `- ${item.name}: ${(item.unitPriceCents / 100).toFixed(2)} ${item.currency} netto je ${item.unit}`)
    .join("\n");
  return [
    `Du bist der digitale Klon von ${input.name}.`,
    "Sprich Deutsch, kurz und konkret.",
    "Der Hinweis, dass ein digitaler Klon spricht, wurde zu Beginn bereits gesprochen.",
    "Nenne nur Leistungen aus der Preisliste. Erfinde keine Preise und keine zusätzlichen Produkte.",
    "Wenn etwas nicht in der Liste steht, sag das und lass es offen.",
    "",
    "Wissen:",
    input.knowledge || "(keines hinterlegt)",
    "",
    "Preisliste:",
    prices || "(leer)",
  ].join("\n");
}
