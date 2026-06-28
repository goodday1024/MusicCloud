import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import OpenAI from "openai";
import NeteaseCloudMusicApi from "NeteaseCloudMusicApi";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { get, put } from "@vercel/blob";

const require = createRequire(import.meta.url);
const qqMusicApi = require("qq-music-api");
const qqLoginQr = require("qq-login-qr");
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isVercel = Boolean(process.env.VERCEL);
const runtimeDir = process.env.AGENTIO_RUNTIME_DIR || (isVercel ? "/tmp/agentio" : __dirname);
const uploadDir = path.join(runtimeDir, "uploads");
const generatedDir = path.join(runtimeDir, "generated");
const dataDir = path.join(runtimeDir, "data");
const memoryFile = path.join(dataDir, "memory.json");
const ffmpegBin = process.env.FFMPEG_PATH || ffmpegInstaller.path || "ffmpeg";
const ffprobeBin = process.env.FFPROBE_PATH || ffprobeInstaller.path || "ffprobe";
const musicApiBaseUrl = process.env.MUSIC_API_BASE_URL?.replace(/\/$/, "") || "";
const wpMusicApiBaseUrl = process.env.WP_MUSIC_API_BASE_URL?.replace(/\/$/, "") || "";
const qqMusicApi1BaseUrl = process.env.QQMUSIC_API1_BASE_URL?.replace(/\/$/, "") || "http://49.51.189.172:8000";
const qqMusicCharlesMusicdlFallbackEnabled = !/^(0|false|no)$/i.test(process.env.QQMUSIC_CHARLES_MUSICDL_FALLBACK || "true");
const qqMusicCharlesMusicdlFallbackApis = (process.env.QQMUSIC_CHARLES_MUSICDL_APIS || "nki,tang,xunhuisi,lpz,lxmusic,vkeys")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const qqMusicThirdPartyKeys = {
  nki: (process.env.QQMUSIC_NKI_API_KEYS || "").split(",").map((item) => item.trim()).filter(Boolean),
  xianyuw: (process.env.QQMUSIC_XIANYUW_API_KEYS || "").split(",").map((item) => item.trim()).filter(Boolean),
  cy: (process.env.QQMUSIC_CY_API_KEYS || "").split(",").map((item) => item.trim()).filter(Boolean)
};
const localMusicApiDir = process.env.LOCAL_MUSIC_API_DIR || "/Users/zhangzihang/music-api";
const defaultMusicPlatform = process.env.MUSIC_API_DEFAULT_PLATFORM || "netease";
const musicPlatforms = (process.env.MUSIC_API_PLATFORMS || "kugou,qq,netease,kuwo")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const neteaseApiBaseUrl = process.env.NETEASE_API_BASE_URL?.replace(/\/$/, "") || "";
const neteaseStateFile = path.join(dataDir, "netease.json");
const qqMusicStateFile = path.join(dataDir, "qqmusic.json");
const inviteCodesFile = path.join(dataDir, "invite-codes.json");
const usersFile = path.join(dataDir, "users.json");
const roomsFile = path.join(dataDir, "together-rooms.json");
const persistentJsonPrefix = process.env.AGENTIO_BLOB_STATE_PREFIX || "agentio/state";
const qqMusicQrAppId = process.env.QQMUSIC_QR_APPID || "716027609";
const qqMusicQrCallback = process.env.QQMUSIC_QR_CALLBACK || "https://y.qq.com/portal/profile.html";
const qqMusicQrConfigs = [
  { appid: qqMusicQrAppId, callback: qqMusicQrCallback, label: "QQ 音乐网页登录" },
  { appid: "549000912", callback: "https://qzs.qq.com/qzone/v5/loginsucc.html?para=izone", label: "通用 QQ 扫码" }
].filter((item, index, list) => item.appid && item.callback && list.findIndex((entry) => entry.appid === item.appid && entry.callback === item.callback) === index);
const narrationLeadInSeconds = 0.18;
const requestWindows = new Map();
let blobPersistenceDisabledReason = "";
const browserCookieName = "agentio_netease_cookie";
const qqBrowserCookieName = "caelumshao_qqmusic_cookie";

function clampInt(value, min, max, fallback = min) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

const maxLibraryPlaylists = clampInt(process.env.MUSIC_LIBRARY_MAX_PLAYLISTS, 4, 80, 24);
const maxLibraryTracksPerPlaylist = clampInt(process.env.MUSIC_LIBRARY_MAX_TRACKS_PER_PLAYLIST, 20, 500, 120);
const libraryPlaylistConcurrency = clampInt(process.env.MUSIC_LIBRARY_PLAYLIST_CONCURRENCY, 1, 8, 3);

function cleanText(value, maxLen = 240) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxLen);
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), list.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }));
  return results;
}

function sanitizeVoice(value) {
  return cleanText(value, 48).replace(/[^a-z0-9_-]/gi, "") || "alloy";
}

function rateLimit({ key, limit = 25, windowMs = 60_000 }) {
  const now = Date.now();
  const bucket = requestWindows.get(key) || [];
  const fresh = bucket.filter((timestamp) => now - timestamp < windowMs);
  if (fresh.length >= limit) return false;
  fresh.push(now);
  requestWindows.set(key, fresh);
  return true;
}

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  const headerLength = length < 126 ? 6 : length < 65536 ? 8 : 14;
  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x81;
  if (length < 126) {
    frame[1] = 0x80 | length;
    crypto.randomBytes(4).copy(frame, 2);
    for (let index = 0; index < length; index += 1) frame[6 + index] = payload[index] ^ frame[2 + (index % 4)];
    return frame;
  }
  if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
    crypto.randomBytes(4).copy(frame, 4);
    for (let index = 0; index < length; index += 1) frame[8 + index] = payload[index] ^ frame[4 + (index % 4)];
    return frame;
  }
  frame[1] = 0x80 | 127;
  frame.writeBigUInt64BE(BigInt(length), 2);
  crypto.randomBytes(4).copy(frame, 10);
  for (let index = 0; index < length; index += 1) frame[14 + index] = payload[index] ^ frame[10 + (index % 4)];
  return frame;
}

function extractRealtimeText(event) {
  const type = event?.type || "";
  if (type === "response.text.delta" || type === "response.output_text.delta" || type === "response.audio_transcript.delta") {
    return event.delta || "";
  }
  if (type === "response.text.done" || type === "response.output_text.done" || type === "response.audio_transcript.done") {
    return event.text || event.transcript || "";
  }
  if (type === "response.output_item.done") {
    return (event.item?.content || [])
      .map((part) => part.text || part.transcript || "")
      .filter(Boolean)
      .join("");
  }
  if (type === "response.done") {
    return (event.response?.output || [])
      .flatMap((item) => item.content || [])
      .map((part) => part.text || part.transcript || "")
      .filter(Boolean)
      .join("");
  }
  return "";
}

async function createRealtimePodcastText({ wsUrl, apiKey, instructions, timeoutMs = 24000 }) {
  const target = new URL(wsUrl);
  const secure = target.protocol === "wss:";
  const port = Number(target.port || (secure ? 443 : 80));
  const host = target.hostname;
  const pathWithSearch = `${target.pathname || "/"}${target.search || ""}`;
  const key = crypto.randomBytes(16).toString("base64");
  const socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let handshakeComplete = false;
    let buffer = Buffer.alloc(0);
    let output = "";
    let fragments = [];
    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(cleanText(value || output, 2200));
    };
    const timer = setTimeout(() => finish(new Error("Realtime WebSocket 连接超时")), timeoutMs);

    const sendHandshake = () => {
      socket.write([
        `GET ${pathWithSearch} HTTP/1.1`,
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Authorization: Bearer ${apiKey}`,
        "OpenAI-Beta: realtime=v1",
        "\r\n"
      ].join("\r\n"));
    };

    if (secure) socket.once("secureConnect", sendHandshake);
    else socket.once("connect", sendHandshake);

    socket.on("error", (error) => finish(new Error(`Realtime WebSocket 连接失败：${error.message}`)));
    socket.on("end", () => {
      if (!settled && output) finish(null, output);
      else if (!settled) finish(new Error("Realtime WebSocket 连接已关闭"));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeComplete) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const head = buffer.slice(0, split).toString("utf8");
        buffer = buffer.slice(split + 4);
        if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
          finish(new Error(`Realtime WebSocket 握手失败：${head.split("\r\n")[0] || "未知响应"}`));
          return;
        }
        handshakeComplete = true;
        socket.write(encodeWebSocketFrame(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text"],
            instructions
          }
        })));
      }

      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const fin = Boolean(first & 0x80);
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          const bigLength = buffer.readBigUInt64BE(offset);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            finish(new Error("Realtime WebSocket 消息过大"));
            return;
          }
          length = Number(bigLength);
          offset += 8;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        let payload = buffer.slice(offset, offset + length);
        if (masked) {
          const mask = buffer.slice(maskOffset, maskOffset + 4);
          payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
        }
        buffer = buffer.slice(offset + length);

        if (opcode === 0x8) {
          if (output) finish(null, output);
          else finish(new Error("Realtime WebSocket 被服务端关闭"));
          return;
        }
        if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (opcode !== 0x1 && opcode !== 0x0) continue;
        fragments.push(payload);
        if (!fin) continue;
        const message = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        let event;
        try {
          event = JSON.parse(message);
        } catch (_error) {
          continue;
        }
        if (event.type === "error") {
          finish(new Error(event.error?.message || "Realtime 返回错误"));
          return;
        }
        const eventText = extractRealtimeText(event);
        if (event.type === "response.done" && output) {
          // Delta events usually already contain the full answer; avoid appending
          // the final aggregate again when relays include it on response.done.
        } else {
          output += eventText;
        }
        if (event.type === "response.done") {
          finish(null, output);
          return;
        }
      }
    });
  });
}

function buildRealtimeWebSocketUrls(baseUrl, model) {
  const base = new URL(baseUrl);
  const pathname = base.pathname.replace(/\/$/, "");
  const query = `model=${encodeURIComponent(model)}`;
  const candidates = [];
  const add = (protocol) => {
    const url = `${protocol}//${base.host}${pathname}/realtime?${query}`;
    if (!candidates.includes(url)) candidates.push(url);
  };
  if (process.env.OPENAI_REALTIME_WS_URL) {
    candidates.push(process.env.OPENAI_REALTIME_WS_URL.replace(/\{model\}/g, encodeURIComponent(model)));
  }
  if (base.hostname === "yunwu.ai") add("ws:");
  add(base.protocol === "http:" ? "ws:" : "wss:");
  add(base.protocol === "http:" ? "wss:" : "ws:");
  return candidates;
}

await Promise.all([mkdir(uploadDir, { recursive: true }), mkdir(generatedDir, { recursive: true }), mkdir(dataDir, { recursive: true })]);

const app = express();
app.disable("x-powered-by");
const upload = multer({ dest: uploadDir, limits: { fileSize: 80 * 1024 * 1024 } });
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing-key",
  baseURL: process.env.OPENAI_BASE_URL || undefined
});
const ttsOpenai = new OpenAI({
  apiKey: process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY || "missing-key",
  baseURL: process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || undefined
});
const neteaseApi = NeteaseCloudMusicApi;
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const configuredRealtimeBaseUrl = (process.env.OPENAI_REALTIME_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
const realtimeBaseUrl = /^https?:\/\//i.test(configuredRealtimeBaseUrl)
  ? configuredRealtimeBaseUrl.replace(/\/$/, "")
  : "https://api.openai.com/v1";
const realtimeApiKey = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || "";
const realtimeDirectSdp = !/^(0|false|no)$/i.test(process.env.OPENAI_REALTIME_DIRECT_SDP || (realtimeBaseUrl.includes("api.openai.com") ? "false" : "true"));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(
  cors(
    process.env.CORS_ORIGIN
      ? { origin: process.env.CORS_ORIGIN.split(",").map((item) => item.trim()).filter(Boolean), credentials: true }
      : {
          origin: [
            /^http:\/\/localhost:517\d$/,
            /^http:\/\/127\.0\.0\.1:517\d$/,
            "https://zihang.fun",
            "https://www.zihang.fun",
            "file://"
          ],
          credentials: true
        }
  )
);
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(generatedDir));
app.get("/media/blob/*", async (req, res, next) => {
  try {
    const pathname = decodeURIComponent(String(req.params?.[0] || ""));
    if (!pathname || pathname.includes("..")) {
      res.status(404).end();
      return;
    }
    const result = await get(pathname, { access: "private", useCache: true });
    if (result.statusCode !== 200 || !result.stream) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", result.blob.contentType || "audio/mpeg");
    res.setHeader("Cache-Control", result.blob.cacheControl || "public, max-age=31536000, immutable");
    if (result.blob.size) res.setHeader("Content-Length", String(result.blob.size));
    Readable.fromWeb(result.stream).pipe(res);
  } catch (error) {
    next(error);
  }
});

const defaultMemory = {
  profile: {
    favoriteScenes: [],
    musicTaste: [],
    narrationStyle: "温柔、短句、像深夜电台，但不过度煽情",
    voice: process.env.OPENAI_TTS_VOICE || "alloy"
  },
  sessions: []
};

function cookieListFromEnv(value) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRequestCookies(req) {
  return Object.fromEntries(
    String(req?.headers?.cookie || "")
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        if (index === -1) return [pair, ""];
        return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))];
      })
  );
}

function cookieListFromRequest(req) {
  return cookieListFromEnv(parseRequestCookies(req)[browserCookieName]);
}

function qqCookieListFromRequest(req) {
  return cookieListFromEnv(parseRequestCookies(req)[qqBrowserCookieName]);
}

function setBrowserNeteaseCookie(res, cookies = []) {
  const value = normalizeCookieList(cookies).join("; ");
  if (!value) return;
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${browserCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
}

function setBrowserQQMusicCookie(res, cookies = []) {
  const value = normalizeCookieList(cookies).join("; ");
  if (!value) return;
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : "";
  res.append?.(
    "Set-Cookie",
    `${qqBrowserCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
  if (!res.append) {
    res.setHeader(
      "Set-Cookie",
      `${qqBrowserCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
    );
  }
}

function clearBrowserNeteaseCookie(res) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${browserCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function clearBrowserQQMusicCookie(res) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : "";
  res.append?.("Set-Cookie", `${qqBrowserCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  if (!res.append) {
    res.setHeader("Set-Cookie", `${qqBrowserCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  }
}

async function readMemory() {
  if (!existsSync(memoryFile)) return defaultMemory;
  try {
    const raw = await readFile(memoryFile, "utf8");
    return { ...defaultMemory, ...JSON.parse(raw) };
  } catch (error) {
    console.warn("readMemory failed, using default:", error.message);
    return defaultMemory;
  }
}

async function saveMemory(memory) {
  await writeFile(memoryFile, JSON.stringify(memory, null, 2), "utf8");
}

async function readNeteaseState(req) {
  const envCookies = cookieListFromEnv(process.env.NETEASE_COOKIE);
  const requestCookies = cookieListFromRequest(req);
  const initialCookies = requestCookies.length ? requestCookies : envCookies;
  const envState = {
    cookies: initialCookies,
    uid: "",
    profile: null,
    qrKey: "",
    qrImg: "",
    loggedIn: Boolean(initialCookies.length)
  };
  if (!existsSync(neteaseStateFile)) {
    return envState;
  }
  const raw = await readFile(neteaseStateFile, "utf8");
  const state = JSON.parse(raw);
  if (requestCookies.length) {
    return { ...state, cookies: requestCookies, loggedIn: true };
  }
  if (!state.cookies?.length && envCookies.length) {
    return { ...state, cookies: envCookies, loggedIn: true };
  }
  return state;
}

async function saveNeteaseState(state) {
  await writeFile(neteaseStateFile, JSON.stringify(state, null, 2), "utf8");
}

async function readQQMusicState(req) {
  const envCookies = cookieListFromEnv(process.env.QQMUSIC_COOKIE);
  const requestCookies = qqCookieListFromRequest(req);
  const initialCookies = requestCookies.length ? requestCookies : envCookies;
  const envState = {
    cookies: initialCookies,
    uin: cookieObjectFromList(initialCookies).uin || "",
    profile: null,
    loggedIn: Boolean(initialCookies.length),
    updatedAt: ""
  };
  if (!existsSync(qqMusicStateFile)) {
    return envState;
  }
  const raw = await readFile(qqMusicStateFile, "utf8");
  const state = JSON.parse(raw);
  if (requestCookies.length) {
    return {
      ...state,
      cookies: requestCookies,
      uin: cookieObjectFromList(requestCookies).uin || state.uin || "",
      loggedIn: true
    };
  }
  if (!state.cookies?.length && envCookies.length) {
    return {
      ...state,
      cookies: envCookies,
      uin: cookieObjectFromList(envCookies).uin || state.uin || "",
      loggedIn: true
    };
  }
  return state;
}

async function saveQQMusicState(state) {
  await writeFile(qqMusicStateFile, JSON.stringify(state, null, 2), "utf8");
}

function normalizeInviteCodes(codes = []) {
  return [...new Set((Array.isArray(codes) ? codes : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function shouldUsePersistentBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && !blobPersistenceDisabledReason);
}

function isBlobStoreSuspendedError(error) {
  return /store has been suspended|suspended/i.test(String(error?.message || error?.name || error || ""));
}

function disableBlobPersistence(error) {
  blobPersistenceDisabledReason = error?.message || String(error || "Vercel Blob unavailable");
  console.warn("Vercel Blob persistence disabled for this process:", blobPersistenceDisabledReason);
}

async function readPersistentJson(filePath, blobName, fallback) {
  if (shouldUsePersistentBlob()) {
    try {
      const result = await get(`${persistentJsonPrefix}/${blobName}`, { access: "private", useCache: false });
      if (!result?.stream) return fallback;
      const text = await new Response(result.stream).text();
      return text ? JSON.parse(text) : fallback;
    } catch (error) {
      if (isBlobStoreSuspendedError(error)) disableBlobPersistence(error);
      if (!/not found|404|BlobNotFound/i.test(error?.message || error?.name || "")) {
        console.warn(`readPersistentJson blob failed for ${blobName}:`, error?.message || error);
      }
      if (existsSync(filePath)) {
        try {
          return JSON.parse(await readFile(filePath, "utf8"));
        } catch (_localError) {
          return fallback;
        }
      }
      return fallback;
    }
  }
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writePersistentJson(filePath, blobName, payload) {
  const text = JSON.stringify(payload, null, 2);
  await writeFile(filePath, text, "utf8").catch((error) => {
    console.warn(`writePersistentJson local failed for ${blobName}:`, error?.message || error);
  });
  if (shouldUsePersistentBlob()) {
    try {
      await put(`${persistentJsonPrefix}/${blobName}`, text, {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true
      });
    } catch (error) {
      if (isBlobStoreSuspendedError(error)) {
        disableBlobPersistence(error);
        return;
      }
      throw error;
    }
  }
}

function normalizeInviteEntry(entry = {}) {
  if (typeof entry === "string") {
    return { code: entry.trim(), createdAt: "", usedAt: "", deviceId: "", userId: "", purpose: "" };
  }
  return {
    code: String(entry.code || "").trim(),
    createdAt: String(entry.createdAt || ""),
    usedAt: String(entry.usedAt || ""),
    deviceId: String(entry.deviceId || ""),
    userId: String(entry.userId || ""),
    purpose: String(entry.purpose || "")
  };
}

async function readInviteCodes() {
  try {
    const payload = await readPersistentJson(inviteCodesFile, "invite-codes.json", { codes: [] });
    const entries = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.codes)
        ? payload.codes
        : [];
    return entries.map(normalizeInviteEntry).filter((item) => item.code);
  } catch (error) {
    console.warn("readInviteCodes failed, using empty list:", error.message);
    return [];
  }
}

async function saveInviteCodes(codes = []) {
  const nextCodes = normalizeInviteCodes(codes);
  const current = await readInviteCodes();
  const currentMap = new Map(current.map((entry) => [entry.code, entry]));
  for (const code of nextCodes) {
    const existing = currentMap.get(code);
    if (existing) continue;
    currentMap.set(code, { code, createdAt: new Date().toISOString(), usedAt: "" });
  }
  const merged = [...currentMap.values()];
  await writePersistentJson(inviteCodesFile, "invite-codes.json", { updatedAt: new Date().toISOString(), codes: merged });
  return merged;
}

async function consumeInviteCode(code = "", meta = {}) {
  const target = String(code || "").trim();
  if (!target) return { ok: false, reason: "empty" };
  const entries = await readInviteCodes();
  const deviceId = cleanText(meta.deviceId, 120);
  const existing = entries.find((entry) => entry.code === target && entry.usedAt && entry.deviceId && entry.deviceId === deviceId);
  if (existing) return { ok: true, reused: true };
  const index = entries.findIndex((entry) => entry.code === target && !entry.usedAt);
  if (index === -1) return { ok: false, reason: "not_found" };
  entries[index] = {
    ...entries[index],
    usedAt: new Date().toISOString(),
    deviceId,
    userId: cleanText(meta.userId, 120),
    purpose: cleanText(meta.purpose || "device", 32)
  };
  await writePersistentJson(inviteCodesFile, "invite-codes.json", { updatedAt: new Date().toISOString(), codes: entries });
  return { ok: true };
}

async function deactivateInviteAccessForOldVersion() {
  const data = await readUsers();
  let changed = false;
  data.users.forEach((user) => {
    if (user.activatedBy) {
      delete user.activatedBy;
      changed = true;
    }
    if (user.accessMode === "invite") {
      user.accessMode = "";
      changed = true;
    }
  });
  if (Object.keys(data.sessions || {}).length) changed = true;
  data.sessions = {};
  if (changed) await saveUsers(data);
  const emptyRooms = { rooms: [], memberships: {} };
  await saveRooms(emptyRooms);
  return true;
}

function compactRoom(room = {}) {
  return {
    id: room.id || "",
    name: room.name || "",
    ownerId: room.ownerId || "",
    mateId: room.mateId || "",
    createdAt: room.createdAt || "",
    updatedAt: room.updatedAt || "",
    trackIds: Array.isArray(room.trackIds) ? room.trackIds.slice(0, 500) : [],
    lastMessageAt: room.lastMessageAt || "",
    lastTrackAt: room.lastTrackAt || "",
    playbackVersion: Number(room.playbackVersion || 0)
  };
}

function compactRoomMessage(message = {}) {
  return {
    id: message.id || "",
    roomId: message.roomId || "",
    userId: message.userId || "",
    username: message.username || "",
    content: cleanText(message.content, 500),
    createdAt: message.createdAt || new Date().toISOString()
  };
}

function mergeTogetherPlaybackTracks(left = [], right = []) {
  const map = new Map();
  [...left, ...right].filter(Boolean).forEach((track, index) => {
    const key = trackKeyForServer(track) || `${track.title || ""}:${track.artist || ""}:${index}`;
    if (!map.has(key)) map.set(key, track);
  });
  return [...map.values()];
}

function publicRoom(room = {}, currentUserId = "") {
  return {
    ...compactRoom(room),
    isOwner: room.ownerId === currentUserId,
    isMate: room.mateId === currentUserId,
    participants: [room.ownerId, room.mateId].filter(Boolean),
    trackCount: Array.isArray(room.trackIds) ? room.trackIds.length : 0
  };
}

async function getTogetherState(req) {
  const { data, user } = await getUserByToken(req);
  if (!user) return { data, user: null, room: null, messages: [], trackIds: [] };
  const rooms = await readRooms();
  const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id || item.participants?.includes?.(user.id)) || null;
  const messages = room?.messages || [];
  return { data, user, room, messages, trackIds: room?.trackIds || [], rooms };
}

async function listUnusedInviteCodes() {
  const entries = await readInviteCodes();
  return entries.filter((entry) => !entry.usedAt).map((entry) => entry.code);
}

async function readInviteActivationByDevice(deviceId = "") {
  const targetDeviceId = cleanText(deviceId, 120);
  if (!targetDeviceId) return null;
  const entries = await readInviteCodes();
  const matched = entries.find((entry) => entry.deviceId === targetDeviceId && entry.usedAt && entry.purpose === "beta") || null;
  if (!matched) return null;
  return {
    code: matched.code,
    usedAt: matched.usedAt,
    deviceId: matched.deviceId,
    purpose: matched.purpose || "beta",
    userId: matched.userId || ""
  };
}

async function fetchNeteaseLibraryTracks(req) {
  const playlists = await fetchNeteasePlaylists(req);
  const activePlaylists = playlists.slice(0, maxLibraryPlaylists);
  const groups = await mapWithConcurrency(
    activePlaylists,
    libraryPlaylistConcurrency,
    async (playlist) => {
      const tracks = await fetchNeteasePlaylistTracks(playlist.id, req).catch(() => []);
      return tracks.slice(0, maxLibraryTracksPerPlaylist).map((track, index) => ({
        ...track,
        cover: track.cover || playlist.cover || "",
        libraryKey: `netease:${playlist.id}:${track.id || index}:${index}`,
        playlistId: playlist.id,
        playlistName: playlist.name,
        playlistDescription: playlist.description || ""
      }));
    }
  );
  return groups.flat();
}

async function fetchQQMusicLibraryTracks(req) {
  const playlists = await fetchQQMusicPlaylists(req);
  const activePlaylists = playlists.slice(0, maxLibraryPlaylists);
  const groups = await mapWithConcurrency(
    activePlaylists,
    libraryPlaylistConcurrency,
    async (playlist) => {
      const tracks = await fetchQQMusicPlaylistTracks(playlist.id, req).catch(() => []);
      return tracks.slice(0, maxLibraryTracksPerPlaylist).map((track, index) => ({
        ...track,
        cover: track.cover || playlist.cover || "",
        libraryKey: `qq:${playlist.id}:${track.id || track.songId || index}:${index}`,
        playlistId: playlist.id,
        playlistName: playlist.name,
        playlistDescription: playlist.description || ""
      }));
    }
  );
  return groups.flat();
}

function hashPassword(password = "", salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password = "", user = {}) {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash));
}

function authToken() {
  return crypto.randomBytes(28).toString("base64url");
}

function accountPersistenceUnavailable() {
  return Boolean(isVercel && blobPersistenceDisabledReason);
}

function accountPersistenceUnavailableMessage() {
  return `云韶账号存储暂不可用：${blobPersistenceDisabledReason || "Vercel Blob 不可用"}。请先恢复 Vercel Blob Store，或改用数据库持久化。`;
}

function normalizeUsers(payload = {}) {
  return {
    users: Array.isArray(payload.users) ? payload.users : [],
    sessions: payload.sessions && typeof payload.sessions === "object" ? payload.sessions : {}
  };
}

function normalizeRooms(payload = {}) {
  return {
    rooms: Array.isArray(payload.rooms) ? payload.rooms : [],
    memberships: payload.memberships && typeof payload.memberships === "object" ? payload.memberships : {}
  };
}

async function readUsers() {
  try {
    return normalizeUsers(await readPersistentJson(usersFile, "users.json", { users: [], sessions: {} }));
  } catch (error) {
    console.warn("readUsers failed, using empty list:", error.message);
    return { users: [], sessions: {} };
  }
}

async function saveUsers(data) {
  const payload = normalizeUsers(data);
  await writePersistentJson(usersFile, "users.json", { ...payload, updatedAt: new Date().toISOString() });
  return payload;
}

async function readRooms() {
  try {
    return normalizeRooms(await readPersistentJson(roomsFile, "together-rooms.json", { rooms: [], memberships: {} }));
  } catch (error) {
    console.warn("readRooms failed, using empty list:", error.message);
    return { rooms: [], memberships: {} };
  }
}

async function saveRooms(data) {
  const payload = normalizeRooms(data);
  await writePersistentJson(roomsFile, "together-rooms.json", { ...payload, updatedAt: new Date().toISOString() });
  return payload;
}

function publicUser(user = {}) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt || "",
    betaAccess: Boolean(user.betaAccess || user.activatedBy),
    betaInviteCode: user.betaInviteCode || "",
    betaDeviceIds: Array.isArray(user.betaDeviceIds) ? user.betaDeviceIds.slice(0, 20) : [],
    bound: {
      netease: Boolean(user.bindings?.netease?.loggedIn),
      qq: Boolean(user.bindings?.qq?.loggedIn)
    },
    historyCount: Array.isArray(user.history) ? user.history.length : 0,
    savedCount: Array.isArray(user.savedTracks) ? user.savedTracks.length : 0,
    lastSyncedAt: user.lastSyncedAt || ""
  };
}

function tokenFromRequest(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(req.headers["x-caelum-token"] || "").trim();
}

async function getUserByToken(req) {
  const token = tokenFromRequest(req);
  if (!token) return { data: await readUsers(), user: null, token: "" };
  const data = await readUsers();
  const userId = data.sessions[token];
  const user = data.users.find((item) => item.id === userId) || null;
  return { data, user, token };
}

function compactHistoryTrack(track = {}) {
  return {
    key: trackKeyForServer(track),
    id: track.id || "",
    title: cleanText(track.title, 120),
    artist: cleanText(track.artist, 120),
    album: cleanText(track.album, 120),
    cover: cleanText(track.cover, 500),
    platform: cleanText(track.platform || track.sourcePlatform, 32),
    playlistName: cleanText(track.playlistName, 120),
    musicUrl: cleanText(track.musicUrl, 800),
    playedAt: new Date().toISOString()
  };
}

function trackKeyForServer(track = {}) {
  return String(track.libraryKey || track.id || track.songId || track.mediaId || `${track.platform || ""}:${track.title || ""}:${track.artist || ""}`).slice(0, 240);
}

function compactLibraryTrack(track = {}) {
  const platform = track.platform || track.sourcePlatform || "";
  const mediaId = track.mediaId || track.media_mid || track.raw?.strMediaMid || track.raw?.media_mid || "";
  return {
    id: cleanText(track.id, 120),
    songId: cleanText(track.songId || track.songid, 120),
    title: cleanText(track.title, 160),
    artist: cleanText(track.artist, 160),
    album: cleanText(track.album, 160),
    cover: cleanText(track.cover, 800),
    duration: Number(track.duration || 0),
    publishTime: cleanText(track.publishTime, 64),
    year: cleanText(track.year, 16),
    platform: cleanText(platform, 32),
    sourcePlatform: cleanText(track.sourcePlatform || platform, 32),
    mediaId: cleanText(mediaId, 160),
    qqSearchKey: cleanText(track.qqSearchKey, 240),
    musicUrl: cleanText(track.musicUrl || track.url, 1200),
    libraryKey: cleanText(track.libraryKey || trackKeyForServer(track), 240),
    playlistId: cleanText(track.playlistId, 120),
    playlistName: cleanText(track.playlistName, 160),
    playlistDescription: cleanText(track.playlistDescription, 500),
    playCount: Number(track.playCount || 0),
    geoRegionKey: cleanText(track.geoRegionKey, 80),
    geoRegionName: cleanText(track.geoRegionName, 120),
    geoRegionLat: track.geoRegionLat === "" || track.geoRegionLat == null ? "" : Number(track.geoRegionLat),
    geoRegionLng: track.geoRegionLng === "" || track.geoRegionLng == null ? "" : Number(track.geoRegionLng),
    geoRegionTint: cleanText(track.geoRegionTint, 64)
  };
}

function cookieHeaderFromState(state) {
  return (state?.cookies || []).join("; ");
}

function cookieObjectFromList(cookies = []) {
  return Object.fromEntries(
    normalizeCookieList(cookies).map((entry) => {
      const index = entry.indexOf("=");
      if (index === -1) return [entry, ""];
      return [entry.slice(0, index), entry.slice(index + 1)];
    })
  );
}

function serializeQQMusicState(state) {
  const hasCredential = Boolean(state?.api1Credential?.musicid && state?.api1Credential?.musickey);
  const hasIdentity = Boolean(state?.uin || state?.profile?.nick || state?.profile?.creator?.hostname || hasCredential);
  return {
    loggedIn: Boolean(state?.loggedIn && hasIdentity),
    uin: state?.uin || "",
    profile: state?.profile || null,
    qrSig: state?.qrSig || "",
    qrImg: state?.qrImg || "",
    qrStatus: state?.qrStatus || "",
    qrLoginType: state?.qrLoginType || "qq",
    qrConfigIndex: state?.qrConfigIndex || 0,
    qrConfigLabel: state?.qrConfigLabel || "",
    qrNeedsRefresh: Boolean(state?.qrNeedsRefresh),
    provider: hasCredential ? "QQMusicApi1" : "qq-music-api",
    updatedAt: state?.updatedAt || ""
  };
}

function setQQMusicApiCookie(cookies = []) {
  const normalized = normalizeCookieList(cookies);
  qqMusicApi.setCookie(normalized.join("; "));
  return normalized;
}

async function qqMusicApiCall(pathname, query = {}, stateOrReq) {
  const state = Array.isArray(stateOrReq?.cookies) ? stateOrReq : await readQQMusicState(stateOrReq);
  setQQMusicApiCookie(state.cookies || []);
  return qqMusicApi.api(pathname, query);
}

async function fetchQQJson(urlString, params = {}, state = {}) {
  const url = new URL(urlString);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://y.qq.com/portal/profile.html",
      "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Cookie: cookieHeaderFromState(state)
    }
  });
  if (!response.ok) throw new Error(`QQ 音乐接口失败：${response.status}`);
  const text = await response.text();
  const jsonText = text.trim().replace(/^callback\(|^MusicJsonCallback\(|^jsonCallback\(|\)$/g, "");
  try {
    return jsonText ? JSON.parse(jsonText) : {};
  } catch (_error) {
    throw new Error("QQ 音乐接口返回无法解析");
  }
}

function parseSetCookies(headers) {
  const values =
    headers.getSetCookie?.() ||
    (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  return values
    .flatMap((entry) => String(entry).split(/,(?=[^;]+?=)/g))
    .map((entry) => entry.split(";")[0]?.trim())
    .filter(Boolean);
}

function extractQrImage(qrimg) {
  if (!qrimg) return "";
  if (String(qrimg).startsWith("data:image")) return String(qrimg);
  return `data:image/png;base64,${String(qrimg)}`;
}

function neteaseProxyBase() {
  return (neteaseApiBaseUrl || musicApiBaseUrl || "").replace(/\/$/, "");
}

function normalizeCookieList(cookie) {
  if (!cookie) return [];
  const ignoredCookieAttrs = new Set(["max-age", "expires", "path", "domain", "samesite", "secure", "httponly"]);
  const normalizePart = (part) => {
    const text = String(part || "").trim();
    const first = text.split(";")[0]?.trim() || "";
    const name = first.split("=")[0]?.trim().toLowerCase();
    if (!first.includes("=") || ignoredCookieAttrs.has(name)) return "";
    return first;
  };
  if (Array.isArray(cookie)) return cookie.map(normalizePart).filter(Boolean);
  return String(cookie)
    .split(/,(?=[^;,]+=)|;/g)
    .map(normalizePart)
    .filter(Boolean);
}

async function fetchNeteaseProxy(pathname, { method = "GET", body } = {}) {
  const base = neteaseProxyBase();
  if (!base) return null;
  const url = new URL(pathname, `${base}/`);
  url.searchParams.set("timestamp", Date.now());
  url.searchParams.set("ua", "pc");
  const response = await fetch(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload?.message || payload?.msg || `网易云代理接口失败：${response.status}`);
  Object.defineProperty(payload, "__cookies", {
    value: parseSetCookies(response.headers),
    enumerable: false
  });
  return payload;
}

function isRiskPayload(payload) {
  const text = JSON.stringify(payload || {});
  return /风险|risk|设备|环境|验证失败|security/i.test(text);
}

async function refreshNeteaseProfile(req) {
  const state = await readNeteaseState(req);
  if (!state.cookies?.length) return null;

  const cookie = cookieHeaderFromState(state);
  let account = {};
  let profile = null;
  if (neteaseProxyBase()) {
    const statusPayload = await fetchNeteaseProxy("/login/status", {
      method: "POST",
      body: { cookie }
    }).catch(() => null);
    account = statusPayload?.data?.account || statusPayload?.account || {};
    profile = statusPayload?.data?.profile || statusPayload?.profile || null;
  }
  if (!profile && !account?.id) {
    const accountResult = await neteaseApi.user_account({ cookie }).catch(() => null);
    account = accountResult?.body?.data || accountResult?.body || {};
    const uidForDetail = account?.id || account?.account?.id || state.uid || "";
    const detailResult = uidForDetail ? await neteaseApi.user_detail({ uid: uidForDetail, cookie }).catch(() => null) : null;
    profile = detailResult?.body?.profile || detailResult?.body?.data || account?.profile || null;
  }
  const uid = account?.id || account?.account?.id || profile?.userId || profile?.userIdStr || state.uid || "";
  const nextState = {
    ...state,
    uid,
    profile: profile || state.profile || null,
    loggedIn: Boolean(uid || state.cookies?.length),
    updatedAt: new Date().toISOString()
  };
  await saveNeteaseState(nextState);
  return nextState;
}

async function startNeteaseLogin() {
  const proxyBase = neteaseProxyBase();
  if (proxyBase) {
    try {
      const keyPayload = await fetchNeteaseProxy("/login/qr/key");
      const key = keyPayload?.data?.unikey || keyPayload?.data?.data?.unikey || "";
      if (key) {
        const createPayload = await fetchNeteaseProxy(`/login/qr/create?key=${encodeURIComponent(key)}&platform=web&qrimg=true`);
        const createData = createPayload?.data || {};
        const state = await readNeteaseState();
        const nextState = {
          ...state,
          cookies: [],
          uid: "",
          profile: null,
          qrKey: key,
          qrImg: extractQrImage(createData.qrimg || ""),
          qrUrl: createData.qrurl || `https://music.163.com/login?codekey=${key}`,
          qrProvider: proxyBase,
          qrStatus: "",
          loggedIn: false,
          updatedAt: new Date().toISOString()
        };
        await saveNeteaseState(nextState);
        return nextState;
      }
    } catch (error) {
      console.warn("proxy qr login start failed, falling back:", error.message);
    }
  }

  const keyResponse = await neteaseApi.login_qr_key({});
  const key = keyResponse?.body?.data?.data?.unikey || keyResponse?.body?.data?.unikey || keyResponse?.body?.unikey || "";
  if (!key) {
    throw new Error("无法获取网易云登录 key");
  }

  const createResponse = await neteaseApi.login_qr_create({ key, qrimg: true });
  const createData = createResponse?.body?.data || {};
  const qrImg = createData?.qrimg || "";
  const qrUrl = createData?.qrurl || "";
  const state = await readNeteaseState();
  const nextState = {
    ...state,
    cookies: [],
    uid: "",
    profile: null,
    qrKey: key,
    qrImg: extractQrImage(qrImg),
    qrUrl,
    qrStatus: "",
    loggedIn: false,
    updatedAt: new Date().toISOString()
  };
  await saveNeteaseState(nextState);
  return nextState;
}

async function sendNeteaseCaptcha(phone, countrycode = "86") {
  const normalizedPhone = String(phone || "").replace(/[^\d]/g, "");
  const normalizedCountry = String(countrycode || "86").replace(/[^\d]/g, "") || "86";
  if (!normalizedPhone) throw new Error("请先输入手机号码");

  if (neteaseProxyBase()) {
    try {
      const payload = await fetchNeteaseProxy(
        `/captcha/sent?phone=${encodeURIComponent(normalizedPhone)}&ctcode=${encodeURIComponent(normalizedCountry)}&countrycode=${encodeURIComponent(normalizedCountry)}`
      );
      const code = payload?.code ?? payload?.data?.code ?? 500;
      return {
        ok: code === 200,
        code,
        payload,
        provider: "proxy",
        risk: isRiskPayload(payload)
      };
    } catch (error) {
      console.warn("proxy captcha send failed, falling back:", error.message);
    }
  }

  const response = await neteaseApi.captcha_sent({ phone: normalizedPhone, ctcode: normalizedCountry }).catch((error) => ({ error }));
  const payload = response?.body?.data || response?.body || {};
  if (response?.error) throw new Error(response.error.message || "验证码发送失败");
  return {
    ok: payload?.code === 200 || response?.status === 200,
    code: payload?.code || response?.code || 500,
    payload
  };
}

async function verifyNeteaseCaptcha(phone, captcha, countrycode = "86") {
  const normalizedPhone = String(phone || "").replace(/[^\d]/g, "");
  const normalizedCaptcha = String(captcha || "").replace(/[^\d]/g, "");
  const normalizedCountry = String(countrycode || "86").replace(/[^\d]/g, "") || "86";
  if (!normalizedPhone) throw new Error("请先输入手机号码");
  if (!normalizedCaptcha) throw new Error("请先输入验证码");

  if (neteaseProxyBase()) {
    try {
      const payload = await fetchNeteaseProxy(
        `/captcha/verify?phone=${encodeURIComponent(normalizedPhone)}&captcha=${encodeURIComponent(normalizedCaptcha)}&ctcode=${encodeURIComponent(normalizedCountry)}&countrycode=${encodeURIComponent(normalizedCountry)}`
      );
      const code = payload?.code ?? payload?.data?.code ?? 500;
      return {
        ok: code === 200,
        code,
        payload,
        provider: "proxy",
        risk: isRiskPayload(payload)
      };
    } catch (error) {
      console.warn("proxy captcha verify failed, falling back:", error.message);
    }
  }

  const response = await neteaseApi.captcha_verify({ phone: normalizedPhone, captcha: normalizedCaptcha, ctcode: normalizedCountry }).catch((error) => ({ error }));
  const payload = response?.body?.data || response?.body || {};
  if (response?.error) throw new Error(response.error.message || "验证码校验失败");
  return {
    ok: payload?.code === 200 || response?.status === 200,
    code: payload?.code || response?.code || 500,
    payload
  };
}

async function loginNeteaseWithPhone({ phone, captcha, countrycode = "86" }) {
  const normalizedPhone = String(phone || "").replace(/[^\d]/g, "");
  const normalizedCaptcha = String(captcha || "").replace(/[^\d]/g, "");
  const normalizedCountry = String(countrycode || "86").replace(/[^\d]/g, "") || "86";
  if (!normalizedPhone) throw new Error("请先输入手机号码");
  if (!normalizedCaptcha) throw new Error("请先输入验证码");

  if (neteaseProxyBase()) {
    try {
      const payload = await fetchNeteaseProxy(
        `/login/cellphone?phone=${encodeURIComponent(normalizedPhone)}&captcha=${encodeURIComponent(normalizedCaptcha)}&ctcode=${encodeURIComponent(normalizedCountry)}&countrycode=${encodeURIComponent(normalizedCountry)}`
      );
      const code = payload?.code ?? payload?.data?.code ?? 500;
      const cookie = normalizeCookieList(payload?.cookie || payload?.data?.cookie || "");
      const state = await readNeteaseState();
      const nextState = {
        ...state,
        cookies: cookie.length ? cookie : state.cookies || [],
        loggedIn: code === 200 && cookie.length > 0,
        phoneLoginProvider: neteaseProxyBase(),
        updatedAt: new Date().toISOString()
      };
      await saveNeteaseState(nextState);
      const refreshed = nextState.loggedIn ? await refreshNeteaseProfile().catch(() => nextState) : nextState;
      return {
        ok: refreshed.loggedIn,
        code,
        payload,
        state: serializeNeteaseState(refreshed),
        cookies: refreshed.cookies || [],
        risk: isRiskPayload(payload)
      };
    } catch (error) {
      console.warn("proxy phone login failed, falling back:", error.message);
    }
  }

  const response = await neteaseApi.login_cellphone({
    phone: normalizedPhone,
    captcha: normalizedCaptcha,
    countrycode: normalizedCountry
  });
  const payload = response?.body?.data || response?.body || {};
  const cookie = response?.cookie || payload?.cookie || [];
  const state = await readNeteaseState();
  const nextState = {
    ...state,
    cookies: normalizeCookieList(cookie),
    loggedIn: payload?.code === 200 || response?.status === 200,
    updatedAt: new Date().toISOString()
  };
  await saveNeteaseState(nextState);
  const refreshed = nextState.loggedIn ? await refreshNeteaseProfile().catch(() => nextState) : nextState;
  return { ok: refreshed.loggedIn, payload, state: serializeNeteaseState(refreshed), cookies: refreshed.cookies || [] };
}

async function checkNeteaseLogin(key) {
  const state = await readNeteaseState();
  const qrKey = key || state.qrKey;
  if (!qrKey) throw new Error("没有可用的登录 key");

  const proxyBase = state.qrProvider || neteaseProxyBase();
  if (proxyBase) {
    try {
      const payload = await fetchNeteaseProxy(`/login/qr/check?key=${encodeURIComponent(qrKey)}`);
      const code = payload?.code ?? payload?.data?.code ?? 0;
      const cookie = normalizeCookieList([
        ...(Array.isArray(payload.__cookies) ? payload.__cookies : []),
        ...(Array.isArray(payload?.cookie) ? payload.cookie : normalizeCookieList(payload?.cookie || "")),
        ...(Array.isArray(payload?.data?.cookie) ? payload.data.cookie : normalizeCookieList(payload?.data?.cookie || ""))
      ]);
      const hasUsableCookie = cookie.length > 0 || Boolean(state.cookies?.length);
      const status = {
        ...state,
        qrKey,
        cookies: cookie.length ? cookie : state.cookies || [],
        loggedIn: (code === 803 || code === 200) && hasUsableCookie,
        qrStatus: payload?.message || payload?.msg || payload?.data?.message || "",
        updatedAt: new Date().toISOString()
      };
      await saveNeteaseState(status);
      const refreshed = status.loggedIn ? await refreshNeteaseProfile().catch(() => status) : status;
      return { ...refreshed, code, payload };
    } catch (error) {
      console.warn("proxy qr login check failed, falling back:", error.message);
    }
  }

  const response = await neteaseApi.login_qr_check({ key: qrKey, cookie: cookieHeaderFromState(state) });
  const payload = response?.body?.data || response?.body || {};
  const code = payload?.code ?? response?.code ?? 0;
  const status = {
    ...state,
    qrKey,
    loggedIn: code === 803 || code === 200,
    qrStatus: payload?.message || payload?.msg || payload?.text || "",
    updatedAt: new Date().toISOString()
  };
  if (code === 803 || code === 200) {
    const cookie = normalizeCookieList(response?.cookie || payload?.cookie || []);
    if (cookie?.length) {
      status.cookies = cookie;
    }
    await saveNeteaseState(status);
    const refreshed = await refreshNeteaseProfile().catch(() => status);
    return { ...refreshed, code, payload };
  } else {
    await saveNeteaseState(status);
  }
  return { ...status, code, payload };
}

async function refreshNeteaseAccount() {
  const state = await readNeteaseState();
  if (!state.cookies?.length) return serializeNeteaseState(state);
  const nextState = await refreshNeteaseProfile().catch(() => state);
  return serializeNeteaseState(nextState || state);
}

async function fetchNeteasePlaylists(req) {
  const state = await refreshNeteaseProfile(req).catch(() => null);
  const uid = state?.uid || state?.profile?.userId || state?.profile?.userIdStr || "";
  if (!uid) {
    throw new Error("尚未登录网易云，无法获取歌单");
  }

  const cookie = cookieHeaderFromState(state);
  const response = await neteaseApi.user_playlist({
    uid,
    limit: 1000,
    offset: 0,
    cookie
  });
  const playlists = response?.body?.playlist || response?.body?.data?.playlist || [];
  return playlists.map(normalizePlaylistItem).filter((item) => item.id);
}

async function fetchNeteasePlaylistTracks(playlistId, req) {
  if (!playlistId) throw new Error("缺少歌单 ID");
  const state = await readNeteaseState(req);
  const cookie = cookieHeaderFromState(state);
  const response = await neteaseApi.playlist_track_all({
    id: playlistId,
    limit: 1000,
    offset: 0,
    cookie
  });
  const tracks = response?.body?.songs || response?.body?.data?.songs || response?.body?.playlist?.tracks || [];
  return tracks.map(normalizeTrackItem).filter((item) => item.id);
}

async function refreshQQMusicProfile(req) {
  const state = await readQQMusicState(req);
  if (!state.cookies?.length) return state;
  setQQMusicApiCookie(state.cookies);
  await qqMusicApi.api("user/refresh").catch(() => null);
  const cookieObject = qqMusicApi.cookie || cookieObjectFromList(state.cookies);
  const cookies = normalizeCookieList(Object.entries(cookieObject).map(([key, value]) => `${key}=${value}`));
  const uin = String(cookieObject.uin || state.uin || "").replace(/\D/g, "");
  const profile = uin ? await qqMusicApi.api("user/detail", { id: uin }).catch(() => null) : null;
  const nextState = {
    ...state,
    cookies: cookies.length ? cookies : state.cookies,
    uin,
    profile: profile || state.profile || null,
    loggedIn: Boolean(uin || cookies.length),
    updatedAt: new Date().toISOString()
  };
  await saveQQMusicState(nextState);
  return nextState;
}

async function loginQQMusicWithCookie(cookie) {
  const raw = String(cookie || "").trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const credential = normalizeQQMusicApi1Credential(parsed.credential || parsed);
    if (!credential.musicid || !credential.musickey) throw new Error("QQMusicApi1 Credential 缺少 musicid 或 musickey");
    const state = {
      cookies: [],
      api1Credential: credential,
      uin: String(credential.musicid),
      profile: { nick: String(credential.musicid) },
      loggedIn: true,
      updatedAt: new Date().toISOString()
    };
    await saveQQMusicState(state);
    return state;
  }

  const cookies = normalizeCookieList(cookie);
  if (!cookies.length) throw new Error("请粘贴 QQ 音乐网页 Cookie");
  setQQMusicApiCookie(cookies);
  await qqMusicApi.api("user/refresh").catch(() => null);
  const cookieObject = qqMusicApi.cookie || cookieObjectFromList(cookies);
  const nextCookies = normalizeCookieList(Object.entries(cookieObject).map(([key, value]) => `${key}=${value}`));
  const state = {
    cookies: nextCookies.length ? nextCookies : cookies,
    uin: String(cookieObject.uin || cookieObject.wxuin || "").replace(/\D/g, ""),
    profile: null,
    loggedIn: Boolean(cookieObject.uin || cookieObject.wxuin || cookies.length),
    updatedAt: new Date().toISOString()
  };
  await saveQQMusicState(state);
  return refreshQQMusicProfile().catch(() => state);
}

function normalizeQQMusicQrLoginType(value) {
  return String(value || "qq").toLowerCase() === "wx" ? "wx" : "qq";
}

function qqMusicQrLoginTypeLabel(type) {
  return normalizeQQMusicQrLoginType(type) === "wx" ? "微信" : "手机 QQ";
}

function isQQMusicApi1QrStatusFailure(error) {
  return error?.name === "AbortError" || /获取二维码状态失败|无法解析响应|invalid json|timed out|timeout|aborted|fetch failed|undici/i.test(error?.message || "");
}

async function startQQMusicQrLogin(preferIndex = 0, loginType = "qq") {
  const safeLoginType = normalizeQQMusicQrLoginType(loginType);
  if (qqMusicApi1BaseUrl) {
    const payload = await fetchQQMusicApi1(`/login/qrcode/${safeLoginType}`);
    const state = await readQQMusicState();
    const nextState = {
      ...state,
      cookies: [],
      uin: "",
      profile: null,
      api1Credential: null,
      loggedIn: false,
      qrSig: payload.identifier || "",
      qrImg: payload.img || "",
      qrLoginType: safeLoginType,
      qrStatus: `请使用${qqMusicQrLoginTypeLabel(safeLoginType)}扫码（QQMusicApi1）`,
      qrProvider: "qqmusic-api1",
      qrConfigLabel: "QQMusicApi1",
      qrNeedsRefresh: false,
      updatedAt: new Date().toISOString()
    };
    await saveQQMusicState(nextState);
    return nextState;
  }

  if (safeLoginType === "wx") {
    throw new Error("微信扫码需要配置 QQMUSIC_API1_BASE_URL，并确保 QQMusicApi1 服务已启动");
  }

  const config = qqMusicQrConfigs[clampInt(preferIndex, 0, qqMusicQrConfigs.length - 1, 0)] || qqMusicQrConfigs[0];
  const qr = await qqLoginQr.getQrcode(config.appid, config.callback);
  const state = await readQQMusicState();
  const nextState = {
    ...state,
    cookies: [],
    uin: "",
    profile: null,
    api1Credential: null,
    loggedIn: false,
    qrSig: qr.qrsig || "",
    qrImg: qr.image || "",
    qrConfigIndex: qqMusicQrConfigs.indexOf(config),
    qrConfigLabel: config.label,
    qrStatus: `请使用手机 QQ 扫码（${config.label}）`,
    qrLoginType: "qq",
    qrProvider: "qq-login-qr",
    qrNeedsRefresh: false,
    updatedAt: new Date().toISOString()
  };
  await saveQQMusicState(nextState);
  return nextState;
}

async function checkQQMusicQrLogin(qrSig) {
  const state = await readQQMusicState();
  const currentQrSig = qrSig || state.qrSig;
  if (!currentQrSig) throw new Error("没有可用的 QQ 音乐二维码");
  if (state.qrProvider === "qqmusic-api1" || qqMusicApi1BaseUrl) {
    const loginType = normalizeQQMusicQrLoginType(state.qrLoginType);
    let payload = null;
    try {
      payload = await fetchQQMusicApi1(`/login/qrcode/${loginType}/status`, {
        params: { identifier: currentQrSig }
      });
    } catch (error) {
      if (!isQQMusicApi1QrStatusFailure(error)) throw error;
      const fallbackToWx = loginType === "qq";
      const nextState = {
        ...state,
        qrStatus: fallbackToWx
          ? "QQ 扫码已被腾讯状态接口拦截，无法确认登录结果。请切换微信扫码，或使用网页导入。"
          : "微信扫码状态暂时无法读取。请刷新二维码重试，或使用网页导入。",
        qrNeedsRefresh: true,
        updatedAt: new Date().toISOString()
      };
      await saveQQMusicState(nextState);
      return {
        ...serializeQQMusicState(nextState),
        code: -1,
        qrStatus: nextState.qrStatus,
        qrNeedsRefresh: true,
        qrAlternative: fallbackToWx ? "wx" : "cookie",
        needCookieImport: !fallbackToWx
      };
    }
    const done = Boolean(payload.done || payload.event === 0);
    if (!done) {
      const statusText = payload.event === 1 ? "等待扫码" : payload.event === 2 ? "已扫码，等待确认" : payload.event === 3 ? "二维码已过期" : payload.event === 4 ? "已拒绝登录" : "等待扫码确认";
      const nextState = {
        ...state,
        qrStatus: statusText,
        qrNeedsRefresh: payload.event === 3,
        updatedAt: new Date().toISOString()
      };
      await saveQQMusicState(nextState);
      return { ...serializeQQMusicState(nextState), code: payload.event, qrStatus: statusText };
    }

    const credential = normalizeQQMusicApi1Credential(payload.credential || {});
    const nextState = {
      ...state,
      api1Credential: credential,
      uin: String(credential.musicid || ""),
      profile: { nick: String(credential.musicid || "QQ 音乐已登录") },
      loggedIn: Boolean(credential.musicid && credential.musickey),
      qrStatus: "QQ 音乐登录成功",
      updatedAt: new Date().toISOString()
    };
    await saveQQMusicState(nextState);
    return {
      ...serializeQQMusicState(nextState),
      code: 0,
      qrStatus: nextState.qrStatus,
      api1Credential: credential
    };
  }

  const config = qqMusicQrConfigs[clampInt(state.qrConfigIndex, 0, qqMusicQrConfigs.length - 1, 0)] || qqMusicQrConfigs[0];
  const result = await qqLoginQr.getResult(currentQrSig, config.appid, config.callback);
  if (result.code !== 0) {
    const unknown = /未知状态|appid|回调|callback/i.test(result.msg || "");
    const nextState = {
      ...state,
      qrStatus: unknown ? `${config.label}不可用，请刷新二维码或切换网页导入` : result.msg || "等待扫码确认",
      qrNeedsRefresh: unknown,
      updatedAt: new Date().toISOString()
    };
    await saveQQMusicState(nextState);
    return {
      ...serializeQQMusicState(nextState),
      code: result.code,
      qrStatus: nextState.qrStatus,
      qrNeedsRefresh: unknown,
      nextQrConfigIndex: unknown ? Math.min((state.qrConfigIndex || 0) + 1, qqMusicQrConfigs.length - 1) : state.qrConfigIndex || 0
    };
  }

  const cookies = normalizeCookieList(
    Object.entries(result.cookies || {}).map(([key, value]) => `${key}=${value}`)
  );
  const candidateState = {
    ...state,
    cookies,
    uin: String(result.cookies?.uin || state.uin || "").replace(/\D/g, ""),
    profile: result.nick ? { nick: result.nick } : state.profile,
    loggedIn: Boolean(cookies.length),
    qrStatus: "QQ 已扫码，正在换取 QQ 音乐登录态",
    updatedAt: new Date().toISOString()
  };
  await saveQQMusicState(candidateState);

  const refreshed = await refreshQQMusicProfile().catch(() => candidateState);
  const cookieObject = cookieObjectFromList(refreshed.cookies || []);
  const hasMusicKey = Boolean(cookieObject.qm_keyst || cookieObject.qqmusic_key);
  return {
    ...serializeQQMusicState(refreshed),
    code: result.code,
    qrStatus: hasMusicKey ? "QQ 音乐登录成功" : "扫码成功，但没有拿到 QQ 音乐 Cookie",
    cookies: refreshed.cookies || [],
    needCookieImport: !hasMusicKey
  };
}

function qqMusicApi1CredentialFromState(state = {}) {
  if (state?.api1Credential?.musicid && state?.api1Credential?.musickey) return state.api1Credential;
  const cookieObject = cookieObjectFromList(state.cookies || []);
  const credential = normalizeQQMusicApi1Credential({
    ...cookieObject,
    musicid: cookieObject.musicid || state.uin || cookieObject.uin,
    musickey: cookieObject.musickey || cookieObject.qm_keyst || cookieObject.qqmusic_key
  });
  return credential.musicid && credential.musickey ? credential : null;
}

function qqMusicEncryptedUinFromState(state = {}) {
  return (
    state?.profile?.creator?.encrypt_uin ||
    state?.profile?.encrypt_uin ||
    state?.profile?.data?.encrypt_uin ||
    state?.profile?.data?.creator?.encrypt_uin ||
    state?.encrypt_uin ||
    ""
  );
}

async function fetchQQMusicApi1CreatedPlaylists(uin, state) {
  const credential = qqMusicApi1CredentialFromState(state);
  if (!credential || !uin) return [];
  const payload = await fetchQQMusicApi1(`/user/${encodeURIComponent(uin)}/created_songlists`, { credential });
  return Array.isArray(payload?.playlists) ? payload.playlists : [];
}

async function fetchQQMusicApi1FavPlaylists(euin, state) {
  const credential = qqMusicApi1CredentialFromState(state);
  if (!credential || !euin) return [];
  const payload = await fetchQQMusicApi1(`/user/${encodeURIComponent(euin)}/fav/songlists`, {
    params: { page: 1, num: 100 },
    credential
  });
  return Array.isArray(payload?.playlists) ? payload.playlists : [];
}

async function fetchQQMusicApi1FavSongs(euin, state) {
  const credential = qqMusicApi1CredentialFromState(state);
  if (!credential || !euin) return [];
  const payload = await fetchQQMusicApi1(`/user/${encodeURIComponent(euin)}/fav/songs`, {
    params: { page: 1, num: 1000 },
    credential
  });
  const tracks = payload?.songlist || payload?.songs || payload?.list || [];
  return Array.isArray(tracks) ? tracks : [];
}

async function fetchQQMusicApi1PlaylistDetail(playlistId, state, dirid = 0) {
  if (!playlistId) return {};
  const credential = qqMusicApi1CredentialFromState(state);
  const payload = await fetchQQMusicApi1(`/songlist/${encodeURIComponent(playlistId)}/detail`, {
    params: { dirid: dirid || 0, num: 1000, page: 1, onlysong: false, tag: true, userinfo: true },
    credential
  });
  return payload || {};
}

async function fetchQQMusicCreatedPlaylists(uin, state) {
  const api1Items = await fetchQQMusicApi1CreatedPlaylists(uin, state).catch((error) => {
    console.warn("QQMusicApi1 created playlists failed:", error.message);
    return [];
  });
  if (api1Items.length) return api1Items;
  const payload = await fetchQQJson("https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss", {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: 200,
    g_tk: 5381,
    loginUin: uin || 0,
    format: "json",
    inCharset: "utf8",
    outCharset: "utf-8",
    notice: 0,
    platform: "yqq.json",
    needNewCode: 0
  }, state);
  if (payload?.code === 4000) return [];
  const list = payload?.data?.disslist || payload?.disslist || [];
  return Array.isArray(list) ? list : [];
}

async function fetchQQMusicCollectedPlaylists(uin, state) {
  const euin = qqMusicEncryptedUinFromState(state);
  const api1Items = await fetchQQMusicApi1FavPlaylists(euin, state).catch((error) => {
    console.warn("QQMusicApi1 fav playlists failed:", error.message);
    return [];
  });
  if (api1Items.length) return api1Items;
  const payload = await fetchQQJson("https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg", {
    ct: 20,
    cid: 205360956,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: 80,
    g_tk: 5381,
    loginUin: uin || 0,
    format: "json",
    inCharset: "utf8",
    outCharset: "utf-8",
    platform: "yqq.json",
    needNewCode: 0
  }, state);
  const list = payload?.data?.cdlist || payload?.cdlist || [];
  return Array.isArray(list) ? list : [];
}

async function fetchQQMusicPlaylists(req) {
  const state = await refreshQQMusicProfile(req).catch(() => readQQMusicState(req));
  const uin = state?.uin || "";
  if (!uin) throw new Error("尚未登录 QQ 音乐，无法获取歌单");
  const euin = qqMusicEncryptedUinFromState(state);
  const [created, collected] = await Promise.all([
    fetchQQMusicCreatedPlaylists(uin, state).catch((error) => {
      console.warn("QQ created playlists failed:", error.message);
      return [];
    }),
    fetchQQMusicCollectedPlaylists(uin, state).catch((error) => {
      console.warn("QQ collected playlists failed:", error.message);
      return [];
    })
  ]);
  let merged = [...created, ...collected];
  if (!merged.length) {
    const fallbackCollected = await qqMusicApiCall("user/collect/songlist", { id: uin, pageNo: 1, pageSize: 80 }, state)
      .then((result) => result?.list || [])
      .catch(() => []);
    merged = fallbackCollected;
  }
  if (euin) {
    merged.unshift({
      id: `fav:${euin}`,
      dirid: 201,
      title: "我喜欢",
      diss_name: "我喜欢",
      desc: "QQ 音乐收藏歌曲",
      picurl: "https://y.gtimg.cn/mediastyle/global/img/cover_like.png",
      songnum: 0,
      platform: "qq"
    });
  }
  const seen = new Set();
  return merged
    .map(normalizeQQMusicPlaylistItem)
    .filter((playlist) => {
      if (!playlist.id || seen.has(String(playlist.id))) return false;
      seen.add(String(playlist.id));
      return true;
    });
}

async function fetchQQMusicPlaylistDetail(playlistId, state) {
  const api1Detail = await fetchQQMusicApi1PlaylistDetail(playlistId, state).catch((error) => {
    console.warn("QQMusicApi1 playlist detail failed:", error.message);
    return null;
  });
  if (api1Detail?.songlist?.length || api1Detail?.dirinfo) return api1Detail;
  const payload = await fetchQQJson("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", {
    type: 1,
    utf8: 1,
    disstid: playlistId,
    loginUin: state?.uin || 0,
    g_tk: 5381,
    format: "json",
    inCharset: "utf8",
    outCharset: "utf-8",
    platform: "yqq.json",
    needNewCode: 0
  }, state);
  const detail = payload?.cdlist?.[0] || payload?.data?.cdlist?.[0] || payload?.data || {};
  if (!detail || Array.isArray(detail)) return {};
  return detail;
}

async function fetchQQMusicPlaylistTracks(playlistId, req) {
  if (!playlistId) throw new Error("缺少 QQ 音乐歌单 ID");
  const state = await readQQMusicState(req);
  if (String(playlistId).startsWith("fav:")) {
    const euin = String(playlistId).slice(4) || qqMusicEncryptedUinFromState(state);
    const tracks = await fetchQQMusicApi1FavSongs(euin, state).catch((error) => {
      console.warn("QQMusicApi1 fav songs failed:", error.message);
      return [];
    });
    return tracks.map(normalizeQQMusicTrackItem).filter((item) => item.id);
  }
  const detail = await fetchQQMusicPlaylistDetail(playlistId, state).catch((error) => {
    console.warn("QQ playlist detail failed:", error.message);
    return {};
  });
  const tracks = detail?.songlist || detail?.songList || detail?.songs || detail?.list || [];
  return (Array.isArray(tracks) ? tracks : []).map(normalizeQQMusicTrackItem).filter((item) => item.id);
}

async function buildPlaylistPodcastBrief({ prompt, playlist, tracks, memory }) {
  const trackSummary = tracks.slice(0, 20).map((track) => `${track.title} - ${track.artist}`).join("；");
  const combinedPrompt = [
    prompt ? `用户额外要求：${prompt}` : "",
    `歌单名：${playlist.name}`,
    playlist.description ? `歌单描述：${playlist.description}` : "",
    `曲目：${trackSummary}`
  ]
    .filter(Boolean)
    .join("\n");

  if (!process.env.OPENAI_API_KEY) {
    return {
      title: playlist.name || "网易云歌单",
      artist: "云韶",
      episodeTitle: `${playlist.name || "歌单"} 的轻声导览`,
      scene: "歌单导览",
      durationSeconds: 60,
      script: `这是 ${playlist.name || "一个歌单"}。我会用很短的一段话带你进入它的气氛，然后让音乐自己继续说话。`,
      memoryPatch: {
        favoriteScenes: ["歌单导览", playlist.name || "网易云歌单"],
        musicTaste: tracks.slice(0, 8).map((track) => track.title).filter(Boolean),
        narrationStyle: "歌单导览，短句，轻介绍"
      },
      trackSummary
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个把歌单变成播客的音乐 Agent。请优先从场景、情绪、节奏、人声密度、昼夜与用途判断选曲，不要只看关键词。输出小写 json 对象，播客旁白只做总开场，不要逐首播报。每首歌的作用只写在 trackNotes 里。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: combinedPrompt,
            playlistName: playlist.name,
            playlistDescription: playlist.description,
            trackCount: tracks.length,
            rememberedPreferences: memory.profile,
            schema: {
              title: "歌单或场景标题",
              artist: "Agentio",
              episodeTitle: "歌单播客标题",
              scene: "一句话描述场景",
              durationSeconds: "50 到 110 秒",
              script: "100 到 220 个中文字，只说一次总开场，介绍为什么选这张歌单，后面只让音乐继续",
              trackNotes: "与 tracks 等长的数组，每项包含 trackId 和 text；text 是一句非常短的作用说明，不要编号",
              memoryPatch: {
                favoriteScenes: "数组",
                musicTaste: "数组",
                narrationStyle: "字符串"
              }
            }
          })
        }
      ]
    });
    const content = response.choices[0]?.message?.content || "{}";
    const brief = parseJsonFromModel(content);
    return { ...brief, trackSummary };
  } catch (err) {
    console.warn("buildPlaylistPodcastBrief: OpenAI failed, falling back", err?.message || err);
    return {
      title: playlist.name || "网易云歌单",
      artist: "Agentio",
      episodeTitle: `${playlist.name || "歌单"} 的轻声导览`,
      scene: "歌单导览",
      durationSeconds: 34,
      script: `这是 ${playlist.name || "一个歌单"}。我会用很短的一段话带你进入它的气氛，然后让音乐自己继续说话。`,
      trackNotes: tracks.map((track) => ({
        trackId: track.id,
        text: `${track.title} 负责 ${prompt ? "贴合场景" : "铺开氛围"}。`
      })),
      memoryPatch: {
        favoriteScenes: ["歌单导览", playlist.name || "网易云歌单"],
        musicTaste: tracks.slice(0, 8).map((track) => track.title).filter(Boolean),
        narrationStyle: "歌单导览，短句，轻介绍"
      },
      trackSummary
    };
  }
}

function buildDialogueTranscript(script, durationSeconds, offsetSeconds = narrationLeadInSeconds) {
  const lines = String(script || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const chars = lines.join(" ").split(/\s+/).filter(Boolean);
  const step = Math.max(0.08, durationSeconds / Math.max(1, chars.length));
  let cursor = offsetSeconds;
  return chars.map((word) => {
    const start = cursor;
    const end = cursor + step;
    cursor = end;
    return { text: word, start, end };
  });
}

async function buildMultiPlaylistPodcastBrief({ prompt, playlists, tracks, memory }) {
  const playlistSummary = playlists.slice(0, 4).map((playlist) => playlist.name).join("、");
  const trackSummary = tracks.slice(0, 20).map((track) => `${track.title} - ${track.artist} [${track.playlistName || "未知歌单"}]`).join("；");
  const combinedPrompt = [
    prompt ? `用户额外要求：${prompt}` : "",
    `混编歌单：${playlistSummary}`,
    `曲目：${trackSummary}`
  ]
    .filter(Boolean)
    .join("\n");

  if (!process.env.OPENAI_API_KEY) {
    return {
      title: playlistSummary || "网易云混编歌单",
      artist: "Agentio",
      episodeTitle: `${playlistSummary || "混编歌单"} 的轻声导览`,
      scene: "多歌单混编",
      durationSeconds: 64,
      script: `我把几张歌单混在一起了。它们之间会互相接上，像一段慢慢展开的夜晚路程。`,
      memoryPatch: {
        favoriteScenes: ["多歌单混编", playlistSummary || "网易云混编歌单"],
        musicTaste: tracks.slice(0, 8).map((track) => track.title).filter(Boolean),
        narrationStyle: "多歌单混编，短句，轻介绍"
      },
      trackSummary
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个把多个歌单混编成播客的音乐 Agent。请优先从场景、情绪、节奏、人声密度、昼夜与用途判断选曲，不要只看关键词。输出小写 json 对象，播客旁白只做总开场，不要逐首播报。每首歌的作用只写在 trackNotes 里。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: combinedPrompt,
            playlistNames: playlists.map((playlist) => playlist.name),
            trackCount: tracks.length,
            rememberedPreferences: memory.profile,
            schema: {
              title: "混编标题",
              artist: "Agentio",
              episodeTitle: "播客片段标题",
              scene: "一句话描述场景",
              durationSeconds: "40 到 90 秒",
              script: "100 到 220 个中文字，只说一次总开场，介绍为什么把这些歌混在一起，后面只让音乐继续",
              trackNotes: "与 tracks 等长的数组，每项包含 trackId 和 text；text 是一句非常短的作用说明，不要编号",
              memoryPatch: {
                favoriteScenes: "数组",
                musicTaste: "数组",
                narrationStyle: "字符串"
              }
            }
          })
        }
      ]
    });
    const content = response.choices[0]?.message?.content || "{}";
    const brief = parseJsonFromModel(content);
    return { ...brief, trackSummary };
  } catch (err) {
    console.warn("buildMultiPlaylistPodcastBrief failed", err?.message || err);
    return {
      title: playlistSummary || "网易云混编歌单",
      artist: "Agentio",
      episodeTitle: `${playlistSummary || "混编歌单"} 的轻声导览`,
      scene: "多歌单混编",
      durationSeconds: 38,
      script: `我把几张歌单混在一起了。它们之间会互相接上，像一段慢慢展开的夜晚路程。`,
      trackNotes: tracks.map((track) => ({
        trackId: track.id,
        text: `${track.title} 负责 ${track.playlistName ? `${track.playlistName} 里的` : ""}${prompt ? "场景延展" : "氛围过渡"}。`
      })),
      memoryPatch: {
        favoriteScenes: ["多歌单混编", playlistSummary || "网易云混编歌单"],
        musicTaste: tracks.slice(0, 8).map((track) => track.title).filter(Boolean),
        narrationStyle: "多歌单混编，短句，轻介绍"
      },
      trackSummary
    };
  }
}

async function buildQueueIntroBrief({ prompt, playlists, tracks, memory }) {
  if (!tracks?.length) {
    return { openingScript: "", trackNotes: [] };
  }

  const queueLines = tracks.slice(0, 24).map((track, index) => `${index + 1}. ${track.title} - ${track.artist} [${track.playlistName || "未知歌单"}]`).join("\n");
  const fallbackTrackNotes = tracks.map((track) => ({
    trackId: track.id,
    text: `${track.title} 在这里负责${track.playlistName ? `承接 ${track.playlistName} 的` : ""} ${prompt ? "场景" : "氛围"}。`
  }));
  const fallbackOpening = [
    prompt ? `你要的这个场景，我已经尽量往前面推了。` : `我把这些歌放在一起，不是为了堆热度，而是为了把同一个场景拆成几层。`,
    `有的歌负责让情绪落稳，有的负责把节奏往前送，有的负责留住空气感。`,
    `你先听我说完这一段，后面就交给音乐自己。`
  ].join("");

  if (!process.env.OPENAI_API_KEY) {
    return { openingScript: fallbackOpening, trackNotes: fallbackTrackNotes };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个音乐队列总开场写手。请只在最开始说一次总开场，介绍这组歌为什么这么选、每首歌大概承担什么作用。后面不要再逐首播报。要优先根据用户场景、情绪、节奏、人声密度、昼夜和用途来解释选曲，不要只复述歌名。输出小写 json 对象，不要编号。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            rememberedPreferences: memory.profile,
            playlistNames: playlists.map((playlist) => playlist.name),
            tracks: queueLines,
            schema: {
              openingScript: "一段 100 到 220 个中文字的总开场，只说一次，介绍这组歌背后的意义与场景，不要编号。",
              trackNotes: "与 tracks 等长的数组，每项包含 trackId 和 text；text 是一句非常短的作用说明，不要编号。"
            }
          })
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonFromModel(content);
    const openingScript = String(parsed.openingScript || "").trim() || fallbackOpening;
    const notes = Array.isArray(parsed.trackNotes) ? parsed.trackNotes : [];
    return {
      openingScript,
      trackNotes: tracks.map((track, index) => ({
        trackId: track.id,
        text: String(notes[index]?.text || "").trim() || fallbackTrackNotes[index]?.text || ""
      }))
    };
  } catch (err) {
    console.warn("buildQueueIntroBrief failed", err?.message || err);
    return { openingScript: fallbackOpening, trackNotes: fallbackTrackNotes };
  }
}

function buildPodcastDialoguePrompt({ prompt, track, songPackage, memory }) {
  const comments = (songPackage.hotComments || []).slice(0, 4).map((item, index) => `${index + 1}. ${item.content}`);
  return [
    prompt ? `用户场景：${prompt}` : "",
    `歌曲：${track.title} - ${track.artist}`,
    songPackage.songDetails?.description ? `歌曲简介：${songPackage.songDetails.description}` : "",
    songPackage.wikiSummary ? `百科摘要：${songPackage.wikiSummary}` : "",
    comments.length ? `热门评论：\n${comments.join("\n")}` : "",
    `记忆偏好：${JSON.stringify(memory.profile || {})}`
  ].filter(Boolean).join("\n");
}

async function buildSongPodcastScript({ prompt, track, songPackage, memory }) {
  const fallback = {
    durationSeconds: Math.max(60, Math.min(150, Math.round((songPackage.duration || track.duration || 180) * 0.62))),
    script: `夜色已经下来了，我们先把这首歌轻轻放进来。\n它不急着把情绪说满，只是先替你把呼吸放慢。\n你可以把它当成今晚的背景，也可以当成一个安静的提示。\n那就先别整理别的了，跟着旋律往前走一点。`,
    hostA: "",
    hostB: ""
  };

  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个真正的音乐播客编剧。请根据歌曲简介、热门评论、百科摘要和用户场景，写一段自然连贯的播客稿。必须只输出小写 json 对象。必须像真人电台，不要序号，不要提纲，不要说明你在写脚本，不要写主持人姓名、角色名或“甲/乙/A/B”。脚本必须是 4 行，每行一句完整发言，直接用换行分隔。总时长必须短于歌曲总时长，但要至少覆盖歌曲总时长的一半以上。背景音乐就是这首歌本身。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            rememberedPreferences: memory.profile,
            track: {
              title: track.title,
              artist: track.artist,
              duration: track.duration,
              album: track.album || "",
              description: songPackage.songDetails?.description || "",
              wikiSummary: songPackage.wikiSummary || "",
              hotComments: (songPackage.hotComments || []).slice(0, 6).map((item) => item.content)
            },
            schema: {
              durationSeconds: "必须小于歌曲总时长且大于歌曲总时长的一半",
              script: "播客稿，4 行，每行一句，使用换行分隔，不要编号，不要写说话人姓名或角色名",
              opening: "开场白，只用于这首歌开头",
              closing: "收束语，只用于这首歌结尾"
            }
          })
        }
      ]
    });
    const content = response.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromModel(content) || {};
    const songDuration = Number(track.duration || songPackage.duration || 0) || 180;
    const requestedDuration = Number(parsed.durationSeconds || 0);
    const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > songDuration * 0.5 && requestedDuration < songDuration
      ? requestedDuration
      : Math.max(60, Math.min(songDuration - 8, Math.round(songDuration * 0.62)));
    const rawScript = String(parsed.script || "").trim() || fallback.script;
    const script = rawScript
      .split(/\r?\n+/)
      .map((line) => line.replace(/^\s*(Marin|小岚|主持人[AB]?|主播[AB]?|嘉宾|A|B|甲|乙)\s*[：:]\s*/i, "").trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n");
    return {
      hostA: "",
      hostB: "",
      durationSeconds,
      script: script || fallback.script,
      opening: String(parsed.opening || "").trim(),
      closing: String(parsed.closing || "").trim()
    };
  } catch (error) {
    console.warn("buildSongPodcastScript failed, using fallback:", error.message);
    return fallback;
  }
}

async function createTrackPodcastEpisode({ track, prompt, voice, memory, cookie, musicPath: existingMusicPath = "" }) {
  const safeTrack = {
    id: track?.id || "",
    title: track?.title || track?.name || "未命名歌曲",
    artist: track?.artist || "",
    duration: Number(track?.duration || 0) || 0,
    album: track?.album || "",
    platform: inferMusicPlatform(track, "netease"),
    musicUrl: track?.musicUrl || track?.url || "",
    mediaId: track?.mediaId || track?.media_mid || track?.raw?.strMediaMid || track?.raw?.media_mid || "",
    qqSearchKey: track?.qqSearchKey || track?.raw?.qqSearchKey || "",
    playlistName: track?.playlistName || "",
    raw: track?.raw || null
  };
  const songPackage = await buildSongPodcastPackage(safeTrack, cookie);
  const podcastScript = await buildSongPodcastScript({
    prompt,
    track: { ...safeTrack, duration: songPackage.duration || safeTrack.duration },
    songPackage,
    memory
  });
  const musicUrl = await resolveMusicUrl({
    id: safeTrack.id,
    url: safeTrack.musicUrl,
    platform: safeTrack.platform || "netease",
    mediaId: safeTrack.mediaId,
    keyword: safeTrack.qqSearchKey || safeTrack.raw?.qqSearchKey || `${safeTrack.title || ""} ${safeTrack.artist || ""}`.trim()
  }).catch((error) => {
    console.warn(`resolve track music failed for ${safeTrack.title}:`, error.message);
    return "";
  });
  console.log("track music resolved", {
    title: safeTrack.title,
    platform: safeTrack.platform,
    id: safeTrack.id,
    keyword: safeTrack.qqSearchKey || `${safeTrack.title || ""} ${safeTrack.artist || ""}`.trim(),
    hasMusicUrl: Boolean(musicUrl)
  });
  let usedFallbackMusic = false;
  let musicPath = existingMusicPath;
  if (!musicPath && musicUrl) {
    musicPath = await prepareMusicInput(musicUrl).catch((error) => {
      console.warn(`prepare track music failed for ${safeTrack.title}:`, error.message);
      return "";
    });
  }
  if (!musicPath) {
    usedFallbackMusic = true;
    console.warn(`无法为 ${safeTrack.title} 准备原曲背景音乐，使用 fallback 背景继续生成播客`);
    musicPath = await createFallbackMusic();
  }
  const voicePath = await createSpeech(podcastScript.script, voice);
  const { outputPath, outputName, audioDiagnostics } = await mixPodcast({ musicPath, voicePath });
  const outputUrl = await publishGeneratedFile(outputPath, outputName);
  const transcriptSegments = buildTranscriptSegments(podcastScript.script, Number(podcastScript.durationSeconds || safeTrack.duration || 30));
  const lyricSegments = await fetchLyrics({ id: safeTrack.id, platform: safeTrack.platform }).catch(() => []);
  return {
    ...safeTrack,
    ...songPackage,
    podcastScript,
    musicUrl,
    podcastAudioUrl: outputUrl,
    outputUrl,
    usedFallbackMusic,
    audioDiagnostics,
    transcriptSegments,
    lyricSegments
  };
}

function serializeNeteaseState(state) {
  const hasIdentity = Boolean(state?.uid || state?.profile?.userId || state?.profile?.nickname);
  return {
    loggedIn: Boolean(state?.loggedIn && hasIdentity),
    uid: state?.uid || "",
    profile: state?.profile || null,
    qrKey: state?.qrKey || "",
    qrImg: state?.qrImg || "",
    qrUrl: state?.qrUrl || "",
    qrStatus: state?.qrStatus || "",
    updatedAt: state?.updatedAt || ""
  };
}

async function fetchNeteaseSongDetails(ids, cookie) {
  const list = (Array.isArray(ids) ? ids : String(ids || "").split(","))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!list.length) return [];
  try {
    const response = await neteaseApi.song_detail({ ids: list.join(","), cookie }).catch(() => null);
    const songs = response?.body?.songs || response?.body?.data?.songs || response?.body?.data || [];
    return (Array.isArray(songs) ? songs : []).map((song) => ({
      id: song.id,
      name: song.name || "",
      description: song.description || song.briefDesc || song.songDescription || "",
      album: song.al?.name || song.album?.name || song.album || "",
      artist: song.ar?.map?.((entry) => entry.name).join(" / ") || song.artists?.map?.((entry) => entry.name).join(" / ") || song.artist || "",
      duration: song.dt ? Math.round(Number(song.dt) / 1000) : Number(song.duration || song.interval || 0),
      publishTime: song.publishTime || "",
      alias: Array.isArray(song.alia) ? song.alia.filter(Boolean).join(" / ") : String(song.alias || "")
    }));
  } catch (error) {
    console.warn("fetchNeteaseSongDetails failed", error.message);
    return [];
  }
}

async function fetchNeteaseSongComments(id, cookie, limit = 5) {
  if (!id) return [];
  const response = await neteaseApi.comment_hot({ id, type: "song", limit, cookie }).catch(() => null);
  const comments = response?.body?.data?.comments || response?.body?.hotComments || response?.body?.comments || [];
  return (Array.isArray(comments) ? comments : []).map((comment) => ({
    content: String(comment.content || comment.richContent || "").trim(),
    likedCount: Number(comment.likedCount || comment.liked_count || 0),
    user: comment.user?.nickname || comment.user?.name || "",
    time: comment.time || comment.timeStr || ""
  })).filter((item) => item.content);
}

async function fetchNeteaseSongWikiSummary(id, cookie) {
  if (!id) return "";
  const response = await neteaseApi.song_wiki_summary({ id, cookie }).catch(() => null);
  const summary = response?.body?.data?.summary || response?.body?.data?.content || response?.body?.summary || "";
  return String(summary || "").trim();
}

async function buildSongPodcastPackage(track, cookie) {
  const [details] = await fetchNeteaseSongDetails(track?.id, cookie);
  const comments = await fetchNeteaseSongComments(track?.id, cookie, 6);
  const wikiSummary = await fetchNeteaseSongWikiSummary(track?.id, cookie);
  return {
    ...track,
    songDetails: details || null,
    hotComments: comments,
    wikiSummary
  };
}

function normalizePlaylistItem(item) {
  return {
    id: item.id || item.playlistId || item.playListId,
    name: item.name || item.playlistName || "未命名歌单",
    cover: item.coverImgUrl || item.coverUrl || item.avatarUrl || "",
    description: item.description || item.privacyReason || "",
    trackCount: item.trackCount || item.trackCnt || item.size || item.songCount || 0,
    playCount: item.playCount || item.playcnt || 0,
    creator: item.creator?.nickname || item.creator?.userName || item.creator?.nickname || item.creator || "",
    raw: item
  };
}

function normalizeQQMusicPlaylistItem(item) {
  const id = item.dissid || item.disstid || item.tid || item.id || item.dirid || "";
  return {
    id,
    name: item.diss_name || item.dissname || item.title || item.name || item.dirname || "未命名 QQ 歌单",
    cover: item.diss_cover || item.logo || item.picurl || item.cover || item.imgurl || "",
    description: item.desc || item.intro || item.description || "",
    trackCount: item.song_cnt || item.songnum || item.song_count || item.total_song_num || 0,
    playCount: item.listen_num || item.visitnum || item.playCount || 0,
    creator: item.creator?.nick || item.creator?.name || item.nickname || item.hostname || "",
    platform: "qq",
    raw: item
  };
}

function normalizeTrackItem(item) {
  const artist =
    item.ar?.map?.((entry) => entry.name).join(" / ") ||
    item.artists?.map?.((entry) => entry.name).join(" / ") ||
    item.artist ||
    item.singer ||
    item.singername ||
    "";
  return {
    id: item.id || item.songId || item.songid,
    title: item.name || item.songName || item.title || "未命名歌曲",
    artist: Array.isArray(artist) ? artist.join(" / ") : String(artist || "未知艺人"),
    album: item.al?.name || item.album?.name || item.album || "",
    cover: item.al?.picUrl || item.album?.picUrl || item.picUrl || item.cover || "",
    duration: item.dt ? Math.round(Number(item.dt) / 1000) : Number(item.duration || item.interval || 0),
    publishTime: item.publishTime || item.publishTimeStr || item.publish_time || item.raw?.publishTime || "",
    year: item.publishTime ? new Date(Number(item.publishTime)).getFullYear() : "",
    platform: "netease",
    raw: item
  };
}

function normalizeQQMusicTrackItem(item) {
  const singerList = item.singer || item.singers || item.singerlist || item.action?.singer || [];
  const artist = Array.isArray(singerList)
    ? singerList.map((entry) => entry.name || entry.title || entry.mid || "").filter(Boolean).join(" / ")
    : item.singername || item.artist || item.subtitle || "";
  const album = item.albumname || item.album?.name || item.album || "";
  const mid = item.songmid || item.mid || item.strMediaMid || item.strMediaMid || item.media_mid || item.id || item.songid || "";
  const coverMid = item.albummid || item.album?.mid || item.album_mid || "";
  const cover = item.cover || item.pic || item.image || (coverMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${coverMid}.jpg` : "");
  return {
    id: mid,
    songId: item.songid || item.id || "",
    title: item.songname || item.name || item.title || "未命名歌曲",
    artist: String(artist || "未知艺人"),
    album,
    cover,
    duration: Number(item.interval || item.duration || 0) || 0,
    publishTime: item.time_public || item.public_time || "",
    year: String(item.time_public || item.public_time || "").slice(0, 4),
    mediaId: item.strMediaMid || item.media_mid || mid,
    qqSearchKey: `${item.songname || item.name || item.title || ""} ${artist || ""}`.trim(),
    platform: "qq",
    raw: item
  };
}

function looksLikeQQSongMid(value) {
  return /^[A-Za-z0-9]{14}$/.test(String(value || ""));
}

function inferMusicPlatform(track = {}, fallback = defaultMusicPlatform) {
  const explicit = String(track.platform || "").trim().toLowerCase();
  if (looksLikeQQSongMid(track.id || track.songmid || track.mid || track.mediaId || track.media_mid)) return "qq";
  if (explicit === "qq" || explicit === "netease" || explicit === "kuwo" || explicit === "kugou") return explicit;
  return fallback;
}

function buildTranscriptSegments(script, narrationDurationSeconds, offsetSeconds = narrationLeadInSeconds) {
  const lines = String(script || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const total = Math.max(1, Number(narrationDurationSeconds || 0));
  const step = Math.max(1.8, total / lines.length);
  let cursor = offsetSeconds;
  return lines.map((line) => {
    const start = cursor;
    const end = cursor + step;
    cursor = end;
    return { text: line, start, end };
  });
}

function parseLrc(lyricText, songDuration = 0) {
  if (!lyricText) return [];
  const lines = String(lyricText).split(/\r?\n/);
  const entries = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

  for (const line of lines) {
    const matches = [...line.matchAll(timeRegex)];
    if (!matches.length) continue;

    let text = line;
    for (const m of matches) {
      text = text.replace(m[0], "");
    }
    text = text.trim();
    if (!text) continue;
    // 跳过纯信息行（作词/作曲/编曲等）
    if (/^(作词|作曲|编曲|制作人|混音|录音|母带|吉他|贝斯|鼓|钢琴|弦乐|和声|Engineered|录音棚)/.test(text)) continue;

    for (const m of matches) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const ms = Number(m[3].padEnd(3, "0"));
      const start = min * 60 + sec + ms / 1000;
      entries.push({ start, text });
    }
  }

  entries.sort((a, b) => a.start - b.start);

  // 去重：相同时间只保留第一个
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    const key = `${e.start.toFixed(3)}-${e.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }

  // 计算结束时间：下一行的开始时间，或者当前时间 + 默认4秒
  for (let i = 0; i < unique.length; i++) {
    const nextStart = unique[i + 1]?.start ?? (songDuration || unique[i].start + 3);
    unique[i].end = Math.max(nextStart, unique[i].start + 0.35);
  }

  return unique;
}

async function fetchLyrics({ id, platform, mediaId = "", songId = "", raw = null }) {
  if (!id) return [];
  const source = String(platform || "").toLowerCase();
  if (source === "qq") {
    return fetchQQMusicLyrics({ id, mediaId, songId, raw }).catch(() => []);
  }
  if (source === "netease") {
    const state = await readNeteaseState().catch(() => null);
    const cookie = cookieHeaderFromState(state);
    try {
      const resp = await neteaseApi.lyric({ id, cookie }).catch(() => null);
      const lrc = resp?.body?.lrc?.lyric || resp?.body?.lrc || resp?.body?.lyric || "";
      if (!lrc) return [];
      return parseLrc(lrc);
    } catch (e) {
      return [];
    }
  }
  return [];
}

function extractLyricTextFromPayload(payload) {
  const candidates = [
    payload?.lyric,
    payload?.lrc,
    payload?.lyrics,
    payload?.song_lyric,
    payload?.data?.lyric,
    payload?.data?.lrc,
    payload?.data?.lyrics,
    payload?.data?.song_lyric,
    payload?.data?.data?.lyric,
    payload?.data?.data?.lrc
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function decodeBase64Text(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch (_error) {
    return text;
  }
}

async function fetchQQOfficialLyrics(songmid) {
  const url = new URL("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg");
  url.searchParams.set("songmid", songmid);
  url.searchParams.set("pcachetime", Date.now());
  url.searchParams.set("g_tk", "5381");
  url.searchParams.set("loginUin", "0");
  url.searchParams.set("hostUin", "0");
  url.searchParams.set("format", "json");
  url.searchParams.set("inCharset", "utf8");
  url.searchParams.set("outCharset", "utf-8");
  url.searchParams.set("notice", "0");
  url.searchParams.set("platform", "yqq");
  url.searchParams.set("needNewCode", "0");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: "https://y.qq.com/",
      "User-Agent": "Mozilla/5.0"
    }
  });
  const text = await response.text();
  const jsonText = text.trim().replace(/^callback\(|^MusicJsonCallback\(|^jsonCallback\(|\)$/g, "");
  const payload = jsonText ? JSON.parse(jsonText) : {};
  const lyric = decodeBase64Text(payload.lyric || payload.data?.lyric || "");
  const trans = decodeBase64Text(payload.trans || payload.data?.trans || "");
  return lyric || trans || "";
}

async function fetchQQMusicLyrics({ id, mediaId = "", songId = "", raw = null } = {}) {
  const songmid = String(id || mediaId || raw?.songmid || raw?.mid || raw?.strMediaMid || raw?.media_mid || "").trim();
  if (!songmid) return [];
  const state = await readQQMusicState().catch(() => ({}));
  const credential = qqMusicApi1CredentialFromState(state);
  const api1Paths = [
    `/song/${encodeURIComponent(songmid)}/lyric`,
    `/song/${encodeURIComponent(songmid)}/lyrics`,
    `/song/${encodeURIComponent(songmid)}/lyric?format=lrc`,
    `/song/${encodeURIComponent(songmid)}/lyrics?format=lrc`
  ];
  if (songId) {
    api1Paths.push(`/song/${encodeURIComponent(songId)}/lyric`, `/song/${encodeURIComponent(songId)}/lyrics`);
  }
  for (const pathCandidate of api1Paths) {
    const payload = await fetchQQMusicApi1(pathCandidate, { credential }).catch(() => null);
    const lyric = extractLyricTextFromPayload(payload);
    const segments = parseLrc(lyric);
    if (segments.length) return segments;
  }
  const officialLyric = await fetchQQOfficialLyrics(songmid).catch((error) => {
    console.warn("QQ official lyric failed:", error?.message || String(error));
    return "";
  });
  const officialSegments = parseLrc(officialLyric);
  if (officialSegments.length) return officialSegments;
  try {
    const response = await qqMusicApi.api("lyric", { songmid, raw: 1 });
    const payload = response?.data || response;
    const lyric = extractLyricTextFromPayload(payload);
    return parseLrc(lyric);
  } catch (error) {
    console.warn("QQ lyric fallback failed:", error?.message || error?.errMsg || JSON.stringify(error || {}));
    return [];
  }
}

function lyricAtTime(segments = [], currentTime = 0) {
  const time = Number(currentTime || 0);
  if (!Array.isArray(segments) || !segments.length || !Number.isFinite(time)) return null;
  return segments.find((segment) => time >= Number(segment.start || 0) && time < Number(segment.end || Number(segment.start || 0) + 4))
    || [...segments].reverse().find((segment) => Number(segment.start || 0) <= time)
    || null;
}

function parseJsonFromModel(text) {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_inner) {}
    }
    return null;
  }
}

async function chooseBestPlaylist({ prompt, playlists, memory }) {
  if (!playlists?.length) return null;
  const playlistLines = playlists.slice(0, 60).map((playlist, index) => {
    const parts = [
      `${index + 1}. ${playlist.name}`,
      playlist.description ? `- ${playlist.description}` : "",
      playlist.creator ? `- by ${playlist.creator}` : "",
      playlist.trackCount ? `- ${playlist.trackCount} 首` : ""
    ].filter(Boolean);
    return parts.join(" ");
  });

  if (!process.env.OPENAI_API_KEY) {
    return playlists[0];
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个音乐歌单检索助手。请优先按场景匹配候选网易云歌单：关注安静/专注/夜晚/通勤/运动/睡前/做饭等用途，再看情绪、节奏、人声密度和氛围，不要只按字面关键词。只从候选歌单中选择最符合用户输入的一张，输出小写 json 对象，不要编造不存在的歌单。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            rememberedPreferences: memory.profile,
            playlists: playlistLines,
            schema: {
              selectedIndex: "从 1 开始的歌单索引",
              reason: "一句简短原因"
            }
          })
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonFromModel(content);
    const index = Number(parsed.selectedIndex);
    if (Number.isFinite(index) && index >= 1 && index <= playlists.length) {
      return playlists[index - 1];
    }
  } catch (err) {
    console.warn("chooseBestPlaylist failed", err?.message || err);
  }

  return playlists[0];
}

async function chooseBestPlaylists({ prompt, playlists, memory, maxCount = 4 }) {
  if (!playlists?.length) return [];
  const playlistLines = playlists.slice(0, 60).map((playlist, index) => {
    const parts = [
      `${index + 1}. ${playlist.name}`,
      playlist.description ? `- ${playlist.description}` : "",
      playlist.creator ? `- by ${playlist.creator}` : "",
      playlist.trackCount ? `- ${playlist.trackCount} 首` : ""
    ].filter(Boolean);
    return parts.join(" ");
  });

  if (!process.env.OPENAI_API_KEY) {
    return playlists.slice(0, Math.min(maxCount, playlists.length));
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个音乐歌单混编助手。请优先按场景互补地挑 2 到 4 张候选网易云歌单：让它们共同服务一个明确场景，而不是简单挑最热或最像关键词的。要考虑情绪层次、节奏过渡、能量曲线和人声密度，输出小写 json 对象，不要编造不存在的歌单。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            rememberedPreferences: memory.profile,
            playlists: playlistLines,
            schema: {
              selectedIndices: "从 1 开始的歌单索引数组，长度 2 到 4",
              reason: "一句简短原因"
            }
          })
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonFromModel(content);
    const indices = Array.isArray(parsed.selectedIndices)
      ? parsed.selectedIndices.map((value) => Number(value)).filter((index) => Number.isFinite(index) && index >= 1 && index <= playlists.length)
      : [];
    const uniqueIndices = [...new Set(indices)].slice(0, maxCount);
    if (uniqueIndices.length >= 2) {
      return uniqueIndices.map((index) => playlists[index - 1]).filter(Boolean);
    }
  } catch (err) {
    console.warn("chooseBestPlaylists failed", err?.message || err);
  }

  return playlists.slice(0, Math.min(maxCount, playlists.length));
}

async function generatePodcastBrief({ prompt, trackTitle, memory }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      title: trackTitle || "Monday Night Exhale",
      artist: "Agentio",
      episodeTitle: "今晚的轻声引言",
      scene: "专注、放松、微弱背景音乐",
      durationSeconds: 84,
      script: `把音乐放轻一点。你要的感觉我听见了，先让这段陪你慢慢进入状态。`,
      memoryPatch: {
        favoriteScenes: ["专注", "夜晚", "轻播客"],
        musicTaste: ["柔和", "低音量背景"],
        narrationStyle: "短播客开场，温柔克制"
      }
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个音乐播客 Agent。把用户的音乐需求改写成一段很短的中文播客旁白，真实、具体、克制，不能覆盖整首歌。输出小写 json 对象。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            trackTitle,
            rememberedPreferences: memory.profile,
            schema: {
              title: "歌曲名，未知则起一个适合当前场景的名字",
              artist: "艺术家，未知则为 云韶",
              episodeTitle: "播客片段标题，中文或英文均可",
              scene: "适合的场景标签",
              durationSeconds: "旁白建议长度，50 到 110 秒",
              script: "一段真人朗读文本，不超过 320 个中文字",
              memoryPatch: {
                favoriteScenes: "从这次需求提取的场景偏好数组",
                musicTaste: "从这次需求提取的音乐审美数组",
                narrationStyle: "用户偏好的旁白风格"
              }
            }
          })
        }
      ]
    });

    const content = response.choices[0]?.message?.content || "{}";
    return parseJsonFromModel(content);
  } catch (err) {
    console.warn("generatePodcastBrief: OpenAI failed, falling back", err?.message || err);
    return {
      title: trackTitle || "Monday Night Exhale",
      artist: "云韶",
      episodeTitle: "今晚的轻声引言",
      scene: "专注、放松、微弱背景音乐",
      durationSeconds: 84,
      script: `把音乐放轻一点。你要的感觉我听见了，先让这段陪你慢慢进入状态。`,
      memoryPatch: {
        favoriteScenes: ["专注", "夜晚", "轻播客"],
        musicTaste: ["柔和", "低音量背景"],
        narrationStyle: "短播客开场，温柔克制"
      }
    };
  }
}

function getMusicEndpoint(platform = defaultMusicPlatform) {
  if (!musicApiBaseUrl) return "";
  const cleanPlatform = String(platform || defaultMusicPlatform).replace(/[^a-z0-9_-]/gi, "");
  return `${musicApiBaseUrl}/${cleanPlatform}.php`;
}

function getLocalMusicScript(platform = defaultMusicPlatform) {
  const cleanPlatform = String(platform || defaultMusicPlatform).replace(/[^a-z0-9_-]/gi, "");
  const scriptPath = path.join(localMusicApiDir, `${cleanPlatform}.php`);
  return existsSync(scriptPath) ? scriptPath : "";
}

function wpPlatformPath(platform = defaultMusicPlatform) {
  const map = {
    qq: "qq",
    netease: "wy",
    wy: "wy",
    kuwo: "kuwo",
    kugou: "kugou",
    migu: "migu"
  };
  return map[String(platform || "").toLowerCase()] || String(platform || defaultMusicPlatform).replace(/[^a-z0-9_-]/gi, "");
}

async function fetchWpMusicApi(pathname, params = {}) {
  if (!wpMusicApiBaseUrl) return null;
  const url = new URL(pathname.replace(/^\//, ""), `${wpMusicApiBaseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`wp_MusicApi failed: ${response.status}`);
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error("wp_MusicApi returned invalid JSON");
  }
}

async function fetchQQMusicApi1(pathname, { method = "GET", params = {}, body, credential } = {}) {
  if (!qqMusicApi1BaseUrl) return null;
  const url = new URL(pathname.replace(/^\//, ""), `${qqMusicApi1BaseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const headers = { Accept: "application/json" };
  const cookie = credentialCookieFromQQMusicApi1Credential(credential);
  if (cookie) headers.Cookie = cookie;
  if (credential?.musicid) headers.musicid = String(credential.musicid);
  if (credential?.musickey) headers.musickey = String(credential.musickey);
  if (body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error("QQMusicApi1 returned invalid JSON");
  }
  if (!response.ok || payload?.code === -1) {
    throw new Error(payload?.msg || `QQMusicApi1 failed: ${response.status}`);
  }
  return payload?.data ?? payload;
}

function credentialCookieFromQQMusicApi1Credential(credential = null) {
  const item = credential || {};
  const pairs = [
    ["musicid", item.musicid],
    ["musickey", item.musickey],
    ["openid", item.openid],
    ["refresh_token", item.refresh_token],
    ["access_token", item.access_token],
    ["expired_at", item.expired_at],
    ["unionid", item.unionid],
    ["str_musicid", item.str_musicid],
    ["refresh_key", item.refresh_key]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("; ");
}

function normalizeQQMusicApi1Credential(credential = {}) {
  return {
    musicid: Number(credential.musicid || credential.musicID || 0) || 0,
    musickey: credential.musickey || credential.music_key || "",
    openid: credential.openid || "",
    refresh_token: credential.refresh_token || credential.refreshToken || "",
    access_token: credential.access_token || credential.accessToken || "",
    expired_at: Number(credential.expired_at || credential.expiredAt || 0) || 0,
    unionid: credential.unionid || "",
    str_musicid: credential.str_musicid || credential.strMusicid || String(credential.musicid || ""),
    refresh_key: credential.refresh_key || credential.refreshKey || "",
    raw: credential
  };
}

function normalizeWpSearchResponse(payload, platform) {
  const candidates =
    payload?.req?.data?.body?.song?.list ||
    payload?.req?.data?.body?.list ||
    payload?.data?.song?.list ||
    payload?.data?.list ||
    payload?.song?.list ||
    payload?.list ||
    [];
  const list = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
  return list.map((item, sourceIndex) => normalizeSearchItem({
    ...item,
    id: item.mid || item.songmid || item.id || item.songid,
    title: item.name || item.songname || item.title,
    artist: item.singer?.map?.((entry) => entry.name).join(" / ") || item.singername || item.artist,
    album: item.album?.name || item.albumname || item.album,
    cover: item.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album.mid}.jpg` : item.cover,
    duration: item.interval || item.duration,
    sourceIndex
  }, platform)).filter((item) => item.id || item.url);
}

function unwrapQQMusicApi1Items(payload) {
  return (
    payload?.items ||
    payload?.list ||
    payload?.songs ||
    payload?.song?.list ||
    payload?.body?.song?.list ||
    payload?.data?.items ||
    payload?.data?.list ||
    payload?.data?.song?.list ||
    []
  );
}

function normalizeQQMusicApi1SearchResponse(payload) {
  const candidates = unwrapQQMusicApi1Items(payload);
  const list = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
  return list.map((item, sourceIndex) => {
    const albumMid = item.album?.mid || item.albummid || item.album_mid || "";
    const artist = item.singer?.map?.((entry) => entry.name).filter(Boolean).join(" / ") || item.singername || item.artist || "";
    return normalizeSearchItem({
      ...item,
      id: item.mid || item.songmid || item.id || item.songid,
      title: item.name || item.title || item.songname,
      artist,
      album: item.album?.name || item.albumname || item.album,
      cover: item.cover || item.pic || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : ""),
      duration: item.interval || item.duration,
      sourceIndex,
      qqSearchKey: item.qqSearchKey || item.keyword || ""
    }, "qq");
  }).filter((item) => item.id || item.url);
}

async function searchQQMusicApi1({ keyword, count = 10, page = 1 }) {
  if (!qqMusicApi1BaseUrl) return null;
  const payload = await fetchQQMusicApi1("/search/search_by_type", {
    params: {
      keyword,
      search_type: 0,
      num: count,
      page
    }
  });
  return normalizeQQMusicApi1SearchResponse(payload);
}

function pickMusicsquareTangQQUrl(item = {}) {
  return (
    item.song_play_url_sq ||
    item.song_play_url_pq ||
    item.song_play_url_accom ||
    item.song_play_url_hq ||
    item.song_play_url_standard ||
    item.song_play_url_fq ||
    item.song_play_url ||
    ""
  );
}

function normalizeMusicsquareTangQQSearchResponse(payload, keyword) {
  const candidates = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return candidates.map((item, sourceIndex) => {
    const mid = item.song_mid || item.songmid || item.mid || item.id || "";
    return normalizeSearchItem({
      ...item,
      id: mid,
      songmid: mid,
      title: item.song_title || item.song_name || item.title || item.name,
      artist: item.singer_name || item.singer || item.artist,
      album: item.album_name || item.album_title || item.album,
      cover: item.album_pic || item.singer_pic || item.cover,
      duration: item.duration || item.interval,
      url: "",
      qqSearchKey: keyword,
      sourceIndex
    }, "qq");
  }).filter((item) => item.id || item.url);
}

async function searchMusicsquareQQ({ keyword, count = 10 }) {
  const url = new URL("https://tang.api.s01s.cn/music_open_api.php");
  url.searchParams.set("msg", keyword);
  url.searchParams.set("type", "json");
  const payload = await fetchJsonWithTimeout(url);
  return normalizeMusicsquareTangQQSearchResponse(payload, keyword).slice(0, count);
}

async function searchMusicsquareNetease({ keyword, count = 10 }) {
  const url = new URL("https://api.qijieya.cn/meting/");
  url.searchParams.set("type", "search");
  url.searchParams.set("id", keyword);
  url.searchParams.set("limit", String(count));
  url.searchParams.set("server", "netease");
  const payload = await fetchJsonWithTimeout(url);
  const list = Array.isArray(payload) ? payload : [];
  return list.map((item, sourceIndex) => {
    let id = "";
    try {
      id = new URL(item.url || "", "https://api.qijieya.cn").searchParams.get("id") || "";
    } catch (_error) {}
    return normalizeSearchItem({
      ...item,
      id,
      title: item.name,
      artist: item.artist,
      cover: item.pic,
      url: item.url || "",
      sourceIndex
    }, "netease");
  }).filter((item) => item.id || item.url);
}

async function searchMusicsquareKuwo({ keyword, count = 10 }) {
  const url = new URL("https://kw-api.cenguigui.cn/");
  url.searchParams.set("name", keyword);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", String(count));
  const payload = await fetchJsonWithTimeout(url);
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list.map((item, sourceIndex) => normalizeSearchItem({
    ...item,
    id: item.rid,
    title: item.name,
    artist: item.artist,
    album: item.album,
    cover: item.pic,
    sourceIndex
  }, "kuwo")).filter((item) => item.id || item.url);
}

async function searchMusicsquareThirdParty({ keyword, platform, count = 10 }) {
  if (platform === "qq") return searchMusicsquareQQ({ keyword, count });
  if (platform === "netease") return searchMusicsquareNetease({ keyword, count });
  if (platform === "kuwo") return searchMusicsquareKuwo({ keyword, count });
  return [];
}

function normalizeArtistName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·・.。]/g, "")
    .trim();
}

function primarySearchArtist(item) {
  return String(item?.artist || item?.singer || "未知艺人").split(/[\/,&、，;；]/)[0].trim();
}

function artistMatchesKeyword(item, keyword) {
  const artist = normalizeArtistName(item?.artist || item?.singer || primarySearchArtist(item));
  const target = normalizeArtistName(keyword);
  return Boolean(target && (artist.includes(target) || target.includes(artist)));
}

async function searchNeteaseArtistCatalog(keyword, count) {
  const artistResp = await neteaseApi.cloudsearch({
    keywords: keyword,
    type: 100,
    limit: 6,
    offset: 0
  }).catch((error) => {
    console.warn("netease artist cloudsearch failed:", error.message);
    return null;
  });
  const artists = artistResp?.body?.result?.artists || [];
  const target = normalizeArtistName(keyword);
  const artist = artists.find((item) => normalizeArtistName(item.name) === target) || artists.find((item) => normalizeArtistName(item.name).includes(target) || target.includes(normalizeArtistName(item.name))) || artists[0];
  if (!artist?.id) return [];
  const songsResp = await neteaseApi.artist_songs({
    id: artist.id,
    order: "hot",
    limit: Math.min(100, Math.max(count, 60)),
    offset: 0
  }).catch((error) => {
    console.warn("netease artist_songs failed:", error.message);
    return null;
  });
  const songs = songsResp?.body?.songs || songsResp?.body?.data?.songs || [];
  return songs.map((item, sourceIndex) => normalizeSearchItem({
    ...item,
    sourceIndex,
    artist: item.ar?.map?.((entry) => entry.name).join(" / ") || artist.name,
    cover: item.al?.picUrl || item.cover || "",
    album: item.al?.name || item.album || ""
  }, "netease")).filter((item) => item.id);
}

async function searchGlobalArtistSongs({ keyword, platform, count }) {
  const expandedCount = Math.min(80, Math.max(count * 3, 48));
  if (platform === "netease") {
    const catalog = await searchNeteaseArtistCatalog(keyword, expandedCount);
    if (catalog.length) return catalog;
  }
  const direct = await searchMusicsquareThirdParty({ keyword, platform, count: expandedCount }).catch((error) => {
    console.warn(`artist direct third-party search failed on ${platform}:`, error.message);
    return [];
  });
  const fallback = direct.length
    ? []
    : await searchMusic({ keyword, platform, count: expandedCount, page: 1 }).catch((error) => {
        console.warn(`artist direct fallback search failed on ${platform}:`, error.message);
        return [];
      });
  const directItems = (direct.length ? direct : fallback).filter((item) => artistMatchesKeyword(item, keyword));
  const seedTitles = directItems.slice(0, 8).map((item) => item.title).filter(Boolean);
  const relatedGroups = await Promise.all(
    seedTitles.map((title) => searchMusicsquareThirdParty({ keyword: `${keyword} ${title}`, platform, count: 12 }).catch(() => []))
  );
  return [...directItems, ...relatedGroups.flat().filter((item) => artistMatchesKeyword(item, keyword))].slice(0, expandedCount);
}

async function searchWpMusic({ keyword, platform, count = 10, page = 1 }) {
  if (!wpMusicApiBaseUrl) return null;
  const wpPlatform = wpPlatformPath(platform);
  if (wpPlatform === "qq") {
    const payload = await fetchWpMusicApi("/v1/qq/search", {
      key: keyword,
      limit: count,
      offset: page,
      type: 0
    });
    return normalizeWpSearchResponse(payload, "qq");
  }
  const payload = await fetchWpMusicApi(`/v1/${wpPlatform}/search`, {
    key: keyword,
    limit: count,
    offset: page
  }).catch(() => null);
  return payload ? normalizeSearchResponse(payload, platform) : null;
}

async function resolveWpMusicUrl({ id, platform, br = "m4a" }) {
  if (!wpMusicApiBaseUrl || !id) return "";
  const wpPlatform = wpPlatformPath(platform);
  if (wpPlatform === "qq") {
    for (const currentBr of [br, "320", "128"].filter(Boolean)) {
      const payload = await fetchWpMusicApi("/v1/qq/song", { mid: id, br: currentBr }).catch(() => null);
      const candidate = Array.isArray(payload?.data?.url) ? payload.data.url.find(Boolean) : payload?.data?.url || payload?.url || "";
      if (isPlayableMusicUrl(candidate)) return candidate;
    }
    return "";
  }
  const payload = await fetchWpMusicApi(`/v1/${wpPlatform}/song`, { mid: id, id, br }).catch(() => null);
  const candidate = payload?.data?.url || payload?.url || payload?.data?.song_url || "";
  return isPlayableMusicUrl(candidate) ? candidate : "";
}

async function resolveQQMusicApi1Url({ id, mediaId = "", songType = null }) {
  if (!qqMusicApi1BaseUrl || !id) return "";
  const state = await readQQMusicState().catch(() => ({}));
  const credential = state?.api1Credential || null;
  for (const fileType of [5, 4, 3, 2, 1]) {
    const payload = await fetchQQMusicApi1(`/song/${encodeURIComponent(id)}/url`, {
      params: {
        file_type: fileType,
        song_type: songType || "",
        media_mid: mediaId || ""
      },
      credential
    }).catch(() => null);
    const first = Array.isArray(payload?.data) ? payload.data[0] : Array.isArray(payload?.midurlinfo) ? payload.midurlinfo[0] : null;
    const candidate =
      first?.url ||
      first?.purl && `https://isure.stream.qqmusic.qq.com/${first.purl}` ||
      payload?.url ||
      "";
    const verified = await pickVerifiedMusicUrl(candidate, `QQMusicApi1 file_type=${fileType}`);
    if (verified) return verified;
  }
  return "";
}

const qqMusicOfficialQualities = [
  ["AI00", ".flac"],
  ["Q000", ".flac"],
  ["Q001", ".flac"],
  ["F000", ".flac"],
  ["O801", ".ogg"],
  ["O800", ".ogg"],
  ["O600", ".ogg"],
  ["O400", ".ogg"],
  ["M800", ".mp3"],
  ["M500", ".mp3"],
  ["C600", ".m4a"],
  ["C400", ".m4a"],
  ["C200", ".m4a"]
];

const qqMusicEncryptedQualities = [
  ["AIM0", ".mflac"],
  ["Q0M0", ".mflac"],
  ["Q0M1", ".mflac"],
  ["F0M0", ".mflac"],
  ["O801", ".mgg"],
  ["O800", ".mgg"],
  ["O6M0", ".mgg"],
  ["O4M0", ".mgg"]
];

function randomQQGuid() {
  return crypto.randomBytes(16).toString("hex");
}

function qqMusicCredentialFromStateForOfficial(state = {}) {
  const credential = qqMusicApi1CredentialFromState(state);
  if (credential?.musicid && credential?.musickey) return credential;
  const cookies = cookieObjectFromList(state.cookies || []);
  return normalizeQQMusicApi1Credential({
    ...cookies,
    musicid: cookies.musicid || cookies.uin || state.uin,
    musickey: cookies.musickey || cookies.qqmusic_key || cookies.qm_keyst
  });
}

function buildQQMusicOfficialRequest({ params, module, method, credential, encrypted = false }) {
  const comm = {
    ct: encrypted ? "19" : "11",
    tmeAppID: "qqmusic",
    format: "json",
    inCharset: "utf-8",
    outCharset: "utf-8",
    uid: "3931641530",
    cv: 13020508,
    v: 13020508,
    QIMEI36: "6c9d3cd110abca9b16311cee10001e717614"
  };
  if (credential?.musicid && credential?.musickey) {
    comm.qq = String(credential.musicid);
    comm.authst = String(credential.musickey);
    comm.tmeLoginType = String(credential.login_type || credential.loginType || (String(credential.musickey).startsWith("W_X") ? 1 : 2));
  }
  return {
    comm,
    [`${module}.${method}`]: {
      module,
      method,
      param: params
    }
  };
}

async function fetchQQMusicOfficialUrl({ id, mediaId = "", encrypted = false, songType = 0 }) {
  const state = await readQQMusicState().catch(() => ({}));
  const credential = qqMusicCredentialFromStateForOfficial(state);
  const guid = randomQQGuid();
  const qualities = encrypted ? qqMusicEncryptedQualities : qqMusicOfficialQualities;
  const endpoint = encrypted ? "https://u.y.qq.com/cgi-bin/musics.fcg" : "https://u.y.qq.com/cgi-bin/musicu.fcg";
  const module = encrypted ? "music.vkey.GetEVkey" : "music.vkey.GetVkey";
  const method = encrypted ? "CgiGetEVkey" : "UrlGetVkey";
  const resultPath = encrypted
    ? ["music.vkey.GetEVkey.CgiGetEVkey", "data", "midurlinfo", 0]
    : ["music.vkey.GetVkey.UrlGetVkey", "data", "midurlinfo", 0];
  const fileMid = mediaId || id;

  for (const [prefix, ext] of qualities) {
    const filename = `${prefix}${fileMid}${fileMid}${ext}`;
    const body = buildQQMusicOfficialRequest({
      encrypted,
      credential,
      module,
      method,
      params: {
        filename: [filename],
        guid,
        songmid: [id],
        songtype: [Number(songType) || 0]
      }
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Content-Type": "application/json",
        Referer: "https://y.qq.com/",
        Origin: "https://y.qq.com",
        "User-Agent": "Mozilla/5.0"
      },
      body: JSON.stringify(body)
    }).catch(() => null);
    if (!response?.ok) continue;
    const payload = await response.json().catch(() => null);
    const info = resultPath.reduce((acc, key) => acc?.[key], payload);
    const purl = info?.purl || info?.wifiurl || "";
    const candidate = purl ? new URL(purl, "https://isure.stream.qqmusic.qq.com/").toString() : "";
    const verified = await pickVerifiedMusicUrl(candidate, `musicdl official ${encrypted ? "EVkey" : "Vkey"} ${filename}`);
    if (verified) return verified;
  }
  return "";
}

async function resolveCharlesMusicdlOfficialQQUrl({ id, mediaId = "", songType = null }) {
  const plain = await fetchQQMusicOfficialUrl({ id, mediaId, songType, encrypted: false }).catch((error) => {
    console.warn("musicdl official Vkey fallback failed:", error.message);
    return "";
  });
  if (plain) return plain;
  return fetchQQMusicOfficialUrl({ id, mediaId, songType, encrypted: true }).catch((error) => {
    console.warn("musicdl official EVkey fallback failed:", error.message);
    return "";
  });
}

async function resolveMusicsquareTangQQUrl({ id, keyword = "" }) {
  const mid = String(id || "").trim();
  if (!mid) return "";
  const url = new URL("https://tang.api.s01s.cn/music_open_api.php");
  url.searchParams.set("msg", keyword || mid);
  url.searchParams.set("type", "json");
  url.searchParams.set("mid", mid);
  const payload = await fetchJsonWithTimeout(url);
  const candidate = pickMusicsquareTangQQUrl(payload);
  const verified = await pickVerifiedMusicUrl(candidate, "musicsquare tang qq detail");
  if (verified) return verified;
  return pickVerifiedMusicUrl(pickFirstPlayableUrl(payload), "musicsquare tang qq detail fallback");
}

async function fetchQQMusicLegacySongFile(mid) {
  if (!mid) return null;
  const url = new URL("https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg");
  url.searchParams.set("songmid", mid);
  url.searchParams.set("tpl", "yqq_song_detail");
  url.searchParams.set("format", "json");
  url.searchParams.set("callback", "getOneSongInfoCallback");
  url.searchParams.set("g_tk", "5381");
  url.searchParams.set("jsonCallback", "getOneSongInfoCallback");
  url.searchParams.set("loginUin", "0");
  url.searchParams.set("hostUin", "0");
  url.searchParams.set("inCharset", "utf8");
  url.searchParams.set("outCharset", "utf-8");
  url.searchParams.set("notice", "0");
  url.searchParams.set("platform", "yqq");
  url.searchParams.set("needNewCode", "0");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: `https://y.qq.com/n/yqq/song/${mid}.html`,
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`QQ legacy song info failed: ${response.status}`);
  const text = await response.text();
  const jsonText = text.replace(/^getOneSongInfoCallback\(|\)$/g, "");
  const payload = JSON.parse(jsonText);
  const song = Array.isArray(payload?.data) ? payload.data[0] : null;
  return song?.file || null;
}

async function fetchQQMusicLegacyVkey(mid, filename, uin = "1008611", guid = "1234567890") {
  const url = new URL("https://c.y.qq.com/base/fcgi-bin/fcg_music_express_mobile3.fcg");
  url.searchParams.set("g_tk", "0");
  url.searchParams.set("loginUin", uin);
  url.searchParams.set("hostUin", "0");
  url.searchParams.set("format", "json");
  url.searchParams.set("inCharset", "utf8");
  url.searchParams.set("outCharset", "utf-8");
  url.searchParams.set("notice", "0");
  url.searchParams.set("platform", "yqq");
  url.searchParams.set("needNewCode", "0");
  url.searchParams.set("cid", "205361747");
  url.searchParams.set("uin", uin);
  url.searchParams.set("songmid", mid);
  url.searchParams.set("filename", filename);
  url.searchParams.set("guid", guid);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: `https://y.qq.com/n/yqq/song/${mid}.html`,
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`QQ legacy vkey failed: ${response.status}`);
  const payload = await response.json();
  return payload?.data?.items?.[0]?.vkey || "";
}

async function resolveQQMusicDownloadCompatUrl({ id, mediaId = "" }) {
  const mid = String(id || "").trim();
  if (!mid) return "";
  const file = await fetchQQMusicLegacySongFile(mid).catch((error) => {
    console.warn("qqMusicDownload song info fallback failed:", error.message);
    return null;
  });
  const fileMid = mediaId || file?.media_mid || mid;
  const candidates = [
    file?.size_320mp3 ? { prefix: "M800", ext: "mp3" } : null,
    file?.size_128mp3 ? { prefix: "M500", ext: "mp3" } : null
  ].filter(Boolean);
  for (const item of candidates) {
    const filename = `${item.prefix}${fileMid}.${item.ext}`;
    const vkey = await fetchQQMusicLegacyVkey(mid, filename).catch((error) => {
      console.warn("qqMusicDownload vkey fallback failed:", error.message);
      return "";
    });
    if (!vkey) continue;
    const candidate = `http://streamoc.music.tc.qq.com/${filename}?vkey=${encodeURIComponent(vkey)}&guid=1234567890&uin=1008611&fromtag=8`;
    const verified = await pickVerifiedMusicUrl(candidate, `qqMusicDownload ${filename}`);
    if (verified) return verified;
  }
  return "";
}

async function resolveMusicDlQQCompatUrl({ id }) {
  const mid = String(id || "").trim();
  if (!mid) return "";
  const guid = String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));
  const rates = [
    { prefix: "A000", ext: "ape" },
    { prefix: "F000", ext: "flac" },
    { prefix: "M800", ext: "mp3" },
    { prefix: "C400", ext: "m4a" },
    { prefix: "M500", ext: "mp3" }
  ];
  for (const rate of rates) {
    const filename = `${rate.prefix}${mid}.${rate.ext}`;
    const vkey = await fetchQQMusicLegacyVkey(mid, filename, "3051522991", guid).catch((error) => {
      console.warn("music-dl qq vkey fallback failed:", error.message);
      return "";
    });
    if (!vkey) continue;
    const candidate = `http://dl.stream.qqmusic.qq.com/${filename}?vkey=${encodeURIComponent(vkey)}&guid=${guid}&uin=3051522991&fromtag=64`;
    const verified = await pickVerifiedMusicUrl(candidate, `music-dl ${filename}`);
    if (verified) return verified;
  }
  return "";
}

function pickFirstPlayableUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return isPlayableMusicUrl(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = pickFirstPlayableUrl(item);
      if (candidate) return candidate;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const directKeys = ["url", "music_url", "music", "download_url", "play_url", "song_play_url_sq", "song_play_url_hq", "song_play_url", "song_play_url_standard"];
  for (const key of directKeys) {
    const candidate = pickFirstPlayableUrl(value[key]);
    if (candidate) return candidate;
  }
  for (const item of Object.values(value)) {
    if (!item || typeof item !== "object") continue;
    const candidate = pickFirstPlayableUrl(item);
    if (candidate) return candidate;
  }
  return "";
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0",
        ...headers
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_error) {
      throw new Error("invalid JSON");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCharlesMusicdlQQCompatUrl({ id }) {
  if (!qqMusicCharlesMusicdlFallbackEnabled) return "";
  const mid = String(id || "").trim();
  if (!mid) return "";

  const resolvers = {
    async nki() {
      for (const key of qqMusicThirdPartyKeys.nki) {
        const url = new URL("https://api.nki.pw/API/music_open_api.php");
        url.searchParams.set("mid", mid);
        url.searchParams.set("apikey", key);
        const candidate = pickFirstPlayableUrl(await fetchJsonWithTimeout(url).catch(() => null));
        if (candidate) return candidate;
      }
      return "";
    },
    async tang() {
      const url = new URL("https://tang.api.s01s.cn/music_open_api.php");
      url.searchParams.set("mid", mid);
      return pickFirstPlayableUrl(await fetchJsonWithTimeout(url));
    },
    async xianyuw() {
      for (const key of qqMusicThirdPartyKeys.xianyuw) {
        const url = new URL("https://apii.xianyuw.cn/api/v1/qq-music-search");
        url.searchParams.set("id", mid);
        url.searchParams.set("key", key);
        url.searchParams.set("no_url", "0");
        url.searchParams.set("br", "hires");
        const candidate = pickFirstPlayableUrl(await fetchJsonWithTimeout(url).catch(() => null));
        if (candidate) return candidate;
      }
      return "";
    },
    async xunhuisi() {
      const url = new URL("https://api.xunhuisi.store/API/QQMusic/Song.php");
      url.searchParams.set("mid", mid);
      url.searchParams.set("type", "json");
      return pickFirstPlayableUrl(await fetchJsonWithTimeout(url));
    },
    async lpz() {
      const url = new URL("https://lpz.chatc.vip/apiqq.php");
      url.searchParams.set("songmid", mid);
      url.searchParams.set("type", "json");
      url.searchParams.set("br", "1");
      return pickFirstPlayableUrl(await fetchJsonWithTimeout(url));
    },
    async lxmusic() {
      for (const quality of ["flac24bit", "hires", "flac", "320k", "128k"]) {
        const url = new URL(`https://lxmusicapi.onrender.com/url/tx/${encodeURIComponent(mid)}/${quality}`);
        const candidate = pickFirstPlayableUrl(await fetchJsonWithTimeout(url, {
          headers: {
            "Content-Type": "application/json",
            "X-Request-Key": process.env.QQMUSIC_LXMUSIC_REQUEST_KEY || "share-v3",
            "User-Agent": "lx-music-request/2.6.0"
          }
        }).catch(() => null));
        if (candidate && !candidate.includes("panspace.kuwo.cn")) return candidate;
      }
      return "";
    },
    async vkeys() {
      for (const quality of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
        const url = new URL("https://api.vkeys.cn/music/tencent/song/link");
        url.searchParams.set("mid", mid);
        url.searchParams.set("quality", String(quality));
        const candidate = pickFirstPlayableUrl(await fetchJsonWithTimeout(url).catch(() => null));
        if (candidate) return candidate;
      }
      return "";
    },
    async cy() {
      for (const key of qqMusicThirdPartyKeys.cy) {
        const url = new URL("https://cyapi.top/API/qq_music.php");
        url.searchParams.set("apikey", key);
        url.searchParams.set("type", "json");
        url.searchParams.set("mid", mid);
        url.searchParams.set("quality", "lossless");
        const candidate = pickFirstPlayableUrl(await fetchJsonWithTimeout(url).catch(() => null));
        if (candidate) return candidate;
      }
      return "";
    }
  };

  for (const apiName of qqMusicCharlesMusicdlFallbackApis) {
    const resolver = resolvers[apiName];
    if (!resolver) continue;
    const candidate = await resolver().catch((error) => {
      console.warn(`CharlesPikachu/musicdl ${apiName} fallback failed:`, error.message);
      return "";
    });
    const verified = await pickVerifiedMusicUrl(candidate, `CharlesPikachu/musicdl ${apiName}`);
    if (verified) return verified;
  }
  return "";
}

async function runLocalMusicScript(platform, params) {
  const scriptPath = getLocalMusicScript(platform);
  if (!scriptPath) return null;

  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });

  const runner = `parse_str($argv[1], $_GET); include $argv[2];`;
  const { stdout } = await execFileAsync("php", ["-r", runner, query.toString(), scriptPath], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000
  });
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("Local music API returned no JSON");
  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

async function probeRemoteDuration(url) {
  if (!url) return 0;
  try {
    const { stdout } = await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url], { timeout: 15000 });
    const trimmed = String(stdout || "").trim();
    const num = Number.parseFloat(trimmed || "0");
    return Number.isFinite(num) ? num : 0;
  } catch (err) {
    return 0;
  }
}

function normalizeSearchItem(item, platform) {
  const artist =
    item.artist ||
    item.author ||
    item.singer ||
    item.singers ||
    item.singername ||
    item.name?.artist ||
    item.ar?.map?.((entry) => entry.name).join(" / ") ||
    "";

  return {
    id: item.id || item.songid || item.songmid || item.mid || item.rid || item.hash || item.url_id || item.musicrid,
    title: item.title || item.name || item.songname || item.songName || item.filename || "未命名歌曲",
    artist: Array.isArray(artist) ? artist.join(" / ") : String(artist || "未知艺人"),
    album: item.album || item.albumname || item.al?.name || "",
    cover: item.pic || item.cover || item.albumPic || item.album_img || item.al?.picUrl || "",
    duration: item.duration || item.interval || item.time || 0,
    url: item.url || item.music_url || item.play_url || item.song_url || "",
    platform,
    sourceIndex: item.sourceIndex,
    qqSearchKey: item.qqSearchKey || item.keyword || "",
    raw: item
  };
}

function normalizeSearchResponse(payload, platform) {
  const candidates = payload?.data?.list || payload?.data?.songs || payload?.data || payload?.list || payload?.result?.songs || [];
  const list = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
  return list.map((item, sourceIndex) => normalizeSearchItem({ ...item, sourceIndex }, platform)).filter((item) => item.id || item.url);
}

function isPlayableMusicUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) && !url.includes("付费歌曲");
}

function looksLikeAudioBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  const head = buffer.subarray(0, 16);
  const ascii = head.toString("utf8").trimStart().toLowerCase();
  if (ascii.startsWith("<!doctype") || ascii.startsWith("<html") || ascii.startsWith("{") || ascii.startsWith("[")) return false;
  return (
    head.subarray(0, 3).toString("latin1") === "ID3" ||
    head[0] === 0xff && (head[1] & 0xe0) === 0xe0 ||
    head.subarray(0, 4).toString("latin1") === "fLaC" ||
    head.subarray(0, 4).toString("latin1") === "OggS" ||
    head.subarray(0, 4).toString("latin1") === "RIFF" ||
    head.subarray(4, 8).toString("latin1") === "ftyp"
  );
}

function summarizeNonAudioPayload(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.subarray(0, 240).toString("utf8").replace(/\s+/g, " ").trim() : "";
  if (/^\s*</.test(text)) return "下载到的是 HTML 页面，可能是音乐外链防盗链或接口错误页";
  if (/^\s*[\[{]/.test(text)) return `下载到的是 JSON 错误响应：${text.slice(0, 160)}`;
  return text ? `下载到的不是音频：${text.slice(0, 160)}` : "下载到的不是音频";
}

async function verifyRemoteMusicUrl(url, label = "music url") {
  if (!isPlayableMusicUrl(url)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        Range: "bytes=0-65535",
        ...musicDownloadHeaders(url)
      },
      signal: controller.signal
    });
    if (!response.ok && response.status !== 206) {
      console.warn(`${label} preflight failed: HTTP ${response.status}`);
      return false;
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (/text\/html|application\/json|text\/plain/i.test(contentType) && !looksLikeAudioBuffer(buffer)) {
      console.warn(`${label} preflight rejected: ${contentType} ${summarizeNonAudioPayload(buffer)}`);
      return false;
    }
    if (looksLikeAudioBuffer(buffer)) return true;
    if (/audio\//i.test(contentType) && buffer.length > 0) return true;
    console.warn(`${label} preflight rejected: ${summarizeNonAudioPayload(buffer)}`);
    return false;
  } catch (error) {
    console.warn(`${label} preflight failed:`, error.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function pickVerifiedMusicUrl(url, label) {
  return (await verifyRemoteMusicUrl(url, label)) ? url : "";
}

async function searchMusic({ keyword, platform, count = 10, page = 1 }) {
  if (platform === "qq") {
    const api1Items = await searchQQMusicApi1({ keyword, count, page }).catch((error) => {
      console.warn("QQMusicApi1 search failed:", error.message);
      return null;
    });
    if (api1Items?.length) return api1Items;

    const tangItems = await searchMusicsquareQQ({ keyword, count }).catch((error) => {
      console.warn("musicsquare tang qq search failed:", error.message);
      return null;
    });
    if (tangItems?.length) return tangItems;
  }

  const wpItems = await searchWpMusic({ keyword, platform, count, page }).catch((error) => {
    console.warn(`wp_MusicApi search failed on ${platform}:`, error.message);
    return null;
  });
  if (wpItems?.length) return wpItems;

  const localPayload = await runLocalMusicScript(platform, {
    msg: keyword,
    type: "song",
    count,
    page
  }).catch(() => null);
  if (localPayload) return normalizeSearchResponse(localPayload, platform);

  if (!musicApiBaseUrl) {
    return [
      {
        id: "demo-night-exhale",
        title: keyword || "Monday Night Exhale",
      artist: "云韶 Demo",
        album: "Local generated ambience",
        duration: 75,
        url: "",
        platform: "demo"
      }
    ];
  }

  const endpoint = getMusicEndpoint(platform);
  const url = new URL(endpoint);
  url.searchParams.set("msg", keyword);
  url.searchParams.set("type", "song");
  url.searchParams.set("count", count);
  url.searchParams.set("page", page);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Music API search failed: ${response.status}`);
  const payload = await response.json();
  return normalizeSearchResponse(payload, platform);
}

async function resolveMusicUrl({ id, url: directUrl, platform, mediaId = "", songType = null, keyword = "" }) {
  if (isPlayableMusicUrl(directUrl)) {
    const verifiedDirect = await pickVerifiedMusicUrl(directUrl, `${platform || "music"} direct url`);
    if (verifiedDirect) return verifiedDirect;
  }
  if (!id || platform === "demo") return "";

  if (platform === "qq") {
    const tangDetailUrl = await resolveMusicsquareTangQQUrl({ id, keyword }).catch((error) => {
      console.warn("musicsquare tang qq resolve failed:", error.message);
      return "";
    });
    if (isPlayableMusicUrl(tangDetailUrl)) return tangDetailUrl;
    return "";
  }

  const wpUrl = await resolveWpMusicUrl({ id, platform }).catch((error) => {
    console.warn(`wp_MusicApi resolve failed on ${platform}:`, error.message);
    return "";
  });
  if (isPlayableMusicUrl(wpUrl)) return wpUrl;

  // 网易云优先使用登录态获取完整版，避免本地 PHP 外链接口返回 45s 试听
  if (platform === "netease") {
    try {
      const state = await readNeteaseState();
      const cookie = cookieHeaderFromState(state);
      if (cookie) {
        try {
          const v1Resp = await neteaseApi.song_url_v1?.({ id, cookie, level: "exhigh" }).catch(() => null);
          const candidate = v1Resp?.body?.data?.[0]?.url || "";
          if (isPlayableMusicUrl(candidate)) {
            const dur = await probeRemoteDuration(candidate).catch(() => 0);
            if (!dur || dur >= 60) return candidate;
          }
        } catch (e) {}
        try {
          const oldResp = await neteaseApi.song_url?.({ id, cookie }).catch(() => null);
          const candidate = oldResp?.body?.data?.[0]?.url || oldResp?.body?.data?.[0]?.mp3Url || "";
          if (isPlayableMusicUrl(candidate)) {
            const dur = await probeRemoteDuration(candidate).catch(() => 0);
            if (!dur || dur >= 60) return candidate;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  if (platform === "qq") {
    try {
      const state = await readQQMusicState();
      if (state.cookies?.length) {
        const payload = await qqMusicApiCall("song/url", { id, type: "m4a" }, state).catch(() => "");
        const candidate = typeof payload === "string" ? payload : payload?.url || payload?.data || "";
        if (isPlayableMusicUrl(candidate)) return candidate;
      }
    } catch (e) {}
  }

  const localPayload = await runLocalMusicScript(platform, {
    id,
    type: "songid"
  }).catch(() => null);
  if (localPayload) {
    const data = localPayload?.data;
    const url = localPayload?.song_url || localPayload?.url || data?.song_url || data?.url || data?.play_url || "";
    return isPlayableMusicUrl(url) ? url : "";
  }

  if (!musicApiBaseUrl) return "";

  if (platform === "netease") {
    const matchEndpoint = new URL(`${musicApiBaseUrl}/song/url/match`);
    matchEndpoint.searchParams.set("id", id);
    matchEndpoint.searchParams.set("level", "exhigh");
    matchEndpoint.searchParams.set("unblock", "true");
    matchEndpoint.searchParams.set("os", "pc");

    const response = await fetch(matchEndpoint, {
      headers: {
        Cookie: "os=pc",
        Accept: "application/json"
      }
    });
    if (response.ok) {
      const payload = await response.json().catch(async () => ({ url: await response.text() }));
      const resolvedUrl =
        (Array.isArray(payload?.data) ? payload?.data[0]?.url : payload?.data) ||
        payload?.url ||
        payload?.song_url ||
        payload?.music_url ||
        payload?.play_url ||
        "";
      if (isPlayableMusicUrl(resolvedUrl)) {
        const dur = await probeRemoteDuration(resolvedUrl).catch(() => 0);
        if (!dur || dur < 60) {
          // preview detected, try v1 endpoint to fetch higher-quality/full url
          const v1 = new URL(`${musicApiBaseUrl}/song/url/v1`);
          v1.searchParams.set("id", id);
          v1.searchParams.set("level", "exhigh");
          v1.searchParams.set("unblock", "true");
          v1.searchParams.set("os", "pc");
          const r1 = await fetch(v1, { headers: { Cookie: "os=pc", Accept: "application/json" } }).catch(() => null);
          if (r1 && r1.ok) {
            const p1 = await r1.json().catch(async () => ({ url: await r1.text() }));
            const alt = (Array.isArray(p1?.data) ? p1?.data[0]?.url : p1?.data) || p1?.url || p1?.song_url || p1?.music_url || "";
            if (isPlayableMusicUrl(alt)) return alt;
          }
        }
        return resolvedUrl;
      }
    }
  }

  const endpoint = getMusicEndpoint(platform);
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set("id", id);
  requestUrl.searchParams.set("type", "songid");

  const response = await fetch(requestUrl);
  if (!response.ok) throw new Error(`Music API resolve failed: ${response.status}`);
  const payload = await response.json().catch(async () => ({ url: await response.text() }));
  const resolvedUrl = payload?.song_url || payload?.url || payload?.data?.song_url || payload?.data?.url || payload?.data?.play_url || payload?.music_url || payload?.play_url || "";
  return isPlayableMusicUrl(resolvedUrl) ? resolvedUrl : "";
}

async function resolveMusicFromSearchIndex({ keyword, sourceIndex, platform }) {
  const localPayload = await runLocalMusicScript(platform, {
    msg: keyword,
    type: "song",
    count: Math.max(8, Number(sourceIndex || 0) + 1),
    page: 1,
    n: sourceIndex
  }).catch(() => null);
  const data = localPayload?.data;
  const url = data?.song_url || localPayload?.song_url || "";
  return isPlayableMusicUrl(url)
    ? {
        musicUrl: url,
        trackTitle: data?.name || "",
        artist: data?.singername || "",
        platform,
        id: data?.id || localPayload?.id
      }
    : null;
}

async function findBackgroundMusic({ prompt, trackTitle, platform }) {
  const keyword = (trackTitle || prompt || "").trim();
  if (!keyword) return { musicUrl: "", trackTitle: "", artist: "", platform };

  for (const currentPlatform of [platform, ...musicPlatforms].filter((item, index, arr) => item && arr.indexOf(item) === index)) {
    const items = await searchMusic({ keyword, platform: currentPlatform, count: 5, page: 1 }).catch((error) => {
      console.warn(`Background music search failed on ${currentPlatform}:`, error.message);
      return [];
    });
    for (const selected of items.filter((item) => item.url || item.id)) {
      const musicUrl = await resolveMusicUrl({
        id: selected.id,
        url: selected.url,
        platform: selected.platform || currentPlatform,
        keyword: selected.qqSearchKey || keyword
      }).catch((error) => {
        console.warn(`Background music resolve failed on ${selected.platform || currentPlatform}:`, error.message);
        return "";
      });
      if (musicUrl) {
        return {
          musicUrl,
          trackTitle: selected.title,
          artist: selected.artist,
          platform: selected.platform || currentPlatform,
          id: selected.id
        };
      }
      const indexed = await resolveMusicFromSearchIndex({
        keyword,
        sourceIndex: selected.sourceIndex,
        platform: selected.platform || currentPlatform
      });
      if (indexed) return indexed;
    }
  }

  return { musicUrl: "", trackTitle: "", artist: "", platform };
}

function buildMusicSearchKeywords(text) {
  const normalized = String(text || "")
    .replace(/[《》"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const keywords = [];
  const directSongMatch = normalized.match(/的([^，,。；;]+?)(?:适合|用来|拿来|作为|背景|旁白|播客|$)/);
  if (directSongMatch?.[1]) keywords.push(directSongMatch[1].trim());
  const beforeScene = normalized.split(/[，,。；;]|适合|用来|拿来|作为|背景|旁白|播客/)[0]?.trim();
  if (beforeScene && beforeScene !== normalized) keywords.push(beforeScene);

  const listenMatch = normalized.match(/(?:想听|听|播放|放)(?:一下|一首)?(.+?)(?:[，,。；;]|适合|用来|拿来|作为|背景|旁白|播客|$)/);
  if (listenMatch?.[1]) keywords.push(listenMatch[1].trim());

  const possessiveMatch = normalized.match(/([\u4e00-\u9fa5A-Za-z0-9·\s]{1,16})的([\u4e00-\u9fa5A-Za-z0-9·\s]{1,24})/);
  if (possessiveMatch) {
    const artist = possessiveMatch[1].replace(/^(我想听|想听|听|播放|放)/, "").trim();
    const song = possessiveMatch[2].split(/[，,。；;]|适合|用来|拿来|作为|背景|旁白|播客/)[0]?.trim();
    if (song) keywords.push(song);
    if (artist && song) keywords.push(`${artist} ${song}`);
  }

  keywords.push(normalized);

  return [...new Set(keywords.map((item) => item.replace(/^(我想听|想听|听|播放|放)\s*/, "").trim()).filter(Boolean))];
}

function splitPlaylistTracks(tracks, batchSize = 24) {
  const batches = [];
  for (let index = 0; index < tracks.length; index += batchSize) {
    batches.push(tracks.slice(index, index + batchSize));
  }
  return batches;
}

function buildPlaylistPrompt({ prompt, playlist, tracks }) {
  const trackLines = tracks.map((track, index) => `${index + 1}. ${track.title} - ${track.artist}`).join("\n");
  return [
    prompt ? `用户要求：${prompt}` : "",
    `歌单名称：${playlist.name}`,
    playlist.description ? `歌单描述：${playlist.description}` : "",
    `歌单歌曲：\n${trackLines}`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMultiPlaylistPrompt({ prompt, playlists, tracks }) {
  const trackLines = tracks.slice(0, 100).map((track, index) => `${index + 1}. ${track.title} - ${track.artist} [${track.playlistName || "未知歌单"}]`).join("\n");
  const playlistLines = playlists.map((playlist, index) => `${index + 1}. ${playlist.name}${playlist.description ? ` - ${playlist.description}` : ""}`);
  return [
    prompt ? `用户要求：${prompt}` : "",
    `候选歌单：\n${playlistLines.join("\n")}`,
    `混合曲库：\n${trackLines}`
  ]
    .filter(Boolean)
    .join("\n");
}

async function chooseMultiPlaylistQueue({ playlists, prompt, minimum = 11 }) {
  const allTracks = [];
  for (const playlist of playlists || []) {
    const tracks = await fetchNeteasePlaylistTracks(playlist.id).catch(() => []);
    for (const track of tracks) {
      allTracks.push({
        ...track,
        playlistId: playlist.id,
        playlistName: playlist.name,
        playlistDescription: playlist.description || ""
      });
    }
  }

  if (!allTracks.length) return { tracks: [], playlists: [] };

  const maxCount = Math.min(Math.max(minimum, Math.ceil(allTracks.length * 0.35)), 18, allTracks.length);
  const trackLines = allTracks.slice(0, 160).map((track, index) => `${index + 1}. ${track.title} - ${track.artist} [${track.playlistName}]`).join("\n");

  if (!process.env.OPENAI_API_KEY) {
    return {
      tracks: allTracks.slice(0, maxCount),
      playlists
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个跨歌单音乐队列策划助手。请只从输入的混合网易云歌单曲库中选择 11 到 18 首歌曲，组成一条连贯的队列。优先保证场景贴合，其次再考虑节奏推进、动静交替、能量曲线和歌单之间的过渡感。可以跨多个歌单，但不得编造新的歌曲。输出小写 json 对象。"
        },
        {
          role: "user",
          content: JSON.stringify({
            userRequest: prompt,
            playlists: playlists.map((playlist, index) => `${index + 1}. ${playlist.name}${playlist.description ? ` - ${playlist.description}` : ""}`),
            tracks: trackLines,
            schema: {
              selectedIndices: "从 1 开始的歌曲索引数组，长度 11 到 18"
            }
          })
        }
      ]
    });
    const content = response.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonFromModel(content);
    const indices = Array.isArray(parsed.selectedIndices)
      ? parsed.selectedIndices.map((value) => Number(value)).filter((index) => Number.isFinite(index) && index >= 1 && index <= allTracks.length)
      : [];
    const uniqueIndices = [...new Set(indices)].slice(0, maxCount);
    if (uniqueIndices.length >= Math.min(minimum, allTracks.length)) {
      return {
        tracks: uniqueIndices.map((index) => allTracks[index - 1]).filter(Boolean),
        playlists
      };
    }
  } catch (err) {
    console.warn("chooseMultiPlaylistQueue failed", err?.message || err);
  }

  return {
    tracks: allTracks.slice(0, maxCount),
    playlists
  };
}

async function findMusicCandidates({ keyword, limit = 6 }) {
  const candidates = [];
  const fallbackCandidates = [];
  const seen = new Set();
  for (const currentKeyword of buildMusicSearchKeywords(keyword)) {
    for (const currentPlatform of musicPlatforms) {
      const items = await searchMusic({ keyword: currentKeyword, platform: currentPlatform, count: 8, page: 1 }).catch(() => []);
      for (const item of items.filter((entry) => entry.id || entry.url)) {
        const key = `${item.platform}:${item.id || item.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const indexed = await resolveMusicFromSearchIndex({
          keyword: currentKeyword,
          sourceIndex: item.sourceIndex,
          platform: item.platform || currentPlatform
        });
        const musicUrl =
          indexed?.musicUrl ||
          (await resolveMusicUrl({
            id: item.id,
            url: item.url,
            platform: item.platform || currentPlatform,
            keyword: item.qqSearchKey || currentKeyword
          }).catch(() => ""));
        const candidate = {
          id: item.id,
          title: indexed?.trackTitle || item.title,
          artist: indexed?.artist || item.artist,
          platform: item.platform || currentPlatform,
          sourceIndex: item.sourceIndex,
          keyword: currentKeyword,
          musicUrl,
          playable: Boolean(musicUrl)
        };
        if (candidate.playable) {
          candidates.push(candidate);
          if (candidates.length >= limit) return candidates;
        } else {
          fallbackCandidates.push(candidate);
        }
      }
    }
  }
  return candidates.length ? candidates : fallbackCandidates.slice(0, limit);
}

async function choosePlaylistQueue({ playlist, tracks, prompt, minimum = 11 }) {
  if (!tracks?.length) return [];
  const availableCount = tracks.length;
  const targetCount = Math.min(Math.max(minimum, Math.ceil(availableCount * 0.4)), 18, availableCount);
  const trackLines = tracks.slice(0, 120).map((track, index) => `${index + 1}. ${track.title} - ${track.artist}`).join("\n");

  if (!process.env.OPENAI_API_KEY) {
    return tracks.slice(0, Math.min(targetCount, tracks.length));
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一个音乐队列策划助手。请只从以下网易云歌单曲目中选择 11 到 18 首歌曲，组成一条连贯的播放队列。优先贴合用户场景，再考虑节奏、情绪、动静比例和能量曲线。严禁选择歌单之外的歌曲，严禁使用精确搜索关键词。必须输出小写 json 对象。"
        },
        {
          role: "user",
          content: JSON.stringify({
            request: prompt ? `用户额外要求：${prompt}` : "",
            playlistName: playlist.name,
            playlistDescription: playlist.description,
            totalTracks: tracks.length,
            tracks: trackLines,
            schema: {
              selectedIndices: "从 1 开始的数组，表示选中的歌单条目索引，长度 11 到 18。"
            }
          })
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    let parsed = { selectedIndices: [] };
    try {
      parsed = parseJsonFromModel(content);
    } catch (error) {
      console.warn("choosePlaylistQueue parse failed", error.message, content);
    }
    const indices = Array.isArray(parsed.selectedIndices)
      ? parsed.selectedIndices.map((value) => Number(value)).filter((index) => Number.isFinite(index) && index >= 1 && index <= availableCount)
      : [];

    const uniqueIndices = [...new Set(indices)].slice(0, targetCount);
    const required = Math.min(minimum, availableCount);
    if (uniqueIndices.length < required) {
      const indexSet = new Set(uniqueIndices);
      for (let index = 1; index <= availableCount && indexSet.size < targetCount; index += 1) {
        indexSet.add(index);
      }
      return [...indexSet].slice(0, targetCount).map((index) => tracks[index - 1]).filter(Boolean);
    }

    return uniqueIndices.map((index) => tracks[index - 1]).filter(Boolean);
  } catch (err) {
    console.warn("choosePlaylistQueue: OpenAI failed, falling back", err?.message || err);
    return tracks.slice(0, targetCount);
  }
}

async function createSpeech(script, voice) {
  const outputPath = path.join(generatedDir, `voice-${nanoid(8)}.mp3`);
  const spedPath = path.join(generatedDir, `voice-fast-${nanoid(8)}.mp3`);
  const requestedVoice = voice || process.env.OPENAI_TTS_VOICE || "alloy";
  const narrationTempo = Math.min(2, Math.max(0.5, Number(process.env.OPENAI_TTS_ATEMPO || 1.18) || 1.18));
  const spokenScript = String(script || "")
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(Marin|小岚|主持人[AB]?|主播[AB]?|嘉宾|A|B|甲|乙)\s*[：:]\s*/i, "").trim())
    .filter(Boolean)
    .join("\n");

  async function createSilentFallback() {
    await execFileAsync(ffmpegBin, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=520:duration=6",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:duration=6:amplitude=0.01",
      "-filter_complex",
      "[0:a]volume=0.25[a0];[1:a]volume=0.03[a1];[a0][a1]amix=inputs=2:duration=shortest",
      outputPath
    ]);
    return outputPath;
  }

  if (!process.env.OPENAI_TTS_API_KEY && !process.env.OPENAI_API_KEY) return createSilentFallback();

  const ttsPayload = {
    model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    voice: requestedVoice,
    input: spokenScript,
    response_format: process.env.OPENAI_TTS_RESPONSE_FORMAT || "mp3"
  };
  const ttsInstructions = "像真人电台主持人一样自然朗读：声音轻、靠近麦克风、有呼吸感，节奏从容。";

  try {
    if (process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_TTS_PATH) {
      const baseUrl = (process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
      const ttsPath = process.env.OPENAI_TTS_PATH || "/audio/speech";
      const response = await fetch(`${baseUrl}${ttsPath.startsWith("/") ? ttsPath : `/${ttsPath}`}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...ttsPayload,
          instructions: ttsInstructions
        })
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`TTS HTTP ${response.status}: ${errorText.slice(0, 240)}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(outputPath, buffer);
      await execFileAsync(ffmpegBin, ["-y", "-i", outputPath, "-filter:a", `atempo=${narrationTempo}`, spedPath]);
      return spedPath;
    }

    const speech = await ttsOpenai.audio.speech.create({
      ...ttsPayload,
      instructions: ttsInstructions
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    await writeFile(outputPath, buffer);
    await execFileAsync(ffmpegBin, ["-y", "-i", outputPath, "-filter:a", `atempo=${narrationTempo}`, spedPath]);
    return spedPath;
  } catch (error) {
    if (requestedVoice !== "alloy") {
      console.warn(`TTS failed for voice "${requestedVoice}", retrying with alloy:`, error.message);
      try {
        const baseUrl = (process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
        const ttsPath = process.env.OPENAI_TTS_PATH || "/audio/speech";
        const response = await fetch(`${baseUrl}${ttsPath.startsWith("/") ? ttsPath : `/${ttsPath}`}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...ttsPayload,
            voice: "alloy",
            instructions: ttsInstructions
          })
        });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          await writeFile(outputPath, buffer);
          await execFileAsync(ffmpegBin, ["-y", "-i", outputPath, "-filter:a", `atempo=${narrationTempo}`, spedPath]);
          return spedPath;
        }
        console.warn("TTS alloy retry failed:", response.status, (await response.text().catch(() => "")).slice(0, 160));
      } catch (retryError) {
        console.warn("TTS alloy retry failed:", retryError.message);
      }
    }
    console.warn("TTS failed, using local fallback:", error.message);
    const fallback = await createSilentFallback();
    await execFileAsync(ffmpegBin, ["-y", "-i", fallback, "-filter:a", `atempo=${narrationTempo}`, spedPath]).catch(() => {});
    return spedPath;
  }
}

async function measureAudioMeanVolume(filePath) {
  try {
    const { stderr } = await execFileAsync(
      ffmpegBin,
      ["-hide_banner", "-nostats", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"],
      { timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    const match = String(stderr || "").match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    const meanDb = match ? Number.parseFloat(match[1]) : Number.NEGATIVE_INFINITY;
    return Number.isFinite(meanDb) ? meanDb : Number.NEGATIVE_INFINITY;
  } catch (error) {
    console.warn("measureAudioMeanVolume failed:", error.message);
    return Number.NEGATIVE_INFINITY;
  }
}

async function ensureAudibleAudio(filePath, label = "audio") {
  const meanDb = await measureAudioMeanVolume(filePath);
  if (meanDb > -48) return { filePath, meanDb, audible: true };
  console.warn(`${label} is too quiet (${meanDb} dB), creating audible fallback`);
  return { filePath: await createFallbackMusic(), meanDb, audible: false };
}

async function createFallbackMusic() {
  const outputPath = path.join(generatedDir, `ambient-${nanoid(8)}.mp3`);
  await execFileAsync(ffmpegBin, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=146.83:duration=75",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=pink:duration=75:amplitude=0.08",
    "-filter_complex",
    "[0:a]volume=0.2[a0];[1:a]volume=0.08[a1];[a0][a1]amix=inputs=2:duration=longest,alimiter=limit=0.85",
    outputPath
  ]);
  return outputPath;
}

function musicDownloadHeaders(url) {
  const headers = {
    Accept: "audio/*,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0"
  };
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch (_error) {
      return "";
    }
  })();
  if (/qqmusic\.qq\.com|music\.tc\.qq\.com|gtimg\.cn/i.test(hostname)) {
    headers.Referer = "https://y.qq.com/";
    headers.Origin = "https://y.qq.com";
  }
  return headers;
}

async function prepareMusicInput(musicUrl) {
  if (!musicUrl) return "";
  const outputPath = path.join(generatedDir, `source-${nanoid(8)}.mp3`);
  const response = await fetch(musicUrl, {
    headers: musicDownloadHeaders(musicUrl)
  });
  if (!response.ok) throw new Error(`Music download failed: ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 32_000) throw new Error(`Music download too small: ${buffer.length} bytes`);
  if (/text\/html|application\/json|text\/plain/i.test(contentType) && !looksLikeAudioBuffer(buffer)) {
    throw new Error(`Music download returned ${contentType}: ${summarizeNonAudioPayload(buffer)}`);
  }
  if (!looksLikeAudioBuffer(buffer)) {
    throw new Error(summarizeNonAudioPayload(buffer));
  }
  await writeFile(outputPath, buffer);
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type:format=duration",
    "-of",
    "json",
    outputPath
  ]);
  const info = JSON.parse(stdout || "{}");
  const hasAudio = Array.isArray(info.streams) && info.streams.some((stream) => stream.codec_type === "audio");
  const duration = Number.parseFloat(info.format?.duration || "0");
  if (!hasAudio || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Music download is not a valid audio stream");
  }
  return outputPath;
}

async function mixPodcast({ musicPath, voicePath }) {
  const outputName = `podcast-${nanoid(10)}.mp3`;
  const outputPath = path.join(generatedDir, outputName);
  const musicCheck = await ensureAudibleAudio(musicPath, "music input");
  const voiceCheck = await ensureAudibleAudio(voicePath, "voice input");
  await execFileAsync(ffmpegBin, [
    "-y",
    "-i",
    musicCheck.filePath,
    "-i",
    voiceCheck.filePath,
    "-filter_complex",
    "[0:a]volume=0.58,afade=t=in:ss=0:d=0.6[music];[1:a]adelay=280|280,volume=5.2[narration];[music][narration]amix=inputs=2:duration=first:dropout_transition=0.1,alimiter=limit=0.94",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath
  ]);
  const outputCheck = await ensureAudibleAudio(outputPath, "podcast output");
  if (outputCheck.filePath !== outputPath) {
    await execFileAsync(ffmpegBin, ["-y", "-i", outputCheck.filePath, "-c:a", "libmp3lame", "-q:a", "2", outputPath]);
  }
  return {
    outputPath,
    outputName,
    audioDiagnostics: {
      musicMeanDb: musicCheck.meanDb,
      voiceMeanDb: voiceCheck.meanDb,
      outputMeanDb: outputCheck.meanDb,
      usedFallback: !musicCheck.audible || !voiceCheck.audible || !outputCheck.audible
    }
  };
}

async function publishGeneratedFile(filePath, fileName) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const buffer = await readFile(filePath);
    const pathname = `agentio/${fileName}`;
    try {
      const blob = await put(pathname, buffer, {
        access: "private",
        contentType: "audio/mpeg",
        addRandomSuffix: true
      });
      return `/media/blob/${encodeURIComponent(blob.pathname || pathname)}`;
    } catch (error) {
      if (isBlobStoreSuspendedError(error)) {
        console.warn("Vercel Blob suspended, using local generated file URL:", error?.message || error);
        return `/media/${fileName}`;
      }
      if (!/private access|public access|configured with/i.test(error?.message || "")) throw error;
      const blob = await put(pathname, buffer, {
        access: "public",
        contentType: "audio/mpeg",
        addRandomSuffix: true
      });
      return blob.url;
    }
  }
  return `/media/${fileName}`;
}

function mergeUnique(a = [], b = []) {
  return [...new Set([...a, ...b].filter(Boolean))].slice(-12);
}

async function updateMemory({ prompt, brief, outputUrl }) {
  const memory = await readMemory();
  const patch = brief.memoryPatch || {};
  memory.profile.favoriteScenes = mergeUnique(memory.profile.favoriteScenes, patch.favoriteScenes);
  memory.profile.musicTaste = mergeUnique(memory.profile.musicTaste, patch.musicTaste);
  memory.profile.narrationStyle = patch.narrationStyle || memory.profile.narrationStyle;
  memory.sessions.unshift({
    id: nanoid(10),
    createdAt: new Date().toISOString(),
    prompt,
    scene: brief.scene,
    title: brief.title,
    episodeTitle: brief.episodeTitle,
    script: brief.script,
    outputUrl
  });
  memory.sessions = memory.sessions.slice(0, 30);
  await saveMemory(memory);
  return memory;
}

app.get("/api/config", (_req, res) => {
  res.json({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    voice: process.env.OPENAI_TTS_VOICE || "alloy",
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasTTSKey: Boolean(process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY),
    hasRealtimeKey: Boolean(realtimeApiKey),
    realtimeModel,
    realtimeBaseUrl,
    realtimeDirectSdp,
    realtimeRoute: "/api/realtime/podcast-text",
    realtimeWebSocketUrls: buildRealtimeWebSocketUrls(realtimeBaseUrl, realtimeModel),
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
    ttsBaseUrl: process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || "",
    homepodShortcutConfigured: Boolean(process.env.HOMEPOD_SHORTCUT_NAME),
    musicApiConfigured: Boolean(wpMusicApiBaseUrl || musicApiBaseUrl || existsSync(localMusicApiDir)),
    qqMusicApi1Configured: Boolean(qqMusicApi1BaseUrl),
    wpMusicApiConfigured: Boolean(wpMusicApiBaseUrl),
    localMusicApiConfigured: Boolean(existsSync(localMusicApiDir)),
    musicPlatform: defaultMusicPlatform,
    blobPersistenceConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    blobPersistenceAvailable: shouldUsePersistentBlob(),
    blobPersistenceDisabledReason
  });
});

app.get("/api/memory", async (_req, res, next) => {
  try {
    res.json(await readMemory());
  } catch (error) {
    next(error);
  }
});

app.get("/api/invites", async (_req, res, next) => {
  try {
    res.json({ codes: await listUnusedInviteCodes() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/invites", async (req, res, next) => {
  try {
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
    await saveInviteCodes(codes);
    res.json({ codes: await listUnusedInviteCodes() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/invites/consume", async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!code) {
      res.status(400).json({ error: "缺少邀请码" });
      return;
    }
    const { data, user } = await getUserByToken(req);
    const result = await consumeInviteCode(code, {
      deviceId: req.body?.deviceId,
      purpose: "beta",
      userId: user?.id || ""
    });
    if (!result.ok) {
      res.status(404).json({ error: "邀请码不存在或已使用" });
      return;
    }
    const deviceId = cleanText(req.body?.deviceId, 120);
    if (user) {
      user.betaAccess = true;
      user.betaInviteCode = code;
      user.betaDeviceIds = Array.isArray(user.betaDeviceIds) ? user.betaDeviceIds : [];
      if (deviceId && !user.betaDeviceIds.includes(deviceId)) user.betaDeviceIds.push(deviceId);
      await saveUsers(data);
    }
    res.json({ ok: true, user: user ? publicUser(user) : null });
  } catch (error) {
    next(error);
  }
});

app.get("/api/invites/activation", async (req, res, next) => {
  try {
    const deviceId = String(req.query?.deviceId || "").trim();
    const activation = await readInviteActivationByDevice(deviceId);
    const { user } = await getUserByToken(req).catch(() => ({ user: null }));
    const accountMatch = user && (user.betaAccess || (Array.isArray(user.betaDeviceIds) && deviceId && user.betaDeviceIds.includes(deviceId)));
    res.json({ activation, accountMatch: Boolean(accountMatch) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/register", async (req, res, next) => {
  try {
    const username = cleanText(req.body?.username, 64).toLowerCase();
    const password = String(req.body?.password || "");
    if (!/^[a-z0-9_@.-]{3,64}$/i.test(username)) {
      res.status(400).json({ error: "用户名至少 3 位，只能包含字母、数字、下划线、点、横线或邮箱符号" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "密码至少 6 位" });
      return;
    }
    const data = await readUsers();
    if (accountPersistenceUnavailable()) {
      res.status(503).json({ error: accountPersistenceUnavailableMessage() });
      return;
    }
    if (data.users.some((user) => user.username === username)) {
      res.status(409).json({ error: "该云韶账号已存在" });
      return;
    }
    const passwordRecord = hashPassword(password);
    const user = {
      id: nanoid(12),
      username,
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      createdAt: new Date().toISOString(),
      betaAccess: false,
      activatedBy: "",
      bindings: {},
      savedTracks: [],
      history: [],
      syncedTracks: [],
      lastSyncedAt: ""
    };
    const token = authToken();
    data.users.push(user);
    data.sessions[token] = user.id;
    await saveUsers(data);
    res.json({ token, user: publicUser(user), savedTracks: [], history: [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/login", async (req, res, next) => {
  try {
    const username = cleanText(req.body?.username, 64).toLowerCase();
    const password = String(req.body?.password || "");
    const data = await readUsers();
    if (accountPersistenceUnavailable()) {
      res.status(503).json({ error: accountPersistenceUnavailableMessage() });
      return;
    }
    const user = data.users.find((item) => item.username === username);
    if (!user || !verifyPassword(password, user)) {
      res.status(401).json({ error: "账号或密码不正确" });
      return;
    }
    const token = authToken();
    data.sessions[token] = user.id;
    await saveUsers(data);
    res.json({ token, user: publicUser(user), savedTracks: user.savedTracks || [], history: user.history || [], syncedTracks: user.syncedTracks || [] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/me", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "未登录云韶账号" });
      return;
    }
    res.json({ user: publicUser(user), savedTracks: user.savedTracks || [], history: user.history || [], syncedTracks: user.syncedTracks || [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/create", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const rooms = await readRooms();
    const existing = rooms.rooms.find((room) => room.ownerId === user.id || room.mateId === user.id) || null;
    if (existing) {
      res.json({ room: publicRoom(existing, user.id), joined: true });
      return;
    }
    const room = {
      id: nanoid(10),
      name: cleanText(req.body?.name, 48) || `${user.username} 的一起听`,
      ownerId: user.id,
      mateId: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      tracks: [],
      nowPlaying: null,
      playbackVersion: 0
    };
    rooms.rooms.push(room);
    await saveRooms(rooms);
    res.json({ room: publicRoom(room, user.id), joined: false });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/join", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const roomId = String(req.body?.roomId || "").trim();
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.id === roomId) || null;
    if (!room) {
      res.status(404).json({ error: "房间不存在" });
      return;
    }
    if (room.ownerId !== user.id && room.mateId && room.mateId !== user.id) {
      res.status(409).json({ error: "房间已满" });
      return;
    }
    room.mateId = room.ownerId === user.id ? room.mateId : user.id;
    if (!room.ownerId) room.ownerId = user.id;
    room.updatedAt = new Date().toISOString();
    rooms.rooms = rooms.rooms.map((item) => item.id === room.id ? room : item);
    await saveRooms(rooms);
    res.json({ room: publicRoom(room, user.id), joined: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/together", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id) || null;
    if (!room) {
      res.json({ room: null, messages: [], tracks: [] });
      return;
    }
    const trackIds = Array.isArray(room.trackIds) ? room.trackIds : [];
    res.json({ room: publicRoom(room, user.id), messages: room.messages || [], trackIds, nowPlaying: room.nowPlaying || null, playbackVersion: room.playbackVersion || 0 });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/message", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const content = cleanText(req.body?.content, 500);
    if (!content) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id) || null;
    if (!room) {
      res.status(404).json({ error: "请先创建或加入一起听房间" });
      return;
    }
    room.messages = [...(room.messages || []), compactRoomMessage({
      id: nanoid(10),
      roomId: room.id,
      userId: user.id,
      username: user.username,
      content,
      createdAt: new Date().toISOString()
    })].slice(-200);
    room.updatedAt = new Date().toISOString();
    room.lastMessageAt = room.updatedAt;
    rooms.rooms = rooms.rooms.map((item) => item.id === room.id ? room : item);
    await saveRooms(rooms);
    res.json({ messages: room.messages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/track", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const track = req.body?.track || {};
    const trackId = trackKeyForServer(track);
    if (!trackId) {
      res.status(400).json({ error: "歌曲信息不完整" });
      return;
    }
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id) || null;
    if (!room) {
      res.status(404).json({ error: "请先创建或加入一起听房间" });
      return;
    }
    room.trackIds = Array.from(new Set([...(room.trackIds || []), trackId])).slice(0, 1000);
    room.tracks = mergeTogetherPlaybackTracks(room.tracks || [], [track]).slice(-80);
    room.nowPlaying = {
      track,
      trackId,
      userId: user.id,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentTime: 0,
      playing: true
    };
    room.playbackVersion = Number(room.playbackVersion || 0) + 1;
    room.updatedAt = new Date().toISOString();
    room.lastTrackAt = room.updatedAt;
    rooms.rooms = rooms.rooms.map((item) => item.id === room.id ? room : item);
    await saveRooms(rooms);
    res.json({ room: publicRoom(room, user.id), tracks: room.tracks || [], nowPlaying: room.nowPlaying, playbackVersion: room.playbackVersion });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/playback", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id) || null;
    if (!room) {
      res.status(404).json({ error: "请先创建或加入一起听房间" });
      return;
    }
    const nowPlaying = room.nowPlaying || {};
    if (!nowPlaying.track) {
      res.status(400).json({ error: "房间还没有正在播放的歌曲" });
      return;
    }
    const currentTime = Math.max(0, Number(req.body?.currentTime || 0));
    const playing = Boolean(req.body?.playing);
    room.nowPlaying = {
      ...nowPlaying,
      userId: user.id,
      currentTime,
      playing,
      updatedAt: new Date().toISOString()
    };
    room.playbackVersion = Number(room.playbackVersion || 0) + 1;
    room.updatedAt = room.nowPlaying.updatedAt;
    rooms.rooms = rooms.rooms.map((item) => item.id === room.id ? room : item);
    await saveRooms(rooms);
    res.json({ room: publicRoom(room, user.id), nowPlaying: room.nowPlaying, playbackVersion: room.playbackVersion });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/together/leave", async (req, res, next) => {
  try {
    const { user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const rooms = await readRooms();
    const room = rooms.rooms.find((item) => item.ownerId === user.id || item.mateId === user.id) || null;
    if (!room) {
      res.json({ room: null, messages: [], tracks: [] });
      return;
    }
    if (room.ownerId === user.id) {
      rooms.rooms = rooms.rooms.filter((item) => item.id !== room.id);
      await saveRooms(rooms);
      res.json({ room: null, dissolved: true });
      return;
    }
    if (room.mateId === user.id) room.mateId = "";
    room.updatedAt = new Date().toISOString();
    rooms.rooms = rooms.rooms.map((item) => item.id === room.id ? room : item);
    await saveRooms(rooms);
    res.json({ room: null, left: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/logout", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const data = await readUsers();
    if (token) delete data.sessions[token];
    await saveUsers(data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/bind-current", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const netease = await readNeteaseState(req).catch(() => null);
    const qq = await readQQMusicState(req).catch(() => null);
    user.bindings = {
      ...user.bindings,
      netease: netease?.loggedIn ? serializeNeteaseState(netease) : user.bindings?.netease || null,
      qq: qq?.loggedIn ? serializeQQMusicState(qq) : user.bindings?.qq || null
    };
    await saveUsers(data);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/sync-library", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const providedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (providedItems.length) {
      user.syncedTracks = providedItems.map(compactLibraryTrack).slice(0, 2000);
    } else {
      const [netease, qq] = await Promise.all([
        fetchNeteaseLibraryTracks(req).catch(() => []),
        fetchQQMusicLibraryTracks(req).catch(() => [])
      ]);
      user.syncedTracks = [...netease, ...qq].map(compactLibraryTrack).slice(0, 2000);
    }
    user.lastSyncedAt = new Date().toISOString();
    await saveUsers(data);
    res.json({ user: publicUser(user), items: user.syncedTracks });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/history", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const track = compactHistoryTrack(req.body?.track || {});
    user.history = [track, ...(user.history || []).filter((item) => item.key !== track.key)].slice(0, 500);
    await saveUsers(data);
    res.json({ history: user.history });
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/saved", async (req, res, next) => {
  try {
    const { data, user } = await getUserByToken(req);
    if (!user) {
      res.status(401).json({ error: "请先登录云韶账号" });
      return;
    }
    const savedTracks = Array.isArray(req.body?.savedTracks) ? req.body.savedTracks : [];
    user.savedTracks = savedTracks.slice(0, 500).map((track) => ({ ...compactHistoryTrack(track), savedAt: track.savedAt || new Date().toISOString() }));
    await saveUsers(data);
    res.json({ savedTracks: user.savedTracks });
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/state", async (req, res, next) => {
  try {
    const state = await refreshNeteaseProfile(req).catch(() => readNeteaseState(req));
    res.json(serializeNeteaseState(await state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/start", async (_req, res, next) => {
  try {
    const state = await startNeteaseLogin();
    clearBrowserNeteaseCookie(res);
    res.json(serializeNeteaseState(state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/check", async (req, res, next) => {
  try {
    const result = await checkNeteaseLogin(req.body?.key || req.query?.key);
    if (result.cookies?.length) setBrowserNeteaseCookie(res, result.cookies);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/captcha", async (req, res, next) => {
  try {
    const result = await sendNeteaseCaptcha(String(req.body?.phone || "").trim(), String(req.body?.countrycode || "86").trim());
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/verify", async (req, res, next) => {
  try {
    const result = await verifyNeteaseCaptcha(
      String(req.body?.phone || "").trim(),
      String(req.body?.captcha || "").trim(),
      String(req.body?.countrycode || "86").trim()
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/phone", async (req, res, next) => {
  try {
    const result = await loginNeteaseWithPhone({
      phone: String(req.body?.phone || "").trim(),
      captcha: String(req.body?.captcha || "").trim(),
      countrycode: String(req.body?.countrycode || "86").trim()
    });
    if (result.cookies?.length) setBrowserNeteaseCookie(res, result.cookies);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/account", async (req, res, next) => {
  try {
    const state = await refreshNeteaseProfile(req).catch(() => readNeteaseState(req));
    res.json(serializeNeteaseState(await state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/logout", async (_req, res, next) => {
  try {
    const nextState = { cookies: [], uid: "", profile: null, qrKey: "", qrImg: "", loggedIn: false };
    await saveNeteaseState(nextState);
    clearBrowserNeteaseCookie(res);
    res.json(serializeNeteaseState(nextState));
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/playlists", async (req, res, next) => {
  try {
    const items = await fetchNeteasePlaylists(req);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/playlist/:id/tracks", async (req, res, next) => {
  try {
    const items = await fetchNeteasePlaylistTracks(req.params.id, req);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/library/tracks", async (req, res, next) => {
  try {
    const playlists = await fetchNeteasePlaylists(req);
    const activePlaylists = playlists.slice(0, maxLibraryPlaylists);
    const groups = await mapWithConcurrency(
      activePlaylists,
      libraryPlaylistConcurrency,
      async (playlist) => {
        const tracks = await fetchNeteasePlaylistTracks(playlist.id, req).catch(() => []);
        return tracks.slice(0, maxLibraryTracksPerPlaylist).map((track, index) => ({
          ...track,
          cover: track.cover || playlist.cover || "",
          year: track.year || (track.publishTime ? new Date(Number(track.publishTime)).getFullYear() : ""),
          libraryKey: `${playlist.id}:${track.id || index}:${index}`,
          playlistId: playlist.id,
          playlistName: playlist.name,
          playlistDescription: playlist.description || ""
        }));
      }
    );
    res.json({
      playlists,
      items: groups.flat(),
      limited: playlists.length > activePlaylists.length,
      playlistLimit: maxLibraryPlaylists,
      trackLimit: maxLibraryTracksPerPlaylist
    });
  } catch (error) {
    res.status(200).json({
      playlists: [],
      items: [],
      warning: error.message || "网易云曲库暂时没有载入"
    });
  }
});

app.get("/api/qqmusic/state", async (req, res, next) => {
  try {
    const state = await refreshQQMusicProfile(req).catch(() => readQQMusicState(req));
    res.json(serializeQQMusicState(await state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/qqmusic/login/cookie", async (req, res, next) => {
  try {
    const result = await loginQQMusicWithCookie(String(req.body?.cookie || req.body?.data || "").trim());
    if (result.cookies?.length) setBrowserQQMusicCookie(res, result.cookies);
    res.json(serializeQQMusicState(result));
  } catch (error) {
    next(error);
  }
});

app.post("/api/qqmusic/login/qr/start", async (req, res, next) => {
  try {
    const state = await startQQMusicQrLogin(
      req.body?.configIndex || req.query?.configIndex || 0,
      req.body?.loginType || req.query?.loginType || "qq"
    );
    clearBrowserQQMusicCookie(res);
    res.json(serializeQQMusicState(state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/qqmusic/login/qr/check", async (req, res, next) => {
  try {
    const result = await checkQQMusicQrLogin(String(req.body?.qrSig || req.body?.qrsig || "").trim());
    if (result.cookies?.length) setBrowserQQMusicCookie(res, result.cookies);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/qqmusic/logout", async (_req, res, next) => {
  try {
    const nextState = { cookies: [], uin: "", profile: null, loggedIn: false, updatedAt: new Date().toISOString() };
    await saveQQMusicState(nextState);
    clearBrowserQQMusicCookie(res);
    res.json(serializeQQMusicState(nextState));
  } catch (error) {
    next(error);
  }
});

app.get("/api/qqmusic/playlists", async (req, res, next) => {
  try {
    const items = await fetchQQMusicPlaylists(req);
    res.json({ items });
  } catch (error) {
    res.status(200).json({
      items: [],
      warning: error.message || "QQ 音乐歌单暂时没有载入"
    });
  }
});

app.get("/api/qqmusic/playlist/:id/tracks", async (req, res, next) => {
  try {
    const items = await fetchQQMusicPlaylistTracks(req.params.id, req);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/qqmusic/library/tracks", async (req, res, next) => {
  try {
    const playlists = await fetchQQMusicPlaylists(req);
    const activePlaylists = playlists.slice(0, maxLibraryPlaylists);
    const groups = await mapWithConcurrency(
      activePlaylists,
      libraryPlaylistConcurrency,
      async (playlist) => {
        const tracks = await fetchQQMusicPlaylistTracks(playlist.id, req).catch(() => []);
        return tracks.slice(0, maxLibraryTracksPerPlaylist).map((track, index) => ({
          ...track,
          cover: track.cover || playlist.cover || "",
          libraryKey: `qq:${playlist.id}:${track.id || track.songId || index}:${index}`,
          playlistId: playlist.id,
          playlistName: playlist.name,
          playlistDescription: playlist.description || ""
        }));
      }
    );
    res.json({
      playlists,
      items: groups.flat(),
      limited: playlists.length > activePlaylists.length,
      playlistLimit: maxLibraryPlaylists,
      trackLimit: maxLibraryTracksPerPlaylist
    });
  } catch (error) {
    res.status(200).json({
      playlists: [],
      items: [],
      warning: error.message || "QQ 音乐曲库暂时没有载入"
    });
  }
});

app.post("/api/playlist/queue", async (req, res, next) => {
  try {
    const playlistId = String(req.body.playlistId || "").trim();
    if (!playlistId) {
      res.status(400).json({ error: "缺少歌单 ID" });
      return;
    }
    const playlist = {
      id: playlistId,
      name: String(req.body.playlistName || "网易云歌单"),
      description: String(req.body.playlistDescription || "")
    };
    const tracks = await fetchNeteasePlaylistTracks(playlistId);
    const items = await choosePlaylistQueue({ playlist, tracks, prompt: String(req.body.prompt || ""), minimum: 11 });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/music/search", async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) {
      res.json({ items: [] });
      return;
    }

    const items = await searchMusic({
      keyword,
      platform: String(req.query.platform || defaultMusicPlatform),
      count: Number(req.query.count || 10),
      page: Number(req.query.page || 1)
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/music/search-all", async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) {
      res.json({ items: [] });
      return;
    }
    const count = clampInt(req.query.count, 4, 80, 24);
    const mode = String(req.query.mode || "song").trim().toLowerCase();
    const allowedPlatforms = new Set(["qq", "netease", "kuwo", "kugou"]);
    const platforms = String(req.query.platforms || "qq,netease,kuwo,kugou")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => allowedPlatforms.has(item));
    const groups = await Promise.all(
      platforms.map(async (platform) => {
        const artistMode = mode === "artist" || mode === "singer";
        const thirdPartyItems = artistMode
          ? await searchGlobalArtistSongs({ keyword, platform, count }).catch((error) => {
              console.warn(`artist global search failed on ${platform}:`, error.message);
              return [];
            })
          : await searchMusicsquareThirdParty({ keyword, platform, count }).catch((error) => {
              console.warn(`third-party global search failed on ${platform}:`, error.message);
              return [];
            });
        const items = thirdPartyItems.length
          ? thirdPartyItems
          : await searchMusic({ keyword, platform, count: artistMode ? Math.min(80, count * 3) : count, page: 1 }).catch((error) => {
              console.warn(`global search fallback failed on ${platform}:`, error.message);
              return [];
            });
        return items.map((item) => ({
          ...item,
          globalSearch: true,
          globalArtistName: artistMode ? keyword : "",
          sourcePlatform: platform,
          globalSearchMode: mode,
          globalSearchProvider: thirdPartyItems.length ? "musicsquare-third-party" : "fallback"
        }));
      })
    );
    const seen = new Set();
    const items = groups.flat().filter((item) => {
      const key = `${item.platform || item.sourcePlatform}:${item.id || item.url}:${item.title}:${item.artist}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return item.id || item.url;
    });
    const stats = platforms.map((platform, index) => ({
      platform,
      count: groups[index]?.length || 0,
      provider: groups[index]?.some((item) => item.globalSearchProvider === "musicsquare-third-party") ? "musicsquare-third-party" : "fallback"
    }));
    res.json({ items, stats, mode, keyword, platforms });
  } catch (error) {
    next(error);
  }
});

app.post("/api/music/resolve", async (req, res, next) => {
  try {
    let musicUrl = await resolveMusicUrl({
      id: req.body?.id,
      url: req.body?.url,
      platform: inferMusicPlatform(req.body || {}, req.body?.platform || defaultMusicPlatform),
      mediaId: req.body?.mediaId || req.body?.media_mid || "",
      songType: req.body?.songType || req.body?.song_type || null,
      keyword: req.body?.qqSearchKey || req.body?.musicKeyword || req.body?.keyword || ""
    });
    if (!musicUrl && req.body?.musicKeyword && req.body?.sourceIndex !== undefined) {
      const indexed = await resolveMusicFromSearchIndex({
        keyword: req.body.musicKeyword,
        sourceIndex: Number(req.body.sourceIndex),
        platform: req.body.platform || defaultMusicPlatform
      });
      musicUrl = indexed?.musicUrl || "";
    }
    res.json({ musicUrl });
  } catch (error) {
    next(error);
  }
});

app.post("/api/realtime/session", async (req, res, next) => {
  try {
    if (!realtimeApiKey || realtimeApiKey === "missing-key") {
      res.status(400).json({ error: "缺少 OPENAI_API_KEY 或 OPENAI_REALTIME_API_KEY" });
      return;
    }
    if (realtimeDirectSdp) {
      res.json({
        model: realtimeModel,
        baseUrl: realtimeBaseUrl,
        clientSecret: realtimeApiKey,
        directSdp: true,
        expiresAt: null
      });
      return;
    }
    const voice = sanitizeVoice(req.body?.voice || process.env.OPENAI_REALTIME_VOICE || "alloy");
    const payload = {
      session: {
        type: "realtime",
        model: realtimeModel,
        audio: { output: { voice } },
        instructions:
          "你是云韶的实时音乐播客声音。用户点击歌曲后，音乐会同时播放。你只说一段自然中文播客，不要说主持人名，不要报幕，不要编号，不要等待用户回复。内容要介绍歌曲和适合的情绪场景，控制在 25 到 45 秒。"
      }
    };
    const headers = {
      Authorization: `Bearer ${realtimeApiKey}`,
      "Content-Type": "application/json"
    };
    let response = await fetch(`${realtimeBaseUrl}/realtime/client_secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    let data = await response.json().catch(() => ({}));
    if (!response.ok && (response.status === 404 || response.status === 400)) {
      response = await fetch(`${realtimeBaseUrl}/realtime/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: realtimeModel,
          voice,
          modalities: ["audio", "text"],
          instructions: payload.session.instructions
        })
      });
      data = await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      const upstreamMessage = data.error?.message || data.message || "Realtime 会话创建失败";
      const proxyHint = realtimeBaseUrl.includes("api.openai.com")
        ? ""
        : "当前 OPENAI_REALTIME_BASE_URL/OPENAI_BASE_URL 可能不支持 OpenAI Realtime WebRTC，请改用支持 Realtime 的地址，或设置 OPENAI_REALTIME_BASE_URL=https://api.openai.com/v1。";
      res.status(response.status).json({ error: [upstreamMessage, proxyHint].filter(Boolean).join(" ") });
      return;
    }
    res.json({
      model: realtimeModel,
      baseUrl: realtimeBaseUrl,
      clientSecret: data.value || data.client_secret?.value || data.client_secret || "",
      expiresAt: data.expires_at || data.client_secret?.expires_at || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/realtime/podcast-text", async (req, res, next) => {
  try {
    if (!realtimeApiKey || realtimeApiKey === "missing-key") {
      res.status(400).json({ error: "缺少 OPENAI_API_KEY 或 OPENAI_REALTIME_API_KEY" });
      return;
    }
    const track = normalizeSearchItem(req.body?.track || req.body || {}, req.body?.platform || "netease");
    const title = cleanText(track.title || req.body?.title || "这首歌", 80);
    const artist = cleanText(track.artist || req.body?.artist || "未知艺人", 80);
    const album = cleanText(track.album || req.body?.album || req.body?.playlistName || "", 80);
    const instructions = `音乐已经开始播放。请用中文写一段适合直接朗读的音乐播客，25 到 45 秒，只说一遍，不要报主持人名，不要编号，不要使用 Markdown。歌曲：${title}。艺人：${artist}。${album ? `专辑或歌单：${album}。` : ""}请介绍它适合的情绪、场景和听感。`;
    const wsUrls = buildRealtimeWebSocketUrls(realtimeBaseUrl, realtimeModel);
    let text = "";
    let lastError = null;
    for (const wsUrl of wsUrls) {
      try {
        text = await createRealtimePodcastText({ wsUrl, apiKey: realtimeApiKey, instructions });
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Realtime WebSocket failed for ${wsUrl.replace(/key=[^&]+/g, "key=***")}:`, error.message);
      }
    }
    if (!text && lastError) throw lastError;
    res.json({ text: text || "这首歌已经开始。先把注意力放松下来，让旋律自己把场景打开。" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/music/candidates", async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) {
      res.json({ items: [] });
      return;
    }
    const items = await findMusicCandidates({ keyword, limit: Number(req.query.limit || 6) });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent/create", upload.single("track"), async (req, res, next) => {
  try {
    const prompt = req.body.prompt || "";
    const requestedTrackTitle = req.body.trackTitle || req.file?.originalname?.replace(/\.[^.]+$/, "") || "";
    const voice = req.body.voice || process.env.OPENAI_TTS_VOICE || "alloy";
    let playlistId = req.body.playlistId || "";
    let playlistName = req.body.playlistName || "";
    let playlistDescription = req.body.playlistDescription || "";
    let playlistTracks = [];
    let playlist = null;
    let candidatePlaylists = [];

    if (!playlistId) {
      const allPlaylists = await fetchNeteasePlaylists().catch(() => []);
      candidatePlaylists = await chooseBestPlaylists({ prompt, playlists: allPlaylists, memory: await readMemory(), maxCount: 4 });
      if (candidatePlaylists[0]?.id) {
        playlistId = String(candidatePlaylists[0].id);
        playlistName = candidatePlaylists[0].name || "";
        playlistDescription = candidatePlaylists[0].description || "";
      }
    } else {
      candidatePlaylists = [{ id: playlistId, name: playlistName || "网易云歌单", description: playlistDescription || "" }];
    }

    if (playlistId) {
      playlistTracks = await fetchNeteasePlaylistTracks(playlistId);
      playlist = {
        id: playlistId,
        name: playlistName || "网易云歌单",
        description: playlistDescription || ""
      };
    }

    let musicUrl = "";
    if (!playlistId) {
      musicUrl = await resolveMusicUrl({
        id: req.body.musicId,
        url: req.body.musicUrl,
        platform: inferMusicPlatform({ id: req.body.musicId, platform: req.body.platform }, req.body.platform || defaultMusicPlatform),
        keyword: req.body.qqSearchKey || req.body.musicKeyword || req.body.keyword || ""
      });
    }
    let selectedBackgroundMusic = null;
    if (!musicUrl && req.body.musicKeyword && req.body.sourceIndex !== undefined) {
      const indexed = await resolveMusicFromSearchIndex({
        keyword: req.body.musicKeyword,
        sourceIndex: Number(req.body.sourceIndex),
        platform: req.body.platform || defaultMusicPlatform
      });
      musicUrl = indexed?.musicUrl || "";
      if (indexed) selectedBackgroundMusic = indexed;
    }
    let backgroundMusic = selectedBackgroundMusic || (musicUrl
      ? { musicUrl, trackTitle: requestedTrackTitle, artist: "", platform: req.body.platform || defaultMusicPlatform, id: req.body.musicId }
      : playlistId
        ? { musicUrl: "", trackTitle: playlistName || "网易云歌单", artist: "网易云歌单", platform: "netease", id: "" }
        : await findBackgroundMusic({
            prompt,
            trackTitle: requestedTrackTitle,
            platform: req.body.platform || defaultMusicPlatform
          }));
    musicUrl = backgroundMusic.musicUrl;
    let trackTitle = requestedTrackTitle || backgroundMusic.trackTitle || "";
    let usedFallbackMusic = false;
    let musicPath = req.file?.path || "";
    let selectedTrackList = playlistTracks;
    if (candidatePlaylists.length > 1) {
      const multi = await chooseMultiPlaylistQueue({ playlists: candidatePlaylists, prompt, minimum: 11 });
      selectedTrackList = multi.tracks;
      candidatePlaylists = multi.playlists || candidatePlaylists;
    } else if (playlistTracks.length) {
      selectedTrackList = await choosePlaylistQueue({ playlist, tracks: playlistTracks, prompt, minimum: 11 });
    }

    const memory = await readMemory();
    let brief = candidatePlaylists.length > 1
      ? await buildMultiPlaylistPodcastBrief({
          prompt,
          playlists: candidatePlaylists,
          tracks: selectedTrackList,
          memory
        })
      : playlist
        ? await buildPlaylistPodcastBrief({
            prompt: buildPlaylistPrompt({ prompt, playlist, tracks: playlistTracks }),
            playlist,
            tracks: playlistTracks,
            memory
          })
        : await generatePodcastBrief({ prompt, trackTitle, memory });
    if (!playlistId && !musicUrl && brief.title) {
      backgroundMusic = await findBackgroundMusic({
        prompt: brief.title,
        trackTitle: brief.title,
        platform: req.body.platform || defaultMusicPlatform
      });
      musicUrl = backgroundMusic.musicUrl;
      trackTitle = backgroundMusic.trackTitle || brief.title;
    }
    if (backgroundMusic.artist && (!brief.artist || brief.artist === "云韶")) brief.artist = backgroundMusic.artist;

    const firstTrack = selectedTrackList[0] || playlistTracks[0];
    if (firstTrack) {
      const firstTrackPlatform = inferMusicPlatform(firstTrack, req.body.platform || defaultMusicPlatform);
      backgroundMusic = {
        musicUrl: "",
        trackTitle: firstTrack.title,
        artist: firstTrack.artist,
        platform: firstTrackPlatform,
        id: firstTrack.id,
        mediaId: firstTrack.mediaId || firstTrack.media_mid || firstTrack.raw?.strMediaMid || firstTrack.raw?.media_mid || ""
      };
      musicUrl = await resolveMusicUrl({
        id: firstTrack.id,
        platform: firstTrackPlatform,
        mediaId: backgroundMusic.mediaId,
        keyword: firstTrack.qqSearchKey || firstTrack.raw?.qqSearchKey || `${firstTrack.title || ""} ${firstTrack.artist || ""}`.trim()
      }).catch(() => "");
      backgroundMusic.musicUrl = musicUrl;
      trackTitle = firstTrack.title || brief.title || trackTitle;
    }
    const songCookie = cookieHeaderFromState(await readNeteaseState().catch(() => null));
    const podcastSongs = await Promise.all(
      selectedTrackList.map(async (track) => {
        const songPackage = await buildSongPodcastPackage(track, songCookie);
        const podcastScript = await buildSongPodcastScript({
          prompt,
          track,
          songPackage,
          memory
        });
        return {
          ...track,
          ...songPackage,
          podcastScript
        };
      })
    );
    const podcastEpisodes = await Promise.all(
      selectedTrackList.map(async (track) => {
        try {
          return await createTrackPodcastEpisode({
            track,
            prompt,
            voice,
            memory,
            cookie: songCookie
          });
        } catch (error) {
          console.warn("createTrackPodcastEpisode failed", track?.title, error.message);
          return null;
        }
      })
    );
    const validPodcastEpisodes = podcastEpisodes.filter(Boolean);
    const currentEpisode = validPodcastEpisodes[0] || null;
    const playbackMusicPath = currentEpisode?.podcastAudioUrl ? path.join(generatedDir, path.basename(currentEpisode.podcastAudioUrl)) : musicPath;
    if (!musicPath && musicUrl) {
      musicPath = await prepareMusicInput(musicUrl).catch((error) => {
        console.warn("Music download/validation failed, using fallback music:", error.message);
        usedFallbackMusic = true;
        return "";
      });
    }
    if (!musicPath && req.body.musicId) {
      res.status(409).json({
        error: "这首候选暂时解析不到可播放音乐，请换一首候选。",
        sourceMusic: backgroundMusic
      });
      return;
    }
    if (!musicPath) {
      usedFallbackMusic = true;
      musicPath = await createFallbackMusic();
    }
    let queueIntro = { openingScript: "", trackNotes: [] };
    if (selectedTrackList.length) {
      queueIntro = await buildQueueIntroBrief({
        prompt,
        playlists: candidatePlaylists,
        tracks: selectedTrackList,
        memory
      });
    }
    const trackNotes = queueIntro.trackNotes || [];
    const queueNoteMap = new Map(trackNotes.map((item) => [String(item.trackId || ""), String(item.text || "").trim()]));
    const finalScript = String(queueIntro.openingScript || brief.script || "").trim();
    brief = {
      ...brief,
      script: finalScript || brief.script || "",
      openingScript: finalScript || brief.script || "",
      trackNotes
    };
    const finalEpisode = currentEpisode || {};
    const outputUrl = finalEpisode.podcastAudioUrl || finalEpisode.outputUrl || "";
    const outputName = outputUrl ? path.basename(new URL(outputUrl, "http://agentio.local").pathname) : `podcast-${nanoid(10)}.mp3`;
    const transcriptSegments = finalEpisode.transcriptSegments || buildTranscriptSegments(brief.script, Number(brief.durationSeconds || 30));
    const lyricSegments = await fetchLyrics({ id: backgroundMusic.id, platform: backgroundMusic.platform }).catch(() => []);
    const queueItems = selectedTrackList.map((track) => {
      const songMeta = podcastSongs.find((item) => String(item.id || "") === String(track.id || ""));
      const episode = validPodcastEpisodes.find((item) => String(item.id || "") === String(track.id || ""));
      return {
        ...track,
        platform: inferMusicPlatform(track, backgroundMusic.platform || defaultMusicPlatform),
        narration: queueNoteMap.get(String(track.id || "")) || "",
        podcastScript: episode?.podcastScript || songMeta?.podcastScript || null,
        songDetails: episode?.songDetails || songMeta?.songDetails || null,
        hotComments: episode?.hotComments || songMeta?.hotComments || [],
        wikiSummary: episode?.wikiSummary || songMeta?.wikiSummary || "",
        podcastAudioUrl: episode?.podcastAudioUrl || "",
        outputUrl: episode?.outputUrl || episode?.podcastAudioUrl || "",
        transcriptSegments: episode?.transcriptSegments || [],
        lyricSegments: episode?.lyricSegments || []
      };
    });
    const podcastDialogue = queueItems.map((item) => ({
      trackId: item.id,
      title: item.title,
      artist: item.artist,
      durationSeconds: item.podcastScript?.durationSeconds || 0,
      opening: item.podcastScript?.opening || "",
      closing: item.podcastScript?.closing || "",
      script: item.podcastScript?.script || ""
    }));
    const updatedMemory = await updateMemory({
      prompt,
      brief,
      outputUrl
    });

    res.json({
      ...brief,
      outputUrl,
      podcastAudioUrl: outputUrl,
      episodeScript: finalEpisode.podcastScript?.script || brief.script || "",
      sourceMusic: backgroundMusic,
      usedFallbackMusic,
      playlist: playlist
        ? {
            ...playlist,
            tracks: selectedTrackList
          }
        : null,
      playlists: candidatePlaylists,
      queue: queueItems,
      queueNarrations: trackNotes,
      trackNotes,
      podcastSongs,
      podcastDialogue,
      currentEpisode,
      transcriptSegments,
      lyricSegments,
      memory: updatedMemory.profile,
      config: {
        voice,
        ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/lyrics", async (req, res, next) => {
  try {
    const segments = await fetchLyrics({
      id: req.body?.id,
      platform: req.body?.platform || defaultMusicPlatform,
      mediaId: req.body?.mediaId || req.body?.media_mid || "",
      songId: req.body?.songId || req.body?.songid || "",
      raw: req.body?.raw || null
    });
    res.json({ segments });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent/intent", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim();
    const loggedIn = Boolean(req.body?.loggedIn);
    const fallback = (() => {
      if (/登录|网易云|二维码|扫码|手机|验证码|账号/.test(text)) {
        return {
          intent: "login",
          panel: /手机|验证码/.test(text) ? "phone-login" : "qr-login",
          prompt: text,
          shouldStartQr: /二维码|扫码|登录|网易云/.test(text),
          reason: "用户请求登录相关能力"
        };
      }
      if (/歌单|列表|队列|播放|听|音乐|歌曲|来点|放点/.test(text)) {
        return {
          intent: "music",
          panel: "playlist",
          prompt: text,
          shouldCreatePodcast: loggedIn,
          reason: "用户请求生成音乐播客或歌单"
        };
      }
      if (/歌词|唱到|词/.test(text)) {
        return { intent: "lyrics", panel: "lyrics", prompt: text, reason: "用户请求歌词" };
      }
      return { intent: "chat", panel: "", prompt: text, reason: "普通语音请求" };
    })();

    if (!process.env.OPENAI_API_KEY) {
      res.json(fallback);
      return;
    }

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是 云韶 的语音界面意图分类器。用户必须先说 hey dj，前端会把后面的请求发给你。请只输出小写 json 对象。intent 只能是 login/music/lyrics/queue/logout/chat。panel 只能是 qr-login/phone-login/playlist/lyrics/queue/none。shouldStartQr 和 shouldCreatePodcast 是布尔值。音乐请求要保留 prompt。"
        },
        {
          role: "user",
          content: JSON.stringify({
            text,
            loggedIn,
            schema: {
              intent: "login/music/lyrics/queue/logout/chat",
              panel: "qr-login/phone-login/playlist/lyrics/queue/none",
              prompt: "传给播客和选歌模型的场景描述",
              shouldStartQr: "是否需要自动发起二维码登录",
              shouldCreatePodcast: "是否需要自动生成播客歌单",
              reason: "一句短原因"
            }
          })
        }
      ]
    });
    const parsed = parseJsonFromModel(response.choices?.[0]?.message?.content || "") || fallback;
    res.json({
      ...fallback,
      ...parsed,
      panel: parsed.panel === "none" ? "" : parsed.panel || fallback.panel || ""
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/track/tts-podcast", async (req, res, next) => {
  try {
    const rawTrack = req.body?.track || req.body || {};
    const track = normalizeTrackItem(rawTrack);
    track.platform = inferMusicPlatform(rawTrack, rawTrack.platform || track.platform || defaultMusicPlatform);
    track.musicUrl = rawTrack.musicUrl || rawTrack.url || "";
    track.mediaId = rawTrack.mediaId || rawTrack.media_mid || rawTrack.raw?.strMediaMid || rawTrack.raw?.media_mid || "";
    track.qqSearchKey = rawTrack.qqSearchKey || rawTrack.raw?.qqSearchKey || "";
    track.playlistName = rawTrack.playlistName || "";
    if (!track.id && !track.title) {
      res.status(400).json({ error: "缺少歌曲信息" });
      return;
    }

    const prompt = String(req.body?.prompt || "").trim();
    const voice = String(req.body?.voice || process.env.OPENAI_TTS_VOICE || "alloy").trim();
    const currentTime = Number(req.body?.currentTime || 0) || 0;
    const memory = await readMemory();
    const cookie = cookieHeaderFromState(await readNeteaseState().catch(() => null));
    const songPackage = await buildSongPodcastPackage(track, cookie);
    const lyricSegments = await fetchLyrics({ id: track.id, platform: track.platform }).catch(() => []);
    const currentLyric = lyricAtTime(lyricSegments, currentTime);
    const transitionPrompt = [
      prompt,
      currentLyric?.text
        ? `音乐已经播放到 ${Math.round(currentTime)} 秒，当前歌词是“${currentLyric.text}”。播客第一句要自然接住这句歌词的情绪，不要生硬引用时间。`
        : `音乐已经播放到 ${Math.round(currentTime)} 秒，请用自然电台口吻在音乐中段切入。`
    ].filter(Boolean).join("\n");
    const podcastScript = await buildSongPodcastScript({
      prompt: transitionPrompt,
      track: { ...track, duration: songPackage.duration || track.duration },
      songPackage,
      memory
    });
    const voicePath = await createSpeech(podcastScript.script, voice);
    const fileName = path.basename(voicePath);
    const audioUrl = await publishGeneratedFile(voicePath, fileName);
    res.json({
      ok: true,
      audioUrl,
      script: podcastScript.script,
      podcastScript,
      lyricSegments,
      currentLyric,
      startedAt: currentTime
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/track/podcast", async (req, res, next) => {
  try {
    const track = normalizeTrackItem(req.body?.track || req.body || {});
    if (!track.id && !track.title) {
      res.status(400).json({ error: "缺少歌曲信息" });
      return;
    }
    const prompt = String(req.body?.prompt || "").trim();
    const voice = String(req.body?.voice || process.env.OPENAI_TTS_VOICE || "alloy").trim();
    const memory = await readMemory();
    const cookie = cookieHeaderFromState(await readNeteaseState().catch(() => null));
    const episode = await createTrackPodcastEpisode({
      track,
      prompt,
      voice,
      memory,
      cookie
    });
    res.json({
      ok: true,
      ...episode,
      episodeScript: episode.podcastScript?.script || "",
      currentEpisode: episode
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/homepod/play", async (req, res, next) => {
  try {
    if (!process.env.HOMEPOD_SHORTCUT_NAME) {
      res.status(409).json({
        ok: false,
        message: "还没有配置 HOMEPOD_SHORTCUT_NAME。你可以在 macOS Shortcuts 里创建一个播放到 HomePod 的快捷指令。"
      });
      return;
    }

    const input = req.body?.scene ? `场景：${req.body.scene}` : "云韶 scene";
    await execFileAsync("shortcuts", ["run", process.env.HOMEPOD_SHORTCUT_NAME, "-i", input]);
    res.json({ ok: true, message: "已请求 HomePod 场景播放。" });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, "dist")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(rootDir, "dist", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Unknown server error" });
});

if (!isVercel) {
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => {
    console.log(`云韶 API listening on http://localhost:${port}`);
    console.log("QQ music resolver: musicsquare tang detail only");
  });
}

export default app;
