export function fallbackReelCopy(briefing: string, cloneName: string) {
  const clean = briefing.replace(/\s+/g, " ").trim();
  const script = [
    `${cloneName} spricht direkt in die Kamera.`,
    clean,
    "Am Ende ein klarer nächster Schritt: Gespräch buchen.",
  ].join("\n");
  const voiceText = `Hallo, hier spricht der digitale Klon von ${cloneName}. ${clean} Wenn das zu dir passt, buche ein Gespräch.`;
  return {
    script: script.slice(0, 1200),
    voiceText: voiceText.slice(0, 900),
  };
}

export function parseReelCopy(text: string, briefing: string, cloneName: string) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return fallbackReelCopy(briefing, cloneName);
    const parsed = JSON.parse(text.slice(start, end + 1)) as { script?: string; voiceText?: string };
    if (!parsed.script || !parsed.voiceText) return fallbackReelCopy(briefing, cloneName);
    return {
      script: String(parsed.script).slice(0, 2000),
      voiceText: String(parsed.voiceText).slice(0, 1200),
    };
  } catch {
    return fallbackReelCopy(briefing, cloneName);
  }
}
