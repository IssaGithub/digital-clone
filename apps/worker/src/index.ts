import { loadEnv } from "@klon/core";
import { processNextJob } from "@klon/domain";

loadEnv();

async function loop() {
  try {
    const worked = await processNextJob();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  void loop();
}

console.log("Worker für Bot-Start, Angebotsentwurf und Video-Render läuft.");
void loop();
