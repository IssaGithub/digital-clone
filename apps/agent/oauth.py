import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

AUTHORIZE = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
USERINFO = "https://auth.openai.com/api/accounts/oauth/userinfo"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PENDING: dict[str, dict[str, str]] = {}


def load_env_files():
    roots = [
        Path("/opt/klon-plattform/agent.env"),
        Path("/opt/klon-plattform/.env"),
        Path(__file__).resolve().parents[2] / ".env",
    ]
    for path in roots:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            if not line or line.strip().startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def env_path() -> Path:
    server = Path("/opt/klon-plattform/agent.env")
    if server.is_file():
        return server
    return Path(__file__).resolve().parents[2] / ".env"


def remember(key: str, value: str):
    path = env_path()
    lines = path.read_text().splitlines() if path.is_file() else []
    found = False
    out = []
    for line in lines:
        if line.startswith(key + "="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n")
    os.chmod(path, 0o600)
    os.environ[key] = value


def host_id() -> str:
    current = os.environ.get("OPENAI_AGENT_HOST_ID", "")
    if current:
        return current
    value = "urn:uuid:" + secrets.token_hex(16)
    remember("OPENAI_AGENT_HOST_ID", value)
    return value


def client_id() -> str:
    return os.environ.get("OPENAI_OAUTH_CLIENT_ID") or "dynamic_agent_client"


def redirect_uri() -> str:
    return os.environ.get("OPENAI_REDIRECT_URI", "http://127.0.0.1:4010/auth/callback")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def derive_key(master: str, salt: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt.encode(),
        info=b"klon-connection",
    ).derive(master.encode())


def encrypt(master: str, salt: str, payload: dict) -> str:
    key = derive_key(master, salt)
    iv = secrets.token_bytes(12)
    blob = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), None)
    tag, body = blob[-16:], blob[:-16]
    return b64url(iv + tag + body)


def decrypt(master: str, salt: str, payload: str) -> dict:
    raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
    iv, tag, body = raw[:12], raw[12:28], raw[28:]
    text = AESGCM(derive_key(master, salt)).decrypt(iv, body + tag, None)
    return json.loads(text)


def connect():
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL fehlt")
    return psycopg.connect(url)


def login_url() -> str:
    state = secrets.token_urlsafe(24)
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    nonce = secrets.token_urlsafe(18)
    PENDING[state] = {"verifier": verifier, "nonce": nonce, "exp": str(time.time() + 600)}
    query = {
        "client_id": client_id(),
        "agent_name_hint": "Klon Plattform",
        "ext_agent_host_id": host_id(),
        "response_type": "code",
        "redirect_uri": redirect_uri(),
        "scope": SCOPES,
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    return AUTHORIZE + "?" + urlencode(query)


def exchange_code(state: str, code: str, issued_client: str) -> dict:
    pending = PENDING.pop(state, None)
    if not pending or float(pending["exp"]) < time.time():
        raise RuntimeError("Anmeldung abgelaufen")
    used = issued_client or client_id()
    if issued_client and issued_client != "dynamic_agent_client":
        remember("OPENAI_OAUTH_CLIENT_ID", issued_client)
    response = httpx.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": used,
            "code": code,
            "redirect_uri": redirect_uri(),
            "code_verifier": pending["verifier"],
            "resource": RESOURCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    body = response.json()
    body["_nonce"] = pending["nonce"]
    body["_client"] = used
    return body


def refresh(refresh_token: str) -> dict:
    response = httpx.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "client_id": client_id(),
            "refresh_token": refresh_token,
            "resource": RESOURCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def identity(access_token: str) -> dict:
    response = httpx.get(USERINFO, headers={"Authorization": f"Bearer {access_token}"}, timeout=20)
    if response.status_code >= 400:
        return {}
    return response.json()


def save_grant(access_token: str, refresh_token: str, expires_in: int, email: str, name: str, subject: str):
    master = os.environ.get("ENCRYPTION_KEY", "")
    if not master:
        raise RuntimeError("ENCRYPTION_KEY fehlt")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + int(expires_in or 3600)))
    bag = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires,
        "accountEmail": email,
        "mode": "oauth-access-token",
    }
    with connect() as db:
        row = db.execute('SELECT id, "encryptionSalt" FROM "User" WHERE email = %s', (email or subject,)).fetchone()
        if row:
            user_id, salt = row
        else:
            user_id = "c" + secrets.token_hex(12)
            salt = b64url(secrets.token_bytes(16))
            db.execute(
                'INSERT INTO "User" (id, email, name, "encryptionSalt", "createdAt") VALUES (%s, %s, %s, %s, NOW())',
                (user_id, email or subject, name or email or "OpenAI", salt),
            )
        secret = encrypt(master, salt, bag)
        db.execute(
            """
            INSERT INTO "Connection" (id, "userId", provider, "encryptedPayload", "accountLabel", connected, "updatedAt")
            VALUES (%s, %s, 'openai', %s, %s, TRUE, NOW())
            ON CONFLICT ("userId", provider)
            DO UPDATE SET "encryptedPayload" = EXCLUDED."encryptedPayload", "accountLabel" = EXCLUDED."accountLabel",
                          connected = TRUE, "updatedAt" = NOW()
            """,
            ("c" + secrets.token_hex(12), user_id, secret, email or "OpenAI",),
        )
        db.commit()


def bearer() -> tuple[str, str]:
    """Returns (token, source) where source is oauth, env or empty."""
    master = os.environ.get("ENCRYPTION_KEY", "")
    if master and os.environ.get("DATABASE_URL"):
        try:
            with connect() as db:
                row = db.execute(
                    """
                    SELECT u."encryptionSalt", c."encryptedPayload"
                    FROM "Connection" c JOIN "User" u ON u.id = c."userId"
                    WHERE c.provider = 'openai' AND c.connected = TRUE
                    ORDER BY c."updatedAt" DESC LIMIT 1
                    """
                ).fetchone()
            if row:
                bag = decrypt(master, row[0], row[1])
                token = bag.get("accessToken") or ""
                refresh_token = bag.get("refreshToken") or ""
                expires = bag.get("expiresAt") or ""
                if expires and expires < time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60)) and refresh_token:
                    fresh = refresh(refresh_token)
                    token = fresh.get("access_token") or token
                    save_grant(
                        token,
                        fresh.get("refresh_token") or refresh_token,
                        int(fresh.get("expires_in") or 3600),
                        bag.get("accountEmail") or "",
                        "",
                        bag.get("accountEmail") or "openai",
                    )
                if token:
                    return token, "oauth"
        except Exception:
            pass
    env_key = os.environ.get("OPENAI_API_KEY", "")
    if env_key:
        return env_key, "env"
    return "", ""


def speech_view() -> dict:
    token, source = bearer()
    if source == "oauth":
        detail = "angemeldet"
    elif source == "env":
        detail = "Fallback aus der Umgebung"
    else:
        detail = "fehlender Anschluss"
    return {
        "provider": "openai",
        "label": "OpenAI Sprache",
        "purpose": "STT und TTS",
        "connected": bool(token),
        "detail": detail,
        "login": "/openai/login",
    }
