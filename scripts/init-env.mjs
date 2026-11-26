import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.cwd(), ".env");
if (existsSync(target)) {
  console.log(".env existiert bereits");
  process.exit(0);
}

const body = `DATABASE_URL=postgresql://klon:klon@localhost:5432/klon
ENCRYPTION_KEY=${randomBytes(32).toString("hex")}
SESSION_SECRET=${randomBytes(32).toString("hex")}
VOICE_SHARED_SECRET=${randomBytes(32).toString("hex")}
APP_URL=http://localhost:3000
VOICE_PORT=3001
VOICE_PUBLIC_WS_URL=ws://localhost:3001/recall
RECALL_API_BASE=https://us-west-2.recall.ai
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
DASHBOARD_PASSWORD=
`;

writeFileSync(target, body);
console.log(".env angelegt");
