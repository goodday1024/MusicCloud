import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";
import NeteaseCloudMusicApi from "NeteaseCloudMusicApi";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { put } from "@vercel/blob";

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
const localMusicApiDir = process.env.LOCAL_MUSIC_API_DIR || "/Users/zhangzihang/music-api";
const defaultMusicPlatform = process.env.MUSIC_API_DEFAULT_PLATFORM || "netease";
const musicPlatforms = (process.env.MUSIC_API_PLATFORMS || "kugou,qq,netease,kuwo")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const neteaseApiBaseUrl = process.env.NETEASE_API_BASE_URL?.replace(/\/$/, "") || "";
const neteaseStateFile = path.join(dataDir, "netease.json");
const narrationLeadInSeconds = 0.18;
const requestWindows = new Map();

function clampInt(value, min, max, fallback = min) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function cleanText(value, maxLen = 240) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxLen);
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
      : { origin: false }
  )
);
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(generatedDir));
app.use(express.static(path.join(rootDir, "dist")));

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

async function readNeteaseState() {
  const envCookies = cookieListFromEnv(process.env.NETEASE_COOKIE);
  const envState = {
    cookies: envCookies,
    uid: "",
    profile: null,
    qrKey: "",
    qrImg: "",
    loggedIn: Boolean(envCookies.length)
  };
  if (!existsSync(neteaseStateFile)) {
    return envState;
  }
  const raw = await readFile(neteaseStateFile, "utf8");
  const state = JSON.parse(raw);
  if (!state.cookies?.length && envCookies.length) {
    return { ...state, cookies: envCookies, loggedIn: true };
  }
  return state;
}

async function saveNeteaseState(state) {
  await writeFile(neteaseStateFile, JSON.stringify(state, null, 2), "utf8");
}

function cookieHeaderFromState(state) {
  return (state?.cookies || []).join("; ");
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
  if (Array.isArray(cookie)) return cookie.map((item) => String(item).split(";")[0]?.trim()).filter(Boolean);
  return String(cookie)
    .split(/;|,(?=[^;]+?=)/g)
    .map((item) => item.trim())
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
  return payload;
}

async function refreshNeteaseProfile() {
  const state = await readNeteaseState();
  if (!state.cookies?.length) return null;

  const cookie = cookieHeaderFromState(state);
  const accountResult = await neteaseApi.user_account({ cookie }).catch(() => null);
  const account = accountResult?.body?.data || accountResult?.body || {};
  const uid = account?.id || state.uid || "";
  const detailResult = uid ? await neteaseApi.user_detail({ uid, cookie }).catch(() => null) : null;
  const profile = detailResult?.body?.profile || detailResult?.body?.data || account?.profile || null;
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
    cookies: Array.isArray(cookie) ? cookie : String(cookie).split(";").map((item) => item.trim()).filter(Boolean),
    loggedIn: payload?.code === 200 || response?.status === 200,
    updatedAt: new Date().toISOString()
  };
  await saveNeteaseState(nextState);
  await refreshNeteaseProfile().catch(() => null);
  return { ok: nextState.loggedIn, payload, state: serializeNeteaseState(nextState) };
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
      const cookie = normalizeCookieList(payload?.cookie || payload?.data?.cookie || "");
      const status = {
        ...state,
        qrKey,
        cookies: cookie.length ? cookie : state.cookies || [],
        loggedIn: code === 803 || code === 200,
        qrStatus: payload?.message || payload?.msg || payload?.data?.message || "",
        updatedAt: new Date().toISOString()
      };
      await saveNeteaseState(status);
      if (status.loggedIn) await refreshNeteaseProfile().catch(() => null);
      return { ...status, code, payload };
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
    await refreshNeteaseProfile().catch(() => null);
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

async function fetchNeteasePlaylists() {
  const state = await refreshNeteaseProfile().catch(() => null);
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

async function fetchNeteasePlaylistTracks(playlistId) {
  if (!playlistId) throw new Error("缺少歌单 ID");
  const state = await readNeteaseState();
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
      artist: "Agentio",
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
    platform: track?.platform || "netease",
    musicUrl: track?.musicUrl || track?.url || "",
    playlistName: track?.playlistName || ""
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
    platform: safeTrack.platform || "netease"
  }).catch(() => safeTrack.musicUrl || "");
  const musicPath = existingMusicPath || (musicUrl ? await prepareMusicInput(musicUrl).catch(() => "") : "");
  if (!musicPath) {
    throw new Error(`无法为 ${safeTrack.title} 准备背景音乐`);
  }
  const voicePath = await createSpeech(podcastScript.script, voice);
  const { outputPath, outputName } = await mixPodcast({ musicPath, voicePath });
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
    transcriptSegments,
    lyricSegments
  };
}

function serializeNeteaseState(state) {
  return {
    loggedIn: Boolean(state?.loggedIn),
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

async function fetchLyrics({ id, platform }) {
  if (!id || platform !== "netease") return [];
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
              artist: "艺术家，未知则为 Agentio",
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

async function searchMusic({ keyword, platform, count = 10, page = 1 }) {
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
      artist: "Agentio Demo",
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

async function resolveMusicUrl({ id, url: directUrl, platform }) {
  if (isPlayableMusicUrl(directUrl)) return directUrl;
  if (!id || platform === "demo") return "";

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
        platform: selected.platform || currentPlatform
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
          (await resolveMusicUrl({ id: item.id, url: item.url, platform: item.platform || currentPlatform }).catch(() => ""));
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
    "[0:a]volume=0.05[a0];[1:a]volume=0.035[a1];[a0][a1]amix=inputs=2:duration=longest",
    outputPath
  ]);
  return outputPath;
}

async function prepareMusicInput(musicUrl) {
  if (!musicUrl) return "";
  const outputPath = path.join(generatedDir, `source-${nanoid(8)}.mp3`);
  const response = await fetch(musicUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`Music download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 32_000) throw new Error(`Music download too small: ${buffer.length} bytes`);
  await writeFile(outputPath, buffer);
  await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1", outputPath]);
  return outputPath;
}

async function mixPodcast({ musicPath, voicePath }) {
  const outputName = `podcast-${nanoid(10)}.mp3`;
  const outputPath = path.join(generatedDir, outputName);
  await execFileAsync(ffmpegBin, [
    "-y",
    "-i",
    musicPath,
    "-i",
    voicePath,
    "-filter_complex",
    "[0:a]volume='if(between(t,0,9999),0.28,0.45)':eval=frame,afade=t=in:ss=0:d=0.6[music];[1:a]adelay=280|280,volume=4.4[narration];[music][narration]amix=inputs=2:duration=first:dropout_transition=0.1,alimiter=limit=0.92",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath
  ]);
  return { outputPath, outputName };
}

async function publishGeneratedFile(filePath, fileName) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const buffer = await readFile(filePath);
    const blob = await put(`agentio/${fileName}`, buffer, {
      access: "public",
      contentType: "audio/mpeg",
      addRandomSuffix: true
    });
    return blob.url;
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
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
    ttsBaseUrl: process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || "",
    homepodShortcutConfigured: Boolean(process.env.HOMEPOD_SHORTCUT_NAME),
    musicApiConfigured: Boolean(musicApiBaseUrl || existsSync(localMusicApiDir)),
    localMusicApiConfigured: Boolean(existsSync(localMusicApiDir)),
    musicPlatform: defaultMusicPlatform
  });
});

app.get("/api/memory", async (_req, res, next) => {
  try {
    res.json(await readMemory());
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/state", async (_req, res, next) => {
  try {
    const state = await readNeteaseState();
    res.json(serializeNeteaseState(state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/start", async (_req, res, next) => {
  try {
    const state = await startNeteaseLogin();
    res.json(serializeNeteaseState(state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/login/check", async (req, res, next) => {
  try {
    const result = await checkNeteaseLogin(req.body?.key || req.query?.key);
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
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/account", async (_req, res, next) => {
  try {
    res.json(await refreshNeteaseAccount());
  } catch (error) {
    next(error);
  }
});

app.post("/api/netease/logout", async (_req, res, next) => {
  try {
    const nextState = { cookies: [], uid: "", profile: null, qrKey: "", qrImg: "", loggedIn: false };
    await saveNeteaseState(nextState);
    res.json(serializeNeteaseState(nextState));
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/playlists", async (_req, res, next) => {
  try {
    const items = await fetchNeteasePlaylists();
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/playlist/:id/tracks", async (req, res, next) => {
  try {
    const items = await fetchNeteasePlaylistTracks(req.params.id);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/netease/library/tracks", async (_req, res, next) => {
  try {
    const playlists = await fetchNeteasePlaylists();
    const groups = await Promise.all(
      playlists.map(async (playlist) => {
        const tracks = await fetchNeteasePlaylistTracks(playlist.id).catch(() => []);
        return tracks.map((track, index) => ({
          ...track,
          cover: track.cover || playlist.cover || "",
          year: track.year || (track.publishTime ? new Date(Number(track.publishTime)).getFullYear() : ""),
          libraryKey: `${playlist.id}:${track.id || index}:${index}`,
          playlistId: playlist.id,
          playlistName: playlist.name,
          playlistDescription: playlist.description || ""
        }));
      })
    );
    res.json({
      playlists,
      items: groups.flat()
    });
  } catch (error) {
    next(error);
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

app.post("/api/music/resolve", async (req, res, next) => {
  try {
    let musicUrl = await resolveMusicUrl({
      id: req.body?.id,
      url: req.body?.url,
      platform: req.body?.platform || defaultMusicPlatform
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
        platform: req.body.platform || defaultMusicPlatform
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
    if (backgroundMusic.artist && (!brief.artist || brief.artist === "Agentio")) brief.artist = backgroundMusic.artist;

    const firstTrack = selectedTrackList[0] || playlistTracks[0];
    if (firstTrack) {
      backgroundMusic = {
        musicUrl: "",
        trackTitle: firstTrack.title,
        artist: firstTrack.artist,
        platform: "netease",
        id: firstTrack.id
      };
      musicUrl = await resolveMusicUrl({
        id: firstTrack.id,
        platform: "netease"
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
        platform: "netease",
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
    const segments = await fetchLyrics({ id: req.body?.id, platform: req.body?.platform || defaultMusicPlatform });
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
            "你是 Agentio 的语音界面意图分类器。用户必须先说 hey dj，前端会把后面的请求发给你。请只输出小写 json 对象。intent 只能是 login/music/lyrics/queue/logout/chat。panel 只能是 qr-login/phone-login/playlist/lyrics/queue/none。shouldStartQr 和 shouldCreatePodcast 是布尔值。音乐请求要保留 prompt。"
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

    const input = req.body?.scene ? `场景：${req.body.scene}` : "Agentio scene";
    await execFileAsync("shortcuts", ["run", process.env.HOMEPOD_SHORTCUT_NAME, "-i", input]);
    res.json({ ok: true, message: "已请求 HomePod 场景播放。" });
  } catch (error) {
    next(error);
  }
});

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
    console.log(`Agentio API listening on http://localhost:${port}`);
  });
}

export default app;
