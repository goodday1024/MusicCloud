import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import "./styles.css";

const BRAND_CN = "云韶";
const BRAND_EN = "CaelumShao";
const LIBRARY_CACHE_KEY = "caelumshao.libraryTracks.v1";
const PODCAST_ENABLED_KEY = "caelumshao.podcastEnabled.v1";
const BETA_ENABLED_KEY = "caelumshao.betaEnabled.v1";
const RESOLVED_MUSIC_CACHE_KEY = "caelumshao.resolvedMusicCache.v1";
const LYRICS_CACHE_KEY = "caelumshao.lyricsCache.v1";
const PODCAST_CACHE_KEY = "caelumshao.podcastCache.v1";
const RECENT_TRACKS_KEY = "caelumshao.recentTracks.v1";
const LYRIC_POSITION_KEY = "caelumshao.lyricPosition.v1";
const PODCAST_CACHE_TTL = 24 * 60 * 60 * 1000;
const ADMIN_PASSWORD_KEY = "caelumshao.adminPassword.v1";
const ACCOUNT_TOKEN_KEY = "caelumshao.accountToken.v1";
const DEVICE_ID_KEY = "caelumshao.deviceId.v1";
const APP_VERSION_KEY = "caelumshao.appVersion.v1";
const DEFAULT_ADMIN_PASSWORD = "admin123456";
const RENDER_LIMITS = {
  low: { tracks: 360, dust: 3200, mist: 360 },
  high: { tracks: 1200, dust: 18000, mist: 2400 }
};
const GLOBAL_RENDER_LIMITS = {
  low: { tracks: 520, dust: 4600, mist: 480 },
  high: { tracks: 1800, dust: 24000, mist: 3200 }
};
const REMOTE_API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "https://www.zihang.fun").replace(/\/$/, "");

function installRemoteApiFetch() {
  if (typeof window === "undefined" || window.__caelumShaoRemoteFetchInstalled) return;
  const isHttpPage = /^https?:$/.test(window.location.protocol);
  const isLocalHttpDev = isHttpPage && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const isZihangWeb = isHttpPage && /(^|\.)zihang\.fun$/.test(window.location.hostname);
  const hasDesktopBridgeAtInstall = Boolean(window.caelumShaoDesktop?.isDesktop);
  if (!hasDesktopBridgeAtInstall && (isLocalHttpDev || isZihangWeb) && !import.meta.env.VITE_FORCE_REMOTE_FETCH) {
    window.__caelumShaoRemoteFetchInstalled = true;
    return;
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input?.url || "";
    const shouldRouteRemote = rawUrl.startsWith("/api/") || rawUrl === "/api" || rawUrl.startsWith("/media/") || rawUrl === "/media";
    if (!shouldRouteRemote) return nativeFetch(input, init);
    const nextInput = typeof input === "string"
      ? `${REMOTE_API_BASE_URL}${input}`
      : new Request(`${REMOTE_API_BASE_URL}${new URL(input.url).pathname}${new URL(input.url).search}`, input);
    const isDesktopApp = Boolean(window.caelumShaoDesktop?.isDesktop);
    if (isDesktopApp && window.caelumShaoDesktop?.remoteFetch) {
      const targetUrl = typeof nextInput === "string" ? nextInput : nextInput.url;
      const headers = Object.fromEntries(new Headers(init.headers || (typeof input === "string" ? {} : input.headers || {})).entries());
      return window.caelumShaoDesktop.remoteFetch({
        url: targetUrl,
        init: {
          method: init.method || (typeof input === "string" ? "GET" : input.method || "GET"),
          headers,
          body: init.body || (typeof input === "string" ? undefined : input.body || undefined)
        }
      }).then((result) => new Response(result.status === 204 || result.status === 304 ? null : result.body || "", {
        status: result.status || 500,
        statusText: result.statusText || "",
        headers: result.headers || {}
      }));
    }
    return nativeFetch(nextInput, { credentials: "include", ...init });
  };
  window.__caelumShaoRemoteFetchInstalled = true;
}

installRemoteApiFetch();

function trackKey(track) {
  if (!track) return "";
  return String(track.libraryKey || track.id || track.podcastAudioUrl || track.musicUrl || `${track.title || ""}-${track.artist || ""}`);
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function splitTitle(title) {
  const chars = Array.from(String(title || BRAND_CN));
  if (chars.length <= 10) return [chars.join("")];
  const midpoint = Math.ceil(chars.length / 2);
  return [chars.slice(0, midpoint).join(""), chars.slice(midpoint).join("")];
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}

function isQqQrLoginMode(mode) {
  return mode === "qq-qr" || mode === "qq-wx-qr";
}

function qqQrLoginTypeFromMode(mode) {
  return mode === "qq-wx-qr" ? "wx" : "qq";
}

function platformLabel(platform) {
  const key = String(platform || "").toLowerCase();
  if (key === "qq") return "QQ";
  if (key === "netease") return "网易";
  if (key === "kuwo") return "酷我";
  if (key === "kugou") return "酷狗";
  if (key === "demo") return "Demo";
  return platform || "音乐";
}

function safeFileName(value, fallback = "caelumshao") {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48) || fallback;
}

function normalizePath(pathname = "") {
  const trimmed = String(pathname || "/").replace(/\/+$/, "");
  return trimmed || "/";
}

function readLyricPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LYRIC_POSITION_KEY) || "{}");
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  } catch (_error) {
    // ignore broken user preference
  }
  return { x: 50, y: 16 };
}

function readLibraryCache(accountId = "") {
  try {
    const payload = JSON.parse(localStorage.getItem(accountScopedKey(LIBRARY_CACHE_KEY, accountId)) || "{}");
    const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    return {
      items,
      updatedAt: payload.updatedAt || ""
    };
  } catch (_error) {
    return { items: [], updatedAt: "" };
  }
}

function libraryFingerprint(items = []) {
  return items
    .map((track) => [
      trackKey(track),
      track?.title || "",
      track?.artist || "",
      track?.playlistId || "",
      track?.platform || track?.sourcePlatform || ""
    ].join("|"))
    .join("\n");
}

function compactLibraryTrack(track = {}) {
  return {
    id: track.id || "",
    songId: track.songId || track.songid || "",
    title: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    cover: track.cover || "",
    duration: track.duration || 0,
    publishTime: track.publishTime || "",
    year: track.year || "",
    platform: track.platform || track.sourcePlatform || "",
    sourcePlatform: track.sourcePlatform || track.platform || "",
    mediaId: track.mediaId || track.media_mid || track.raw?.strMediaMid || track.raw?.media_mid || "",
    qqSearchKey: track.qqSearchKey || "",
    musicUrl: track.musicUrl || track.url || "",
    libraryKey: track.libraryKey || trackKey(track),
    playlistId: track.playlistId || "",
    playlistName: track.playlistName || "",
    playlistDescription: track.playlistDescription || "",
    playCount: track.playCount || 0,
    geoRegionKey: track.geoRegionKey || "",
    geoRegionName: track.geoRegionName || "",
    geoRegionLat: track.geoRegionLat || "",
    geoRegionLng: track.geoRegionLng || "",
    geoRegionTint: track.geoRegionTint || ""
  };
}

function writeLibraryCache(items = [], accountId = "") {
  const payload = {
    updatedAt: new Date().toISOString(),
    items: items.map(compactLibraryTrack)
  };
  try {
    localStorage.setItem(accountScopedKey(LIBRARY_CACHE_KEY, accountId), JSON.stringify(payload));
  } catch (error) {
    console.warn("library cache write failed:", error?.message || error);
  }
  return payload;
}

function readDeviceId() {
  try {
    const current = localStorage.getItem(DEVICE_ID_KEY);
    if (current) return current;
    const next = `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_ID_KEY, next);
    return next;
  } catch (_error) {
    return `dev-${Date.now().toString(36)}`;
  }
}

function clearLegacyAccessState() {
  if (typeof window === "undefined") return;
  const current = localStorage.getItem(APP_VERSION_KEY);
  if (current === "2026-06-25-together") return;
  localStorage.setItem(APP_VERSION_KEY, "2026-06-25-together");
}

clearLegacyAccessState();

function defaultQualityMode() {
  if (typeof window === "undefined") return "low";
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches || false;
  const narrow = window.matchMedia?.("(max-width: 760px)")?.matches || false;
  return coarse || narrow ? "low" : "high";
}

function readAdminPassword() {
  try {
    return localStorage.getItem(ADMIN_PASSWORD_KEY) || DEFAULT_ADMIN_PASSWORD;
  } catch (_error) {
    return DEFAULT_ADMIN_PASSWORD;
  }
}

function readObjectCache(key) {
  try {
    const payload = JSON.parse(localStorage.getItem(key) || "{}");
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  } catch (_error) {
    return {};
  }
}

function betaPreferenceKey(userId = "") {
  return `${BETA_ENABLED_KEY}:${String(userId || "guest")}`;
}

function accountScopedKey(baseKey, userId = "") {
  return `${baseKey}:${String(userId || "guest")}`;
}

function writeObjectCache(key, value, maxEntries = 160) {
  try {
    const entries = Object.entries(value || {});
    const bounded = entries.length > maxEntries
      ? Object.fromEntries(entries.sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0)).slice(0, maxEntries))
      : value;
    localStorage.setItem(key, JSON.stringify(bounded));
  } catch (error) {
    console.warn("object cache write failed:", key, error?.message || error);
  }
}

function cacheKeyForTrack(track, prefix = "") {
  const platform = track?.platform || track?.sourcePlatform || "";
  const id = track?.id || track?.songId || track?.mediaId || "";
  const title = track?.title || "";
  const artist = track?.artist || "";
  return `${prefix}${platform}:${id}:${title}:${artist}`;
}

async function readJsonResponse(response, fallbackMessage = "接口请求失败") {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const looksLikeHtml = /^\s*</.test(text);
    throw new Error(looksLikeHtml ? `${fallbackMessage}：服务端返回了 HTML，通常是 API 路由没有命中或后端未启动。` : text || fallbackMessage);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(`${fallbackMessage}：服务端返回的 JSON 无法解析`);
  }
}

function trackSearchText(track) {
  return normalizeText(
    [
      track?.title,
      track?.artist,
      track?.album,
      track?.playlistName,
      track?.playlistDescription,
      track?.year,
      track?.id
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function trackYearValue(track) {
  const year = Number.parseInt(track?.year || "", 10);
  if (Number.isFinite(year)) return year;
  const publish = Number.parseInt(track?.publishTime || track?.raw?.publishTime || "", 10);
  if (Number.isFinite(publish)) {
    const date = new Date(publish);
    if (!Number.isNaN(date.getTime())) return date.getFullYear();
  }
  return 0;
}

function trackPopularity(track) {
  return Number(track?.playCount || track?.raw?.pop || track?.raw?.playCount || 0) || 0;
}

function primaryArtist(track) {
  if (track?.globalArtistName) return String(track.globalArtistName).trim();
  return String(track?.artist || track?.singer || "未知歌手").split(/[\/,&、，;；]/)[0].trim() || "未知歌手";
}

function makeArtistKey(name) {
  return normalizeText(name).replace(/\s+/g, "-") || "unknown";
}

function withArtistCenters(tracks, enabled) {
  if (!enabled) return tracks;
  const groups = new Map();
  tracks.forEach((track) => {
    const artist = primaryArtist(track);
    const key = makeArtistKey(artist);
    if (!groups.has(key)) groups.set(key, { artist, tracks: [] });
    groups.get(key).tracks.push({ ...track, artistGroupKey: key, artistGroupName: artist });
  });
  const next = [];
  [...groups.entries()]
    .sort((a, b) => b[1].tracks.length - a[1].tracks.length || a[1].artist.localeCompare(b[1].artist, "zh-Hans-CN"))
    .forEach(([key, group]) => {
      next.push({
        id: `artist:${key}`,
        libraryKey: `artist:${key}`,
        title: group.artist,
        artist: `${group.tracks.length} 首歌`,
        artistGroupKey: key,
        artistGroupName: group.artist,
        artistCenter: true,
        artistSongs: group.tracks
      });
      next.push(...group.tracks);
    });
  return next;
}

const GEO_REGIONS = [
  { key: "cn-mainland", name: "中国大陆", lat: 35, lng: 104, tint: 0.97 },
  { key: "hk-mo-tw", name: "港澳台", lat: 23.8, lng: 121, tint: 0.88 },
  { key: "jp", name: "日本", lat: 36.2, lng: 138.2, tint: 0.82 },
  { key: "kr", name: "韩国", lat: 36.4, lng: 127.8, tint: 0.8 },
  { key: "sea", name: "东南亚", lat: 10.6, lng: 105.8, tint: 0.7 },
  { key: "eu", name: "欧洲", lat: 50.2, lng: 10.1, tint: 0.62 },
  { key: "na", name: "北美", lat: 40.7, lng: -97.5, tint: 0.58 },
  { key: "sa", name: "南美", lat: -15.8, lng: -60.8, tint: 0.56 },
  { key: "me", name: "中东", lat: 26.8, lng: 46.5, tint: 0.64 },
  { key: "af", name: "非洲", lat: 1.2, lng: 22.2, tint: 0.54 },
  { key: "oc", name: "大洋洲", lat: -25.6, lng: 134.2, tint: 0.6 },
  { key: "global", name: "全球", lat: 0, lng: 0, tint: 0.68 }
];

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function hasKorean(value) {
  return /[\u3130-\u318F\uAC00-\uD7AF]/.test(String(value || ""));
}

function hasJapanese(value) {
  return /[\u3040-\u30ff]/.test(String(value || ""));
}

function resolveGeoRegion(track, seed = 0) {
  const explicit = String(track?.country || track?.region || track?.area || track?.countryName || track?.artistCountry || track?.artistRegion || "").trim();
  const normalized = normalizeText(explicit);
  if (normalized) {
    if (/(中国|china|cn|大陆|内地|中国大陆)/.test(normalized)) return GEO_REGIONS[0];
    if (/(港|澳|台|hong kong|taiwan|macau)/.test(normalized)) return GEO_REGIONS[1];
    if (/(日本|japan|jp)/.test(normalized)) return GEO_REGIONS[2];
    if (/(韩国|korea|kr|south korea)/.test(normalized)) return GEO_REGIONS[3];
    if (/(东南亚|sea|singapore|malaysia|thailand|indonesia|vietnam|philippines)/.test(normalized)) return GEO_REGIONS[4];
    if (/(欧洲|europe|eu|uk|united kingdom|france|germany|italy|spain|netherlands|sweden)/.test(normalized)) return GEO_REGIONS[5];
    if (/(北美|na|usa|united states|america|canada|mexico)/.test(normalized)) return GEO_REGIONS[6];
    if (/(南美|south america|brazil|argentina|chile|peru)/.test(normalized)) return GEO_REGIONS[7];
    if (/(中东|middle east|uae|saudi|turkey|israel|iran|iraq|qatar)/.test(normalized)) return GEO_REGIONS[8];
    if (/(非洲|africa|egy|nigeria|south africa|kenya|morocco)/.test(normalized)) return GEO_REGIONS[9];
    if (/(大洋洲|oceania|australia|new zealand)/.test(normalized)) return GEO_REGIONS[10];
  }
  const fingerprint = `${track?.artist || ""} ${track?.title || ""} ${track?.playlistName || ""}`;
  if (hasKorean(fingerprint)) return GEO_REGIONS[3];
  if (hasJapanese(fingerprint)) return GEO_REGIONS[2];
  if (hasCjk(fingerprint)) return GEO_REGIONS[0];
  const hash = Math.abs(Array.from(fingerprint || String(seed)).reduce((sum, ch) => sum + ch.charCodeAt(0) * 17, 0));
  const pool = [GEO_REGIONS[5], GEO_REGIONS[6], GEO_REGIONS[4], GEO_REGIONS[7], GEO_REGIONS[8], GEO_REGIONS[9], GEO_REGIONS[10]];
  return pool[hash % pool.length] || GEO_REGIONS[11];
}

function sortVisibleTracks(list, sortMode) {
  const next = [...list];
  const withName = (a, b) => String(a?.title || "").localeCompare(String(b?.title || ""), "zh-Hans-CN");
  if (sortMode === "最近") {
    next.sort((a, b) => trackYearValue(b) - trackYearValue(a) || withName(a, b));
  } else if (sortMode === "更多") {
    next.sort((a, b) => String(a?.playlistName || "").localeCompare(String(b?.playlistName || ""), "zh-Hans-CN") || withName(a, b));
  } else if (sortMode === "画质·高") {
    next.sort((a, b) => Number(Boolean(b?.cover)) - Number(Boolean(a?.cover)) || trackPopularity(b) - trackPopularity(a) || withName(a, b));
  } else {
    next.sort((a, b) => trackPopularity(b) - trackPopularity(a) || withName(a, b));
  }
  return next;
}

function pickRenderTracks(list, selectedKey = "", maxTracks = RENDER_LIMITS.low.tracks) {
  if (!Array.isArray(list) || list.length <= maxTracks) return list || [];
  const selectedIndex = selectedKey ? list.findIndex((track) => trackKey(track) === selectedKey) : -1;
  const picked = [];
  const seen = new Set();
  list.forEach((track, index) => {
    if (picked.length >= Math.floor(maxTracks * 0.32)) return;
    if (!track?.artistCenter && !track?.regionCenter) return;
    picked.push(track);
    seen.add(index);
  });
  if (selectedIndex >= 0) {
    picked.push(list[selectedIndex]);
    seen.add(selectedIndex);
  }
  const step = list.length / Math.max(1, maxTracks - picked.length);
  for (let cursor = 0; picked.length < maxTracks && Math.floor(cursor) < list.length; cursor += step) {
    const index = Math.floor(cursor);
    if (seen.has(index)) continue;
    picked.push(list[index]);
    seen.add(index);
  }
  return picked;
}

function fibonacciSphere(index, count, radius) {
  const offset = 2 / Math.max(1, count);
  const increment = Math.PI * (3 - Math.sqrt(5));
  const y = index * offset - 1 + offset / 2;
  const r = Math.sqrt(1 - y * y);
  const phi = index * increment;
  return new THREE.Vector3(Math.cos(phi) * r * radius, y * radius, Math.sin(phi) * r * radius);
}

function seededNoise(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function galaxyPoint(index, count, seedOffset = 0) {
  const t = (index + 0.5) / Math.max(1, count);
  const seed = index + 1 + seedOffset;
  const arm = index % 5;
  const radius = Math.pow(t, 0.56) * (2.35 + seededNoise(seed + 1) * 0.55);
  const angle = arm * ((Math.PI * 2) / 5) + radius * 2.42 + (seededNoise(seed + 2) - 0.5) * 0.74;
  const armSpread = (seededNoise(seed + 3) - 0.5) * (0.18 + radius * 0.08);
  const halo = seededNoise(seed + 4) > 0.86 ? 1.35 + seededNoise(seed + 5) * 0.75 : 1;
  return new THREE.Vector3(
    Math.cos(angle) * radius * halo + Math.cos(angle + Math.PI / 2) * armSpread,
    (seededNoise(seed + 6) - 0.5) * (0.62 - Math.min(0.42, t * 0.36)),
    Math.sin(angle) * radius * 0.64 * halo + Math.sin(angle + Math.PI / 2) * armSpread * 0.52
  );
}

function nebulaLayerColor(point) {
  const radius = point.length();
  const color = new THREE.Color();
  if (radius < 1.05) {
    const bands = [0xf6efe6, 0xf2d9c6, 0xe8f0ff, 0xd9f7ec];
    color.set(bands[Math.floor(seededNoise(radius * 99 + 7) * bands.length) % bands.length]);
  } else if (radius < 2.18) {
    const mix = Math.min(1, Math.max(0, (radius - 1.05) / 1.13));
    const midA = new THREE.Color(0x1bcaa8);
    const midB = new THREE.Color(0x3f8cff);
    const midC = new THREE.Color(0xffc24d);
    const midD = new THREE.Color(0x7f68ff);
    const pick = mix < 0.25 ? midA : mix < 0.5 ? midB : mix < 0.75 ? midC : midD;
    color.copy(pick).lerp(new THREE.Color(0x0f5f7a), Math.max(0.14, mix * 0.42));
  } else {
    const mix = Math.min(1, Math.max(0, (radius - 2.18) / 1.35));
    const outerA = new THREE.Color(0xff6b6b);
    const outerB = new THREE.Color(0xff9f43);
    const outerC = new THREE.Color(0xffd166);
    const outerD = new THREE.Color(0xf78fb3);
    const pick = mix < 0.25 ? outerA : mix < 0.5 ? outerB : mix < 0.75 ? outerC : outerD;
    color.copy(pick).lerp(new THREE.Color(0x7a2e5d), Math.max(0.08, mix * 0.34));
  }
  return color;
}

function normalizeRegionName(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/(中国|china|cn|大陆|内地|中国大陆|华语|国语|mandarin|c-pop|华语乐坛)/.test(text)) return "中国";
  if (/(港|澳|台|hong kong|taiwan|macau|hk|tw)/.test(text)) return "港澳台";
  if (/(日本|japan|jp|j-pop|日语)/.test(text)) return "日本";
  if (/(韩国|korea|kr|k-pop|韩语|south korea)/.test(text)) return "韩国";
  if (/(东南亚|sea|singapore|malaysia|thailand|indonesia|vietnam|philippines)/.test(text)) return "东南亚";
  if (/(欧洲|europe|eu|uk|britain|united kingdom|france|germany|italy|spain|netherlands|sweden)/.test(text)) return "欧洲";
  if (/(北美|na|usa|united states|america|canada|mexico)/.test(text)) return "北美";
  if (/(南美|south america|brazil|argentina|chile|peru)/.test(text)) return "南美";
  if (/(中东|middle east|uae|saudi|turkey|israel|iran|iraq|qatar)/.test(text)) return "中东";
  if (/(非洲|africa|egy|nigeria|south africa|kenya|morocco)/.test(text)) return "非洲";
  if (/(大洋洲|oceania|australia|new zealand)/.test(text)) return "大洋洲";
  return "";
}

function resolveEarthRegion(track, seed = 0) {
  const raw = track?.raw || {};
  const explicit = String([
    track?.country,
    track?.region,
    track?.area,
    track?.countryName,
    track?.artistCountry,
    track?.artistRegion,
    track?.geoRegionName,
    track?.playlistDescription,
    track?.album,
    track?.artist,
    track?.title,
    track?.sourcePlatform,
    raw.country,
    raw.region,
    raw.area,
    raw.countryName,
    raw.artistCountry,
    raw.artistRegion,
    raw.province,
    raw.city,
    raw.location,
    raw.areaName,
    raw.singer,
    raw.singerName,
    raw.language,
    raw.lan,
    raw.songtype,
    raw.tag,
    raw.tags,
    raw.genre
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(" ")).trim();
  const normalized = normalizeRegionName(explicit);
  const regionMap = {
    中国: { key: "cn", name: "中国", lat: 35, lng: 104, tint: "#ff8a6b" },
    港澳台: { key: "hktw", name: "港澳台", lat: 23.8, lng: 121, tint: "#ff9f43" },
    日本: { key: "jp", name: "日本", lat: 36.2, lng: 138.2, tint: "#f8f0e4" },
    韩国: { key: "kr", name: "韩国", lat: 36.4, lng: 127.8, tint: "#89d6a8" },
    东南亚: { key: "sea", name: "东南亚", lat: 10.6, lng: 105.8, tint: "#5cc9b2" },
    欧洲: { key: "eu", name: "欧洲", lat: 50.2, lng: 10.1, tint: "#8fe0ff" },
    北美: { key: "na", name: "北美", lat: 40.7, lng: -97.5, tint: "#c2d5ff" },
    南美: { key: "sa", name: "南美", lat: -15.8, lng: -60.8, tint: "#ffc47e" },
    中东: { key: "me", name: "中东", lat: 26.8, lng: 46.5, tint: "#f1ba84" },
    非洲: { key: "af", name: "非洲", lat: 1.2, lng: 22.2, tint: "#d0b07a" },
    大洋洲: { key: "oc", name: "大洋洲", lat: -25.6, lng: 134.2, tint: "#b5e6d6" }
  };
  if (normalized && regionMap[normalized]) return regionMap[normalized];
  const fingerprint = [
    track?.artist || "",
    track?.title || "",
    track?.playlistName || "",
    track?.album || "",
    track?.sourcePlatform || "",
    raw.singer || "",
    raw.singerName || "",
    raw.singerid || "",
    raw.mid || "",
    raw.songmid || "",
    raw.albumMid || "",
    raw.language || ""
  ].join(" ");
  if (hasKorean(fingerprint)) return regionMap.韩国;
  if (hasJapanese(fingerprint)) return regionMap.日本;
  if (hasCjk(fingerprint)) return regionMap.中国;
  const hash = Math.abs(Array.from(fingerprint || String(seed)).reduce((sum, ch) => sum + ch.charCodeAt(0) * 17, 0));
  const pool = [regionMap.中国, regionMap.日本, regionMap.韩国, regionMap.欧洲, regionMap.北美, regionMap.东南亚, regionMap.南美];
  return pool[hash % pool.length] || regionMap.中国;
}

function annotateEarthTrack(track, seed = 0) {
  const region = resolveEarthRegion(track, seed);
  const raw = track?.raw || {};
  return {
    ...track,
    geoRegionKey: region.key,
    geoRegionName: region.name,
    geoRegionLat: region.lat,
    geoRegionLng: region.lng,
    geoRegionTint: region.tint,
    geoRegionSource: [
      track?.country,
      track?.region,
      track?.area,
      track?.countryName,
      track?.artistCountry,
      track?.artistRegion,
      track?.geoRegionName,
      track?.playlistDescription,
      track?.album,
      track?.artist,
      raw.country,
      raw.region,
      raw.area,
      raw.countryName,
      raw.artistCountry,
      raw.artistRegion,
      raw.province,
      raw.city,
      raw.location,
      raw.areaName,
      raw.singer,
      raw.singerName,
      raw.language,
      raw.lan,
      raw.songtype,
      raw.tag,
      raw.tags,
      raw.genre
    ].filter(Boolean).join(" ")
  };
}

function annotateEarthTracks(tracks = []) {
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => annotateEarthTrack(track, index));
}

function withEarthRegions(tracks) {
  const groups = new Map();
  tracks.forEach((track, index) => {
    if (!track || track.placeholder) return;
    const region = resolveEarthRegion(track, index);
    if (!groups.has(region.key)) {
      groups.set(region.key, { ...region, tracks: [] });
    }
    groups.get(region.key).tracks.push({ ...track, geoRegionKey: region.key, geoRegionName: region.name });
  });
  const next = [];
  [...groups.values()]
    .sort((a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name, "zh-Hans-CN"))
    .forEach((region) => {
      next.push({
        id: `region:${region.key}`,
        libraryKey: `region:${region.key}`,
        title: region.name,
        artist: `${region.tracks.length} 首歌`,
        geoRegionKey: region.key,
        geoRegionName: region.name,
        geoRegionLat: region.lat,
        geoRegionLng: region.lng,
        regionCenter: true,
        regionSongs: region.tracks
      });
      next.push(...region.tracks);
    });
  return next;
}

function SongSphere({ tracks = [], energy = 0, selectedKey = "", playing = false, jumping = false, deepFocus = false, globalMode = false, qualityMode = "low", artistQuery = "", sceneMode = "nebula", resetToken = 0, onSelect, onHover, onBlankDoubleClick }) {
  const mountRef = useRef(null);
  const runtimeRef = useRef(null);
  const tracksRef = useRef(tracks);
  const selectedKeyRef = useRef(selectedKey);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const energyRef = useRef(energy);
  const playingRef = useRef(playing);
  const jumpingRef = useRef(jumping);
  const deepFocusRef = useRef(deepFocus);
  const globalModeRef = useRef(globalMode);
  const qualityModeRef = useRef(qualityMode);
  const artistQueryRef = useRef(artistQuery);
  const sceneModeRef = useRef(sceneMode);
  const resetTokenRef = useRef(resetToken);
  const onBlankDoubleClickRef = useRef(onBlankDoubleClick);

  useEffect(() => {
    tracksRef.current = tracks;
    runtimeRef.current?.updateInstances({ resetProgressive: true });
  }, [tracks]);

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
    runtimeRef.current?.updateInstances();
  }, [selectedKey]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);

  useEffect(() => {
    onBlankDoubleClickRef.current = onBlankDoubleClick;
  }, [onBlankDoubleClick]);

  useEffect(() => {
    energyRef.current = energy;
  }, [energy]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    jumpingRef.current = jumping;
  }, [jumping]);

  useEffect(() => {
    deepFocusRef.current = deepFocus;
  }, [deepFocus]);

  useEffect(() => {
    globalModeRef.current = globalMode;
    runtimeRef.current?.updateInstances({ resetProgressive: true });
  }, [globalMode]);

  useEffect(() => {
    qualityModeRef.current = qualityMode;
    runtimeRef.current?.updateInstances({ resetProgressive: true });
  }, [qualityMode]);

  useEffect(() => {
    artistQueryRef.current = artistQuery;
    runtimeRef.current?.updateInstances();
  }, [artistQuery]);

  useEffect(() => {
    sceneModeRef.current = sceneMode;
    runtimeRef.current?.updateInstances({ resetProgressive: true });
  }, [sceneMode]);

  useEffect(() => {
    if (resetTokenRef.current === resetToken) return;
    resetTokenRef.current = resetToken;
    runtimeRef.current?.resetCamera();
  }, [resetToken]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 160);
    camera.position.set(0, 0, 6);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.42;
    host.appendChild(renderer.domElement);

    const group = new THREE.Group();
    group.rotation.x = -0.12;
    group.rotation.z = -0.08;
    scene.add(group);

    const earthGroup = new THREE.Group();
    earthGroup.visible = false;
    earthGroup.rotation.set(0.08, -0.56, 0.04);
    scene.add(earthGroup);

    const ambientLight = new THREE.AmbientLight(0xe6f7ff, 1.2);
    const hemisphereLight = new THREE.HemisphereLight(0xdff8ff, 0x0b1020, 1.8);
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.8);
    sunLight.position.set(3.5, 1.8, 4.8);
    const rimLight = new THREE.DirectionalLight(0xa8dfff, 1.15);
    rimLight.position.set(-4, 0.5, -2.5);
    scene.add(ambientLight);
    scene.add(hemisphereLight);
    scene.add(sunLight);
    scene.add(rimLight);

    const mistGroup = new THREE.Group();
    mistGroup.rotation.x = -0.1;
    mistGroup.rotation.z = 0.06;
    group.add(mistGroup);

    let trackCloud = null;
    let dust = null;
    let beams = null;
    let mistCloud = null;
    let mistDrift = null;
    let earthGlobe = null;
    let earthRegionLookup = [];
    let earthPickTargets = [];
    let positions = [];
    let renderList = [];
    let activeId = -1;
    let hoverId = -1;
    let hasFocus = false;
    const focusTarget = new THREE.Vector3();
    const focusWorld = new THREE.Vector3();
    const makeFocusTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      const cx = 128;
      const cy = 128;
      const gradient = ctx.createRadialGradient(cx, cy, 8, cx, cy, 86);
      gradient.addColorStop(0, "rgba(255, 248, 214, 0.4)");
      gradient.addColorStop(0.32, "rgba(255, 210, 122, 0.14)");
      gradient.addColorStop(0.68, "rgba(255, 210, 122, 0.05)");
      gradient.addColorStop(1, "rgba(255, 210, 122, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = "rgba(255, 231, 161, 0.82)";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(cx, cy, 31, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 210, 122, 0.36)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 47, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 248, 214, 0.68)";
      ctx.lineWidth = 1.6;
      [[72, 128, 98, 128], [158, 128, 184, 128], [128, 72, 128, 98], [128, 158, 128, 184]].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });
      ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
      ctx.beginPath();
      ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const makeCoreTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 58);
      gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
      gradient.addColorStop(0.18, "rgba(255, 242, 189, 0.96)");
      gradient.addColorStop(0.42, "rgba(255, 210, 122, 0.48)");
      gradient.addColorStop(1, "rgba(255, 210, 122, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const focusTexture = makeFocusTexture();
    const focusCoreTexture = makeCoreTexture();
    const focusGeometry = new THREE.BufferGeometry();
    const focusVertices = new Float32Array([
      0, 0, 0,
      0.08, 0, 0,
      -0.08, 0, 0,
      0, 0.08, 0,
      0, -0.08, 0,
      0, 0, 0.08,
      0, 0, -0.08,
      0.13, 0.04, 0,
      -0.13, -0.04, 0,
      -0.04, 0.13, 0,
      0.04, -0.13, 0,
      0.06, 0.02, 0.06,
      -0.06, -0.02, -0.06
    ]);
    focusGeometry.setAttribute("position", new THREE.BufferAttribute(focusVertices, 3));
    const focusMaterial = new THREE.PointsMaterial({
      size: 0.052,
      sizeAttenuation: true,
      color: 0xfff2bd,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const focusPoints = new THREE.Points(focusGeometry, focusMaterial);
    focusPoints.visible = false;
    group.add(focusPoints);
    const focusHaloMaterial = new THREE.SpriteMaterial({
      map: focusTexture,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const focusHalo = new THREE.Sprite(focusHaloMaterial);
    focusHalo.visible = false;
    group.add(focusHalo);
    const focusCoreMaterial = new THREE.SpriteMaterial({
      map: focusCoreTexture,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const focusCore = new THREE.Sprite(focusCoreMaterial);
    focusCore.visible = false;
    group.add(focusCore);
    const makePointTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 20);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.18, "rgba(255,255,255,0.98)");
      gradient.addColorStop(0.38, "rgba(255,235,168,0.42)");
      gradient.addColorStop(0.62, "rgba(255,205,104,0.1)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const makeMistTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
      gradient.addColorStop(0, "rgba(255, 248, 231, 0.28)");
      gradient.addColorStop(0.28, "rgba(255, 225, 171, 0.12)");
      gradient.addColorStop(0.64, "rgba(255, 210, 122, 0.04)");
      gradient.addColorStop(1, "rgba(255, 210, 122, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const pointTexture = makePointTexture();
    const mistTexture = makeMistTexture();
    const mistMaterial = new THREE.PointsMaterial({
      size: 0.34,
      map: mistTexture,
      transparent: true,
      opacity: 0.08,
      color: 0xf5e8c8,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const dustMaterial = new THREE.PointsMaterial({
      size: 0.015,
      map: pointTexture,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const trackMaterial = new THREE.PointsMaterial({
      size: 0.078,
      map: pointTexture,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const beamMaterial = new THREE.LineBasicMaterial({
      color: 0xffe7a1,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const color = new THREE.Color();
    const goldColor = new THREE.Color(0xffd36f);
    const coreStarColor = new THREE.Color(0xf1efe3);
    const hoverStarColor = new THREE.Color(0xfff2bd);
    const mistColor = new THREE.Color(0xf5e8c8);
    const raycaster = new THREE.Raycaster();
    const isCoarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches || false;
    raycaster.params.Points.threshold = isCoarsePointer ? 0.24 : 0.075;
    const pointer = new THREE.Vector2();
    const activePointers = new Map();
    const pressedKeys = new Set();
    const cameraRight = new THREE.Vector3();
    const cameraForward = new THREE.Vector3();
    const cameraVelocity = new THREE.Vector3();
    const panDelta = new THREE.Vector3();
    const rotationVelocity = new THREE.Vector2();
    const touchHoverTimer = { id: 0 };
    const touchPanVelocity = new THREE.Vector3();
    let dragging = false;
    let lastCenter = null;
    let lastTouchDistance = 0;
    let touchHoverPointerId = null;
    let lastPointerDown = { x: 0, y: 0, time: 0 };
    let wheelZoom = 0.42;
    let wheelZoomTarget = 0.42;
    let raf = 0;
    let progressiveReady = qualityModeRef.current !== "high";
    let progressiveTimer = 0;
    let buildGeneration = 0;
    const zoomBounds = () => {
      const closeFocus = jumpingRef.current || deepFocusRef.current;
      return {
        min: closeFocus ? 0.16 : 0.32,
        max: closeFocus ? 4.2 : 7.8
      };
    };

    const setEarthVisibility = (visible) => {
      earthGroup.visible = visible;
      group.visible = !visible;
      host.classList.toggle("is-earth-view", visible);
    };

    const getActiveSceneGroup = () => (sceneModeRef.current === "earth" ? earthGroup : group);
    const pointToVector = (lat, lng) => {
      const phi = (90 - Number(lat || 0)) * Math.PI / 180;
      const theta = (90 - Number(lng || 0)) * Math.PI / 180;
      const r = 1.01;
      const sinPhi = Math.sin(phi);
      return new THREE.Vector3(
        r * sinPhi * Math.cos(theta),
        r * Math.cos(phi),
        r * sinPhi * Math.sin(theta)
      );
    };
    const earthTrackFromPointer = (event) => {
      if (!earthPickTargets.length || sceneModeRef.current !== "earth") return null;
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera({ x, y }, camera);
      const ray = raycaster.ray;
      let best = null;
      let bestScore = Infinity;
      earthPickTargets.forEach((target) => {
        const worldPoint = pointToVector(target.lat, target.lng).applyEuler(earthGroup.rotation).multiplyScalar(earthGroup.scale.x || 1);
        const score = ray.distanceSqToPoint(worldPoint);
        if (score < bestScore) {
          bestScore = score;
          best = target;
        }
      });
      return bestScore < 0.12 ? best : null;
    };
    const keepEarthOutside = () => {
      if (sceneModeRef.current !== "earth") return;
      const minDistance = 8.8;
      const len = camera.position.length();
      if (len > 0 && len < minDistance) {
        camera.position.normalize().multiplyScalar(minDistance);
      }
      if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y) || !Number.isFinite(camera.position.z)) {
        camera.position.set(0, 0, minDistance);
      }
      camera.position.z = Math.max(camera.position.z, 6.2);
    };

    const buildEarthScene = () => {
      const earthTracks = annotateEarthTracks(tracksRef.current).filter((track) => !track.placeholder);
      earthPickTargets = earthTracks.map((track, index) => ({
        index,
        key: trackKey(track),
        lat: Number(track.geoRegionLat || 0),
        lng: Number(track.geoRegionLng || 0),
        track
      }));
      const regionGroups = new Map();
      earthTracks.forEach((track) => {
        if (!regionGroups.has(track.geoRegionKey)) {
          regionGroups.set(track.geoRegionKey, {
            key: track.geoRegionKey,
            name: track.geoRegionName,
            lat: track.geoRegionLat,
            lng: track.geoRegionLng,
            tint: track.geoRegionTint,
            tracks: []
          });
        }
        regionGroups.get(track.geoRegionKey).tracks.push(track);
      });
      earthRegionLookup = [...regionGroups.values()];

      const globe = earthGlobe || new ThreeGlobe({ waitForGlobeReady: false, animateIn: false })
        .globeImageUrl("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg")
        .bumpImageUrl("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png")
        .showGlobe(true)
        .showGraticules(false)
        .showAtmosphere(true)
        .atmosphereColor("#86d4ff")
        .atmosphereAltitude(0.22)
        .globeCurvatureResolution(2)
        .pointsData(earthPickTargets.map((point, index) => ({
          lat: point.lat,
          lng: point.lng,
          regionKey: point.track.geoRegionKey,
          regionName: point.track.geoRegionName,
          index,
          title: point.track.title,
          artist: point.track.artist,
          cover: point.track.cover,
          year: point.track.year,
          track: point.track,
          size: Math.max(0.18, Math.min(0.36, 0.14 + index % 7 * 0.015))
        })))
        .pointLat("lat")
        .pointLng("lng")
        .pointColor((point) => {
          const selected = earthSelectionKey && point.regionKey === earthSelectionKey.replace("region:", "");
          return selected ? "#ffe28a" : "#ffffff";
        })
        .pointAltitude((point) => {
          const selected = earthSelectionKey && point.regionKey === earthSelectionKey.replace("region:", "");
          return selected ? 0.16 : 0.1;
        })
        .pointRadius((point) => {
          const selected = earthSelectionKey && point.regionKey === earthSelectionKey.replace("region:", "");
          return selected ? 0.52 : 0.34;
        })
        .pointsTransitionDuration(650)
        .ringsData([])
        .ringLat("lat")
        .ringLng("lng")
        .ringColor(() => ["rgba(255,255,255,0.62)", "rgba(129,218,255,0.4)", "rgba(255,232,150,0.18)"])
        .ringMaxRadius(3.2)
        .ringPropagationSpeed(1.6)
        .ringRepeatPeriod(850);
      globe.position.set(0, 0, 0);
      globe.scale.setScalar(0.0135);
      if (!earthGlobe) {
        earthGlobe = globe;
        earthGroup.add(globe);
      }
      earthGlobe.visible = true;
      earthGroup.scale.setScalar(1.12);
      earthGroup.visible = true;
      earthGlobe.setPointOfView?.(camera);
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const scheduleFullQuality = (generation) => {
      window.clearTimeout(progressiveTimer);
      if (qualityModeRef.current !== "high" || progressiveReady) return;
      progressiveTimer = window.setTimeout(() => {
        if (generation !== buildGeneration || qualityModeRef.current !== "high") return;
        progressiveReady = true;
        updateInstances();
      }, 180);
    };

    const updateInstances = (options = {}) => {
      if (options.resetProgressive) {
        progressiveReady = qualityModeRef.current !== "high";
        window.clearTimeout(progressiveTimer);
      }
      const generation = ++buildGeneration;
      const effectiveQuality = qualityModeRef.current === "high" && !progressiveReady ? "low" : qualityModeRef.current;
      const sceneTracks = sceneModeRef.current === "earth" ? annotateEarthTracks(tracksRef.current) : tracksRef.current;
      const sourceTracks = sceneTracks.length
        ? (sceneModeRef.current === "earth"
          ? sceneTracks
          : pickRenderTracks(
              sceneTracks,
              selectedKeyRef.current,
              globalModeRef.current
                ? (GLOBAL_RENDER_LIMITS[effectiveQuality]?.tracks || GLOBAL_RENDER_LIMITS.low.tracks)
                : (RENDER_LIMITS[effectiveQuality]?.tracks || RENDER_LIMITS.low.tracks)
            ))
        : Array.from({ length: 220 }, (_, index) => ({
            title: "等待曲库",
            artist: BRAND_CN,
            libraryKey: `placeholder-${index}`,
            placeholder: true
          }));
      const list = sourceTracks;
      renderList = list;

      if (trackCloud) {
        group.remove(trackCloud);
        trackCloud.geometry.dispose();
      }
      if (dust) {
        group.remove(dust);
        dust.geometry.dispose();
      }
      if (beams) {
        group.remove(beams);
        beams.geometry.dispose();
      }
      if (mistCloud) {
        mistGroup.remove(mistCloud);
        mistCloud.geometry.dispose();
      }

      const artistCenters = new Map();
      const artistGroups = new Map();
      if (globalModeRef.current && sceneModeRef.current === "nebula") {
        list.forEach((track) => {
          if (track.artistCenter) artistCenters.set(track.artistGroupKey, null);
          else if (track.artistGroupKey) {
            if (!artistGroups.has(track.artistGroupKey)) artistGroups.set(track.artistGroupKey, []);
            artistGroups.get(track.artistGroupKey).push(track);
          }
        });
      }

      positions = list.map((track, index) => {
        const seed = String(track.libraryKey || track.id || track.title || index).split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        if (sceneModeRef.current === "earth") {
          const region = resolveEarthRegion(track, index);
          return new THREE.Vector3(
            Math.cos((region.lng || 0) * Math.PI / 180) * (1.46 + seededNoise(seed + 72) * 0.08),
            Math.sin((region.lat || 0) * Math.PI / 180) * 1.46,
            Math.sin((region.lng || 0) * Math.PI / 180) * (1.46 + seededNoise(seed + 44) * 0.08)
          );
        }
        if (!globalModeRef.current) return galaxyPoint(index, Math.max(list.length, 1), seed);
        if (track.artistCenter) {
          const centerIndex = [...artistCenters.keys()].indexOf(track.artistGroupKey);
          const artistSeed = String(track.artistGroupKey || track.title || seed).split("").reduce((sum, ch) => sum + ch.charCodeAt(0) * 17, 0);
          const center = artistCenters.size === 1
            ? galaxyPoint(artistSeed % 997, 997, artistSeed).multiplyScalar(0.58)
            : galaxyPoint(centerIndex, Math.max(artistCenters.size, 1), seed).multiplyScalar(0.92);
          artistCenters.set(track.artistGroupKey, center);
          return center;
        }
        const center = artistCenters.get(track.artistGroupKey) || galaxyPoint(index, Math.max(list.length, 1), seed);
        const siblings = artistGroups.get(track.artistGroupKey) || [];
        const localIndex = Math.max(0, siblings.findIndex((item) => trackKey(item) === trackKey(track)));
        const total = Math.max(1, siblings.length);
        const spiral = localIndex / total;
        const angle = localIndex * 2.399963 + seededNoise(seed) * 0.42;
        const radius = 0.055 + Math.sqrt(spiral) * Math.min(0.32, 0.13 + total * 0.0035);
        const orbit = new THREE.Vector3(
          Math.cos(angle) * radius,
          (seededNoise(seed + 44) - 0.5) * 0.075,
          Math.sin(angle) * radius * 0.72
        );
        const tilt = 0.18 + seededNoise(seed + 17) * 0.36;
        orbit.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
        orbit.applyAxisAngle(new THREE.Vector3(0, 1, 0), seededNoise(makeArtistKey(track.artistGroupName).length + 9) * Math.PI);
        return center.clone().add(orbit);
      });

      const renderLimits = globalModeRef.current
        ? (GLOBAL_RENDER_LIMITS[effectiveQuality] || GLOBAL_RENDER_LIMITS.low)
        : (RENDER_LIMITS[effectiveQuality] || RENDER_LIMITS.low);
      const highQuality = effectiveQuality === "high";
      const dustBase = highQuality ? 30000 : 6500;
      const dustPerTrack = highQuality ? 72 : 22;
      const dustCount = Math.max(dustBase, Math.min(renderLimits.dust, Math.max(list.length * dustPerTrack, dustBase)));
      const dustPositions = new Float32Array(dustCount * 3);
      const dustColors = new Float32Array(dustCount * 3);
      for (let i = 0; i < dustCount; i += 1) {
        const point = galaxyPoint(i, dustCount, 9000);
        const core = 1 - Math.min(1, point.length() / 3.6);
        dustPositions[i * 3] = point.x;
        dustPositions[i * 3 + 1] = point.y + (seededNoise(i + 55) - 0.5) * 0.08;
        dustPositions[i * 3 + 2] = point.z;
        const c = nebulaLayerColor(point);
        const band = point.length() < 1.05 ? 0.58 : point.length() < 2.18 ? 1.28 : 1.45;
        const qualityTint = highQuality ? 0.18 * Math.sin(i * 0.013 + point.x * 2.7) : 0;
        const warmth = band + core * (highQuality ? 0.16 : 0.08) + seededNoise(i + 88) * (highQuality ? 0.2 : 0.12) + qualityTint;
        dustColors[i * 3] = c.r * warmth;
        dustColors[i * 3 + 1] = c.g * warmth;
        dustColors[i * 3 + 2] = c.b * warmth;
      }
      const dustGeometry = new THREE.BufferGeometry();
      dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
      dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
      dust = new THREE.Points(dustGeometry, dustMaterial);
      group.add(dust);

      const mistBase = highQuality ? 3600 : 700;
      const mistRatio = highQuality ? 0.17 : 0.075;
      const mistCount = Math.max(mistBase, Math.min(renderLimits.mist, Math.floor(dustCount * mistRatio)));
      const mistPositions = new Float32Array(mistCount * 3);
      const mistColors = new Float32Array(mistCount * 3);
      for (let i = 0; i < mistCount; i += 1) {
        const point = galaxyPoint(i + 77, mistCount, 2500);
        const scatter = highQuality ? 0.68 + seededNoise(i + 991) * 2.2 : 0.95 + seededNoise(i + 991) * 1.45;
        mistPositions[i * 3] = point.x * scatter;
        mistPositions[i * 3 + 1] = point.y * (highQuality ? 1.05 : 0.92) + (seededNoise(i + 321) - 0.5) * (highQuality ? 0.38 : 0.2);
        mistPositions[i * 3 + 2] = point.z * scatter;
        const core = Math.max(0.12, 1 - Math.min(1, point.length() / 3.9));
        if (highQuality) {
          mistColor.setHSL((seededNoise(i + 43) * 0.82 + 0.02) % 1, 0.42, 0.72);
        } else {
          mistColor.setHSL(0.11 + seededNoise(i + 43) * 0.05, 0.28, 0.7);
        }
        const mistLift = highQuality ? 0.22 + core * 0.34 : 0.24 + core * 0.2;
        mistColors[i * 3] = mistColor.r * mistLift;
        mistColors[i * 3 + 1] = mistColor.g * mistLift;
        mistColors[i * 3 + 2] = mistColor.b * mistLift;
      }
      const mistGeometry = new THREE.BufferGeometry();
      mistGeometry.setAttribute("position", new THREE.BufferAttribute(mistPositions, 3));
      mistGeometry.setAttribute("color", new THREE.BufferAttribute(mistColors, 3));
      mistCloud = new THREE.Points(mistGeometry, mistMaterial);
      mistGroup.add(mistCloud);
      mistDrift = new Float32Array(mistCount * 3);

      activeId = list.findIndex((track) => trackKey(track) === selectedKeyRef.current);
      hasFocus = activeId >= 0 && positions[activeId];
      if (hasFocus) {
        focusTarget.copy(positions[activeId]);
        focusPoints.position.copy(focusTarget);
        focusHalo.position.copy(focusTarget);
        focusCore.position.copy(focusTarget);
        focusPoints.visible = true;
        focusHalo.visible = true;
        focusCore.visible = true;
      } else {
        focusTarget.set(0, 0, 0);
        focusPoints.visible = false;
        focusHalo.visible = false;
        focusCore.visible = false;
      }
      const trackPositions = new Float32Array(list.length * 3);
      const trackColors = new Float32Array(list.length * 3);
      const q = normalizeText(artistQueryRef.current);
      const beamVertices = [];
      list.forEach((track, index) => {
        const isActive = index === activeId;
        const isHover = index === hoverId;
        const isGlobalHit = globalModeRef.current && !track.placeholder && (track.globalSearch || track.artistCenter || track.regionCenter);
        const artistHit = q && normalizeText(track.artistGroupName || track.title || track.artist || "").includes(q);
        const isSearchGold = isGlobalHit && (!q || artistHit || track.globalSearchMode === "artist");
        const lifted = positions[index].clone();
        if (isActive || isHover) {
          lifted.add(positions[index].clone().normalize().multiplyScalar(isActive ? 0.08 : 0.045));
        }
        trackPositions[index * 3] = lifted.x;
        trackPositions[index * 3 + 1] = lifted.y;
        trackPositions[index * 3 + 2] = lifted.z;
        color.copy(
          sceneModeRef.current === "earth"
            ? (track.regionCenter ? new THREE.Color(0xf1ffff) : new THREE.Color(0x9fd7f2))
            : (isSearchGold ? goldColor : track.artistCenter || isActive ? coreStarColor : isHover ? hoverStarColor : nebulaLayerColor(lifted))
        );
        const boost = isSearchGold
          ? (track.artistCenter ? 3.85 : 2.55)
          : sceneModeRef.current === "earth"
            ? (track.regionCenter ? 3.25 : 1.62)
            : track.artistCenter
            ? 2.35
            : isActive
              ? 1.95
              : isHover
                ? 1.62
                : globalModeRef.current
                  ? 0.78
                  : 1.02;
        trackColors[index * 3] = color.r * boost;
        trackColors[index * 3 + 1] = color.g * boost;
        trackColors[index * 3 + 2] = color.b * boost;
        if (!track.placeholder && !track.artistCenter && !track.regionCenter) {
          const height = isSearchGold || isActive || isHover ? 1.55 : 0.7;
          beamVertices.push(lifted.x, lifted.y + 0.06, lifted.z, lifted.x, lifted.y + height, lifted.z);
        }
      });
      const trackGeometry = new THREE.BufferGeometry();
      trackGeometry.setAttribute("position", new THREE.BufferAttribute(trackPositions, 3));
      trackGeometry.setAttribute("color", new THREE.BufferAttribute(trackColors, 3));
      trackCloud = new THREE.Points(trackGeometry, trackMaterial);
      group.add(trackCloud);
      const beamGeometry = new THREE.BufferGeometry();
      beamGeometry.setAttribute("position", new THREE.Float32BufferAttribute(beamVertices, 3));
      beams = new THREE.LineSegments(beamGeometry, beamMaterial);
      beams.visible = beamVertices.length > 0;
      group.add(beams);
      if (sceneModeRef.current === "earth") {
        buildEarthScene();
        setEarthVisibility(true);
      } else {
        setEarthVisibility(false);
      }
      scheduleFullQuality(generation);
    };

    const resetCamera = () => {
      camera.position.set(0, 0, sceneModeRef.current === "earth" ? 7.2 : 6);
      cameraVelocity.set(0, 0, 0);
      rotationVelocity.set(0, 0);
      wheelZoom = 0.42;
      wheelZoomTarget = 0.42;
      group.position.set(0, 0, 0);
      group.rotation.x = -0.12;
      group.rotation.y = 0;
      group.rotation.z = -0.08;
      earthGroup.rotation.set(0.08, -0.56, 0.04);
      earthGroup.position.set(0, 0, 0);
      earthGlobe?.setPointOfView?.(camera);
    };

    const setPointerFromEvent = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    };

    const hitTest = (event) => {
      if (!trackCloud) return null;
      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      if (sceneModeRef.current === "earth" && earthPickTargets.length) {
        const target = earthTrackFromPointer(event);
        if (target) return target.index;
      }
      if (hasFocus && activeId >= 0) {
        focusHalo.updateMatrixWorld();
        const coreHit = raycaster.intersectObject(focusHalo)[0];
        if (coreHit) return activeId;
      }
      const hit = raycaster.intersectObject(trackCloud)[0];
      return hit && Number.isFinite(hit.index) ? hit.index : null;
    };

    const setHover = (nextId) => {
      if (nextId === hoverId) return;
      hoverId = Number.isFinite(nextId) ? nextId : -1;
      const track = hoverId >= 0 ? renderList[hoverId] : null;
      const hoverTrack = track && !track.placeholder ? track : null;
      host.classList.toggle("has-hover", Boolean(hoverTrack));
      onHoverRef.current?.(hoverTrack);
      if (hoverTrack) {
        if (sceneModeRef.current === "earth") setHoveredTrack(hoverTrack);
        setMessage(sceneModeRef.current === "earth"
          ? `${hoverTrack.title} · ${hoverTrack.geoRegionName || hoverTrack.playlistName || hoverTrack.artist || "地球歌曲"}`
          : `${hoverTrack.title} · ${hoverTrack.artist || hoverTrack.playlistName || ""}`);
      }
    };

    const selectInstance = (instanceId) => {
      const track = renderList[instanceId];
      if (!track || track.placeholder) return;
      if (track.regionCenter) {
        setEarthSelection(track);
        onSelectRef.current?.(track);
        return;
      }
      activeId = instanceId;
      selectedKeyRef.current = trackKey(track);
      updateInstances();
      onSelectRef.current?.(track);
    };

    const centerFromPointers = () => {
      const points = [...activePointers.values()];
      if (!points.length) return null;
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      return { x, y };
    };

    const onPointerDown = (event) => {
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      host.setPointerCapture?.(event.pointerId);
      dragging = true;
      if (isCoarsePointer) {
        window.clearTimeout(touchHoverTimer.id);
        touchHoverPointerId = event.pointerId;
      }
      lastCenter = centerFromPointers();
      lastPointerDown = { x: event.clientX, y: event.clientY, time: Date.now() };
      const pointers = [...activePointers.values()];
      if (pointers.length === 2) {
        const [a, b] = pointers;
        lastTouchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };

    const onPointerMove = (event) => {
      if (!activePointers.has(event.pointerId)) {
        if (sceneModeRef.current === "earth" && dragging) return;
        const nextHover = hitTest(event);
        setHover(nextHover);
        return;
      }
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (isCoarsePointer && touchHoverPointerId === event.pointerId) {
        const moved = Math.hypot(event.clientX - lastPointerDown.x, event.clientY - lastPointerDown.y);
        if (moved > 10) window.clearTimeout(touchHoverTimer.id);
      }
      const center = centerFromPointers();
      if (!dragging || !center || !lastCenter) return;
      const pointers = [...activePointers.values()];
      if (isCoarsePointer && pointers.length === 2) {
        const [a, b] = pointers;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastTouchDistance > 0) {
          const bounds = zoomBounds();
          wheelZoomTarget = Math.max(bounds.min, Math.min(bounds.max, wheelZoomTarget + (distance - lastTouchDistance) * 0.012));
        }
        lastTouchDistance = distance;
      }
      const dx = center.x - lastCenter.x;
      const dy = center.y - lastCenter.y;
      const activeGroup = getActiveSceneGroup();
      if (isCoarsePointer && activePointers.size === 1) {
        const panScale = Math.max(0.0026, Math.min(0.0052, 1 / Math.max(240, renderer.domElement.getBoundingClientRect().width)));
        if (sceneModeRef.current === "earth") {
          cameraVelocity.addScaledVector(cameraRight, -dx * panScale * 0.55);
          cameraVelocity.addScaledVector(cameraForward, dy * panScale * 0.45);
        } else {
          cameraVelocity.addScaledVector(cameraRight, -dx * panScale);
          cameraVelocity.addScaledVector(cameraForward, dy * panScale * 0.72);
        }
        touchPanVelocity.set(-dx * panScale, dy * panScale, 0);
        rotationVelocity.multiplyScalar(0.92);
      } else {
        if (sceneModeRef.current === "earth") {
          earthGroup.rotation.y += dx * 0.0042;
          earthGroup.rotation.x += dy * 0.0032;
        } else {
          activeGroup.rotation.y += dx * 0.0062;
          activeGroup.rotation.x += dy * 0.0046;
        }
        rotationVelocity.set(dx * 0.00036, dy * 0.00028);
      }
      (sceneModeRef.current === "earth" ? earthGroup : activeGroup).rotation.x = Math.max(-1.08, Math.min(1.08, (sceneModeRef.current === "earth" ? earthGroup : activeGroup).rotation.x));
      lastCenter = center;
    };

    const onPointerUp = (event) => {
      activePointers.delete(event.pointerId);
      host.releasePointerCapture?.(event.pointerId);
      const moved = Math.hypot(event.clientX - lastPointerDown.x, event.clientY - lastPointerDown.y);
      const tapMoveLimit = isCoarsePointer ? 18 : 7;
      const tapTimeLimit = isCoarsePointer ? 620 : 420;
      if (moved < tapMoveLimit && Date.now() - lastPointerDown.time < tapTimeLimit && trackCloud) {
        const instanceId = hitTest(event);
        if (Number.isFinite(instanceId)) selectInstance(instanceId);
      } else if (sceneModeRef.current === "earth") {
        const instanceId = hitTest(event);
        if (Number.isFinite(instanceId)) setHover(instanceId);
      }
      if (isCoarsePointer && touchHoverPointerId === event.pointerId) {
        window.clearTimeout(touchHoverTimer.id);
        touchHoverPointerId = null;
      }
      if (activePointers.size < 2) lastTouchDistance = 0;
      lastCenter = centerFromPointers();
      dragging = activePointers.size > 0;
    };

    const onWheel = (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const factor = direction > 0 ? 1.11 : 0.9;
      const bounds = zoomBounds();
      wheelZoomTarget = Math.max(bounds.min, Math.min(bounds.max, wheelZoomTarget * factor));
    };

    const onDoubleClick = (event) => {
      if (Number.isFinite(hitTest(event))) return;
      onBlankDoubleClickRef.current?.({ x: event.clientX, y: event.clientY });
    };

    const scheduleTouchHover = (event) => {
      if (!isCoarsePointer || activePointers.size !== 1) return;
      window.clearTimeout(touchHoverTimer.id);
      const { pointerId } = event;
      touchHoverPointerId = pointerId;
      touchHoverTimer.id = window.setTimeout(() => {
        if (touchHoverPointerId !== pointerId || !activePointers.has(pointerId)) return;
        const instanceId = hitTest(event);
        if (Number.isFinite(instanceId)) setHover(instanceId);
      }, 260);
    };

    const shouldIgnoreKeyboardPan = () => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable;
    };

    const onKeyDown = (event) => {
      if (shouldIgnoreKeyboardPan()) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"].includes(key)) return;
      event.preventDefault();
      pressedKeys.add(key);
    };

    const onKeyUp = (event) => {
      pressedKeys.delete(event.key.toLowerCase());
    };

    const animate = () => {
      if (document.hidden) {
        raf = window.requestAnimationFrame(animate);
        return;
      }
      const closeFocus = jumpingRef.current || deepFocusRef.current;
      const panSpeed = closeFocus ? 0.026 : 0.018;
      const depthSpeed = closeFocus ? 0.048 : 0.036;
      const panX = (pressedKeys.has("d") || pressedKeys.has("arrowright") ? 1 : 0) - (pressedKeys.has("a") || pressedKeys.has("arrowleft") ? 1 : 0);
      const depth = (pressedKeys.has("w") || pressedKeys.has("arrowup") ? 1 : 0) - (pressedKeys.has("s") || pressedKeys.has("arrowdown") ? 1 : 0);
      camera.updateMatrixWorld();
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      camera.getWorldDirection(cameraForward).normalize();
      if (panX || depth) {
        panDelta.copy(cameraRight).multiplyScalar(panX * panSpeed).addScaledVector(cameraForward, depth * depthSpeed);
        cameraVelocity.add(panDelta.multiplyScalar(0.18));
      }
      cameraVelocity.multiplyScalar(panX || depth ? 0.9 : 0.94);
      if (cameraVelocity.lengthSq() < 0.000001) cameraVelocity.set(0, 0, 0);
      camera.position.add(cameraVelocity);
      keepEarthOutside();
      camera.position.x = Math.max(-7.8, Math.min(7.8, camera.position.x));
      camera.position.y = Math.max(-5.2, Math.min(5.2, camera.position.y));
      camera.position.z = Math.max(0.7, Math.min(24, camera.position.z));
      const bounds = zoomBounds();
      if (sceneModeRef.current === "earth") bounds.min = Math.max(bounds.min, 0.72);
      wheelZoomTarget = Math.max(bounds.min, Math.min(bounds.max, wheelZoomTarget));
      const jumpBoost = jumpingRef.current ? 0.32 : deepFocusRef.current ? 0.18 : 0;
      const focusScale = hasFocus ? (closeFocus ? 4.1 : 1.68) : 1;
      wheelZoom += (wheelZoomTarget - wheelZoom) * 0.12;
      const pulse = (focusScale + jumpBoost + Math.min(0.06, energyRef.current * 0.06)) * wheelZoom;
      const activeGroup = getActiveSceneGroup();
      activeGroup.scale.lerp(new THREE.Vector3(pulse, pulse, pulse), closeFocus ? 0.115 : 0.075);
      if (hasFocus && !dragging) {
        focusWorld.copy(focusTarget).multiplyScalar(pulse).applyEuler(group.rotation);
        focusWorld.set(-focusWorld.x, -focusWorld.y, -focusWorld.z * 0.16);
        group.position.lerp(focusWorld, closeFocus ? 0.16 : 0.065);
      } else if (!dragging) {
        group.position.lerp(new THREE.Vector3(0, 0, 0), 0.035);
      }
      focusPoints.scale.setScalar(closeFocus ? 3.55 : 1.85);
      focusHalo.scale.setScalar(closeFocus ? 0.38 : 0.28);
      focusCore.scale.setScalar(closeFocus ? 0.22 : 0.11);
      focusMaterial.opacity = closeFocus ? 0.98 : 0.78;
      focusHaloMaterial.opacity = closeFocus ? 0.78 : 0.62;
      focusCoreMaterial.opacity = closeFocus ? 0.98 : 0.86;
      const now = performance.now() * 0.001;
      const highQuality = qualityModeRef.current === "high";
      if (sceneModeRef.current === "earth") {
        earthGlobe?.setPointOfView?.(camera);
        earthGroup.visible = true;
        earthGlobe.visible = true;
        if (!dragging) {
          earthGroup.rotation.y += 0.00028 + energyRef.current * 0.0012;
          earthGroup.rotation.x += 0.00003;
        }
      }
      const farAmount = closeFocus
        ? 0
        : Math.max(0, Math.min(1, ((camera.position.z - 4.9) / 6.2) + ((0.92 - wheelZoom) * 0.92)));
      const fadeOut = closeFocus ? 0 : Math.max(0, Math.min(1, (camera.position.z - 7.3) / 4.8));
      const dustTwinkle = farAmount * ((highQuality ? 0.035 : 0.055) * Math.sin(now * 1.7) + (highQuality ? 0.018 : 0.032) * Math.sin(now * 3.9 + 1.8));
      const trackTwinkle = farAmount * ((highQuality ? 0.045 : 0.07) * Math.sin(now * 2.35 + 0.7) + (highQuality ? 0.016 : 0.026) * Math.sin(now * 5.1));
      if (mistCloud) {
        mistGroup.rotation.y += highQuality ? 0.000045 : 0.00003;
        mistGroup.rotation.x += highQuality ? 0.000018 : 0.00001;
        mistCloud.position.x = Math.sin(now * (highQuality ? 0.055 : 0.08)) * (highQuality ? 0.14 : 0.08);
        mistCloud.position.y = Math.cos(now * (highQuality ? 0.045 : 0.06)) * (highQuality ? 0.09 : 0.05);
        mistCloud.position.z = Math.sin(now * (highQuality ? 0.04 : 0.05)) * (highQuality ? 0.16 : 0.1);
        mistMaterial.opacity = closeFocus
          ? (highQuality ? 0.05 : 0.035)
          : ((highQuality ? 0.095 : 0.06) + farAmount * (highQuality ? 0.055 : 0.035) + Math.sin(now * 0.45) * (highQuality ? 0.012 : 0.008)) * (1 - fadeOut * 0.68);
        mistMaterial.size = closeFocus
          ? (highQuality ? 0.26 : 0.18)
          : ((highQuality ? 0.38 : 0.24) + farAmount * (highQuality ? 0.12 : 0.06)) * (1 - fadeOut * 0.16);
      }
      const distanceScale = Math.max(0.88, Math.min(1.12, 7.4 / Math.max(2.2, camera.position.z)));
      dustMaterial.size = (closeFocus ? 0.009 : highQuality ? 0.012 : 0.014) * distanceScale * (1 + farAmount * 0.02 + dustTwinkle * 0.25) * (1 - fadeOut * 0.2);
      dustMaterial.opacity = closeFocus ? 0.82 : (highQuality ? 0.72 : 0.82) * (1 - fadeOut * 0.72);
      trackMaterial.size = (closeFocus ? 0.078 : highQuality ? 0.082 : 0.09) * (isCoarsePointer ? 1.34 : 1) * distanceScale * (1 + farAmount * 0.02 + trackTwinkle * 0.2) * (1 - fadeOut * 0.14);
      trackMaterial.opacity = closeFocus ? 0.9 : (highQuality ? 0.8 : 0.88) * (1 - fadeOut * 0.68);
      if (!dragging) {
        if (isCoarsePointer && touchPanVelocity.lengthSq() > 0.0000001) {
          touchPanVelocity.multiplyScalar(0.9);
        }
        if (rotationVelocity.lengthSq() > 0.0000001) {
          const activeGroup = getActiveSceneGroup();
          activeGroup.rotation.y += rotationVelocity.x;
          activeGroup.rotation.x += rotationVelocity.y;
          activeGroup.rotation.x = Math.max(-1.08, Math.min(1.08, activeGroup.rotation.x));
          rotationVelocity.multiplyScalar(0.94);
        }
        const playingSpin = playingRef.current ? (closeFocus ? 0.00018 : hasFocus ? 0.00042 : 0.00115) : 0;
        const activeGroup = getActiveSceneGroup();
        activeGroup.rotation.y += (closeFocus ? 0.00002 : hasFocus ? 0.00008 : 0.00065) + playingSpin + energyRef.current * (closeFocus ? 0.00005 : hasFocus ? 0.00042 : 0.0016);
        activeGroup.rotation.x += closeFocus ? 0.00001 : playingRef.current ? 0.000025 : 0;
      }
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };

    runtimeRef.current = { updateInstances, resetCamera };
    resize();
    updateInstances();
    animate();
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("dblclick", onDoubleClick);
    host.addEventListener("pointerdown", scheduleTouchHover);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const onPointerLeave = () => setHover(null);
    host.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(progressiveTimer);
      window.clearTimeout(touchHoverTimer.id);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDoubleClick);
      host.removeEventListener("pointerdown", scheduleTouchHover);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      host.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", resize);
      runtimeRef.current = null;
      dustMaterial.dispose();
      trackMaterial.dispose();
      beamMaterial.dispose();
      mistMaterial.dispose();
      focusGeometry.dispose();
      focusMaterial.dispose();
      focusHaloMaterial.dispose();
      focusTexture.dispose();
      focusCoreMaterial.dispose();
      focusCoreTexture.dispose();
      pointTexture.dispose();
      mistTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className={`song-sphere ${playing ? "is-playing" : ""}`}>
      <div className="sphere-canvas" ref={mountRef} />
    </div>
  );
}

function App() {
  const isAdminRoute = normalizePath(window.location.pathname) === "/admin";
  const [accessGranted, setAccessGranted] = useState(() => localStorage.getItem("caelumshao.accessGranted.v1") === "true");
  const [accessMode, setAccessMode] = useState(() => localStorage.getItem("caelumshao.accessMode.v1") || "");
  const [activatedInvite, setActivatedInvite] = useState(() => localStorage.getItem("caelumshao.activatedInvite.v1") || "");
  const [accessMessage, setAccessMessage] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
  const [inviteCodes, setInviteCodes] = useState([]);
  const [inviteDraft, setInviteDraft] = useState("");
  const [batchInviteCount, setBatchInviteCount] = useState(10);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPasswordInput, setAdminPasswordInput] = useState("");
  const [adminPassword, setAdminPassword] = useState(() => readAdminPassword());
  const [deviceId] = useState(() => readDeviceId());
  const [accountToken, setAccountToken] = useState(() => localStorage.getItem(ACCOUNT_TOKEN_KEY) || "");
  const [cloudUser, setCloudUser] = useState(null);
  const [accountMode, setAccountMode] = useState("login");
  const [accountUsername, setAccountUsername] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountInvite, setAccountInvite] = useState("");
  const [neteaseState, setNeteaseState] = useState(null);
  const [qqMusicState, setQqMusicState] = useState(null);
  const currentAccountId = cloudUser?.id || "";
  const currentBetaKey = betaPreferenceKey(cloudUser?.id || "");
  const savedTracksKey = accountScopedKey("agentio.savedTracks", currentAccountId);
  const savedTrackItemsKey = accountScopedKey("agentio.savedTrackItems", currentAccountId);
  const recentTracksKey = accountScopedKey(RECENT_TRACKS_KEY, currentAccountId);
  const [libraryCacheMeta, setLibraryCacheMeta] = useState(() => readLibraryCache(currentAccountId));
  const [libraryTracks, setLibraryTracks] = useState(() => readLibraryCache(currentAccountId).items);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [hoveredTrack, setHoveredTrack] = useState(null);
  const [trackQueue, setTrackQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [playerSource, setPlayerSource] = useState("");
  const [playerTitle, setPlayerTitle] = useState(BRAND_CN);
  const [playerArtist, setPlayerArtist] = useState("click a golden song point");
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lyricSegments, setLyricSegments] = useState([]);
  const [lyricPosition, setLyricPosition] = useState(() => readLyricPosition());
  const [energy, setEnergy] = useState(0.08);
  const [message, setMessage] = useState("");
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [viewMode, setViewMode] = useState("歌手");
  const [sceneMode, setSceneMode] = useState("nebula");
  const [sortMode, setSortMode] = useState("热门");
  const [searchMode, setSearchMode] = useState("歌曲");
  const [query, setQuery] = useState("");
  const [globalSearchEnabled, setGlobalSearchEnabled] = useState(false);
  const [qualityMode, setQualityMode] = useState(() => defaultQualityMode());
  const [globalTracks, setGlobalTracks] = useState([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchStats, setGlobalSearchStats] = useState([]);
  const [uiHidden, setUiHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collectionPanelOpen, setCollectionPanelOpen] = useState(false);
  const [togetherPanelOpen, setTogetherPanelOpen] = useState(false);
  const [podcastEnabled, setPodcastEnabled] = useState(() => localStorage.getItem(PODCAST_ENABLED_KEY) === "true");
  const [betaEnabled, setBetaEnabled] = useState(false);
  const [singleLoop, setSingleLoop] = useState(false);
  const [isCompactControls, setIsCompactControls] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [earthSelection, setEarthSelection] = useState(null);
  const [togetherRoom, setTogetherRoom] = useState(null);
  const [togetherMessages, setTogetherMessages] = useState([]);
  const [togetherDraft, setTogetherDraft] = useState("");
  const [togetherRoomName, setTogetherRoomName] = useState("");
  const [togetherRoomCode, setTogetherRoomCode] = useState("");
  const earthSelectionKey = earthSelection ? trackKey(earthSelection) : "";
  const [savedKeys, setSavedKeys] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(accountScopedKey("agentio.savedTracks", "guest")) || "[]"));
    } catch (_error) {
      return new Set();
    }
  });
  const [savedTrackItems, setSavedTrackItems] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(accountScopedKey("agentio.savedTrackItems", "guest")) || "{}");
    } catch (_error) {
      return {};
    }
  });
  const betaInviteEnabled = accessGranted && accessMode === "invite";
  useEffect(() => {
    const stored = localStorage.getItem(currentBetaKey);
    const accountBeta = Boolean(cloudUser?.betaAccess);
    const next = accountBeta || stored === "true" || betaInviteEnabled;
    setBetaEnabled(next);
    if (!accountBeta && stored === "true" && !betaInviteEnabled) {
      localStorage.removeItem(currentBetaKey);
      setBetaEnabled(false);
    }
  }, [betaInviteEnabled, currentBetaKey, cloudUser?.betaAccess]);
  useEffect(() => {
    const storedInvite = localStorage.getItem("caelumshao.activatedInvite.v1") || "";
    if ((cloudUser?.betaAccess || betaInviteEnabled) && storedInvite && accessGranted && accessMode === "invite") return;
    void (async () => {
      const response = await fetch(`/api/invites/activation?deviceId=${encodeURIComponent(deviceId)}`);
      const data = await readJsonResponse(response);
      if (!response.ok || !data?.activation?.code) return;
      const code = String(data.activation.code || "").trim();
      if (!code) return;
      setAccessGranted(true);
      setAccessMode("invite");
      setActivatedInvite(code);
      setBetaEnabled(true);
      localStorage.setItem("caelumshao.accessGranted.v1", "true");
      localStorage.setItem("caelumshao.accessMode.v1", "invite");
      localStorage.setItem("caelumshao.activatedInvite.v1", code);
      localStorage.setItem(betaPreferenceKey(cloudUser?.id || "guest"), "true");
    })().catch(() => null);
  }, [accessGranted, accessMode, betaInviteEnabled, cloudUser?.betaAccess, deviceId]);
  const [recentTracks, setRecentTracks] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(accountScopedKey(RECENT_TRACKS_KEY, "guest")) || "[]");
    } catch (_error) {
      return [];
    }
  });
  useEffect(() => {
    const nextSavedKeys = new Set(JSON.parse(localStorage.getItem(savedTracksKey) || "[]"));
    const nextSavedItems = JSON.parse(localStorage.getItem(savedTrackItemsKey) || "{}");
    const nextRecentTracks = JSON.parse(localStorage.getItem(recentTracksKey) || "[]");
    setSavedKeys(nextSavedKeys);
    setSavedTrackItems(nextSavedItems);
    setRecentTracks(nextRecentTracks);
  }, [savedTrackItemsKey, savedTracksKey, recentTracksKey]);
  useEffect(() => {
    const cached = readLibraryCache(currentAccountId);
    setLibraryCacheMeta(cached);
    setLibraryTracks(cached.items);
    setSelectedTrack(null);
    setHoveredTrack(null);
  }, [currentAccountId]);
  const [toast, setToast] = useState("");
  const [captureOrb, setCaptureOrb] = useState(null);
  const [jumpTrack, setJumpTrack] = useState(null);
  const [jumping, setJumping] = useState(false);
  const [deepFocus, setDeepFocus] = useState(false);
  const [sphereResetToken, setSphereResetToken] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginProvider, setLoginProvider] = useState("netease");
  const [loginMode, setLoginMode] = useState("qr");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");
  const [bindingMusicAccount, setBindingMusicAccount] = useState(false);
  const [phone, setPhone] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [qqCookie, setQqCookie] = useState("");
  const [qqQrConfigIndex, setQqQrConfigIndex] = useState(0);

  const audioRef = useRef(null);
  const neteaseQrAutoStartedRef = useRef(false);
  const podcastAudioRef = useRef(null);
  const podcastEnabledRef = useRef(podcastEnabled);
  const queueRef = useRef([]);
  const queueIndexRef = useRef(-1);
  const currentTrackRef = useRef(null);
  const lyricSegmentsRef = useRef([]);
  const playTokenRef = useRef(0);
  const libraryLoadRef = useRef(0);
  const resolvedMusicCacheRef = useRef(readObjectCache(RESOLVED_MUSIC_CACHE_KEY));
  const lyricsCacheRef = useRef(readObjectCache(LYRICS_CACHE_KEY));
  const podcastCacheRef = useRef(readObjectCache(PODCAST_CACHE_KEY));
  const prefetchingRef = useRef(new Set());
  const togetherPlaybackVersionRef = useRef(0);
  const suppressTogetherPublishRef = useRef(false);
  const suppressPlaybackStateRef = useRef(false);
  const lastPlaybackPublishRef = useRef(0);
  const lyricDragRef = useRef(null);

  const isNeteaseLoggedIn = Boolean(neteaseState?.loggedIn && (neteaseState?.uid || neteaseState?.profile?.userId || neteaseState?.profile?.nickname || neteaseState?.cookies?.length));
  const isQqMusicLoggedIn = Boolean(qqMusicState?.loggedIn && (qqMusicState?.uin || qqMusicState?.profile?.nick || qqMusicState?.profile?.creator?.hostname || qqMusicState?.provider === "QQMusicApi1" || qqMusicState?.cookies?.length));
  const isLoggedIn = isNeteaseLoggedIn || isQqMusicLoggedIn;
  const accountLabel = isNeteaseLoggedIn && isQqMusicLoggedIn
    ? "已登录"
    : isNeteaseLoggedIn
      ? (neteaseState?.profile?.nickname || "网易云已登录")
      : isQqMusicLoggedIn
        ? (qqMusicState?.profile?.creator?.hostname || qqMusicState?.profile?.nick || qqMusicState?.uin || "QQ 音乐已登录")
        : "账户登录";
  const showPlayer = Boolean(playerSource || trackQueue.length);
  const starTracks = useMemo(() => {
    const source = viewMode === "拾遗" ? Object.values(savedTrackItems) : globalSearchEnabled ? globalTracks : libraryTracks;
    return withArtistCenters(source, globalSearchEnabled && searchMode === "歌手" && viewMode !== "拾遗");
  }, [globalSearchEnabled, globalTracks, libraryTracks, savedTrackItems, searchMode, viewMode]);
  const filteredTracks = useMemo(() => {
    const base = starTracks.filter((track) => {
      if (viewMode === "拾遗") return !track.artistCenter && savedKeys.has(trackKey(track));
      if (viewMode === "封面" && !track.cover) return false;
      if (viewMode === "年代" && !trackYearValue(track)) return false;
      if (viewMode === "歌单" && !track.playlistName && !track.playlistId) return false;
      if (viewMode === "歌手" && !track.artistCenter) return false;
      return true;
    });
    return sortVisibleTracks(base, sortMode);
  }, [savedKeys, sortMode, starTracks, viewMode]);
  const sphereTracks = globalSearchEnabled ? starTracks : filteredTracks;
  const searchResults = useMemo(() => {
    const q = normalizeText(query);
    const source = filteredTracks.length ? filteredTracks : starTracks;
    if (!q) return source.slice(0, searchMode === "年代" ? 12 : 8);
    return source.filter((track) => {
      if (searchMode === "年代") return String(trackYearValue(track) || "").includes(q) || trackSearchText(track).includes(q);
      if (searchMode === "歌曲") return normalizeText(track?.title || "").includes(q);
      if (searchMode === "歌单") return normalizeText(`${track?.playlistName || ""} ${track?.playlistId || ""} ${track?.album || ""} ${track?.playlistDescription || ""} ${track?.raw?.playlistName || ""} ${track?.raw?.dissname || ""}`).includes(q);
      if (searchMode === "歌手") return normalizeText(track?.artistCenter ? track.title : primaryArtist(track)).includes(q);
      return trackSearchText(track).includes(q);
    }).slice(0, 18);
  }, [filteredTracks, query, searchMode, starTracks]);
  const infoTrack = hoveredTrack || selectedTrack;
  const progress = audioDuration ? Math.min(100, (audioTime / audioDuration) * 100) : 0;
  const displayTrack = panelOpen ? infoTrack || selectedTrack || filteredTracks[0] || libraryTracks[0] || null : null;
  const playlistCount = new Set(libraryTracks.map((track) => track.playlistId).filter(Boolean)).size;
  const titleLines = splitTitle(displayTrack?.title || BRAND_CN);
  const isDesktopApp = Boolean(window.caelumShaoDesktop?.isDesktop);
  const savedTrackList = useMemo(() => Object.values(savedTrackItems || {}).filter(Boolean), [savedTrackItems]);
  const recentTrackList = useMemo(() => (Array.isArray(recentTracks) ? recentTracks : []).filter(Boolean), [recentTracks]);
  const earthSceneTracks = useMemo(() => withEarthRegions(globalSearchEnabled ? globalTracks : libraryTracks), [globalSearchEnabled, globalTracks, libraryTracks]);
  const lyricDisplay = useMemo(() => {
    if (!lyricSegments.length) return null;
    let activeIndex = 0;
    for (let index = 0; index < lyricSegments.length; index += 1) {
      const segment = lyricSegments[index];
      const start = Number(segment.start || 0);
      const end = Number(segment.end || lyricSegments[index + 1]?.start || start + 4);
      if (audioTime >= start && audioTime < end) {
        activeIndex = index;
        break;
      }
      if (start <= audioTime) activeIndex = index;
    }
    const current = lyricSegments[activeIndex] || lyricSegments[0] || null;
    if (!current) return null;
    const start = Number(current.start || 0);
    const fallbackEnd = Number(lyricSegments[activeIndex + 1]?.start || start + 4);
    const end = Math.max(start + 0.8, Number(current.end || fallbackEnd || start + 4));
    const ratio = Math.max(0, Math.min(1, (audioTime - start) / Math.max(0.8, end - start)));
    return {
      activeIndex,
      progress: ratio,
      lines: [
        { segment: lyricSegments[activeIndex - 1] || null, role: "past" },
        { segment: current, role: "current" },
        { segment: lyricSegments[activeIndex + 1] || null, role: "future" }
      ].filter((item) => item.segment?.text)
    };
  }, [audioTime, lyricSegments]);

  useEffect(() => {
    if (!window.caelumShaoDesktop?.isDesktop) return;
    if (!lyricDisplay?.lines?.length) {
      window.caelumShaoDesktop.hideFloatingLyric?.();
      return;
    }
    window.caelumShaoDesktop.updateFloatingLyric?.({
      progress: lyricDisplay.progress || 0,
      lines: lyricDisplay.lines.map(({ segment, role }) => ({
        role,
        text: segment?.text || ""
      }))
    });
  }, [lyricDisplay]);

  useEffect(() => {
    if (sceneMode !== "earth") return;
    if (earthSelection && !earthSceneTracks.some((track) => trackKey(track) === trackKey(earthSelection))) {
      setEarthSelection(null);
    }
    if (!earthSelection && earthSceneTracks.length) {
      const firstRegion = earthSceneTracks.find((track) => track.regionCenter);
      if (firstRegion) setEarthSelection(firstRegion);
    }
  }, [earthSceneTracks, earthSelection, sceneMode]);

  const adminPage = (
    <section className="admin-panel" role="dialog" aria-modal="true" aria-label="管理员页面">
      <div className="admin-card">
        <button className="panel-close" aria-label="关闭管理员页面" type="button" onClick={() => window.history.replaceState(null, "", window.location.origin + window.location.pathname.replace(/\/admin\/?$/, ""))}>×</button>
        <div className="settings-title">管理员页面</div>
        {!adminUnlocked ? (
          <form className="admin-password-form" onSubmit={submitAdminPassword}>
            <label>
              <span>管理员密码</span>
              <input
                value={adminPasswordInput}
                onChange={(event) => setAdminPasswordInput(event.target.value)}
                placeholder="初始密码：admin123456"
                type="password"
              />
            </label>
            <div className="admin-row">
              <button type="submit">验证密码</button>
              <button type="button" onClick={() => window.history.replaceState(null, "", normalizePath(window.location.pathname).replace(/\/admin$/, ""))}>返回</button>
            </div>
          </form>
        ) : (
          <>
            <form className="admin-form" onSubmit={(event) => {
              event.preventDefault();
              const nextInvite = inviteDraft.trim();
              if (!nextInvite) {
                setAccessMessage("邀请码不能为空");
                return;
              }
              void (async () => {
                const nextCodes = [...new Set([nextInvite, ...inviteCodes])];
                const response = await fetch("/api/invites", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ codes: nextCodes })
                });
                const data = await readJsonResponse(response);
                if (!response.ok) throw new Error(data.error || "邀请码保存失败");
                setInviteCodes(Array.isArray(data.codes) ? data.codes.map((code) => String(code || "").trim()).filter(Boolean) : nextCodes);
                setInviteDraft("");
                setAccessMessage("邀请码已保存");
              })().catch((error) => setAccessMessage(error.message || "邀请码保存失败"));
            }}>
              <label>
                <span>单个邀请码</span>
                <input value={inviteDraft} onChange={(event) => setInviteDraft(event.target.value)} placeholder="输入新的邀请码" />
              </label>
              <div className="admin-row">
                <button type="submit">追加到池中</button>
                <button type="button" onClick={() => {
                  if (!inviteCodes.length) return;
                  navigator.clipboard?.writeText(inviteCodes.join("\n")).catch(() => null);
                  setAccessMessage("已复制全部邀请码");
                }}>复制全部</button>
              </div>
            </form>
            <form className="admin-form" onSubmit={(event) => {
              event.preventDefault();
              const count = Math.max(1, Math.min(200, Number(batchInviteCount) || 0));
              const generated = Array.from({ length: count }, () => `YS-${Math.random().toString(36).slice(2, 10).toUpperCase()}`);
              void (async () => {
                const nextCodes = [...new Set([...generated, ...inviteCodes])];
                const response = await fetch("/api/invites", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ codes: nextCodes })
                });
                const data = await readJsonResponse(response);
                if (!response.ok) throw new Error(data.error || "邀请码批量保存失败");
                setInviteCodes(Array.isArray(data.codes) ? data.codes.map((code) => String(code || "").trim()).filter(Boolean) : nextCodes);
                setInviteDraft("");
                setAccessMessage(`已批量生成 ${generated.length} 个邀请码`);
              })().catch((error) => setAccessMessage(error.message || "邀请码批量保存失败"));
            }}>
              <label>
                <span>批量生成</span>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={batchInviteCount}
                  onChange={(event) => setBatchInviteCount(event.target.value)}
                  placeholder="1 - 200"
                />
              </label>
              <div className="admin-row">
                <button type="submit">一键生成</button>
                <button type="button" onClick={() => {
                  const generated = Array.from({ length: 20 }, () => `YS-${Math.random().toString(36).slice(2, 10).toUpperCase()}`);
                  void (async () => {
                    const nextCodes = [...new Set([...generated, ...inviteCodes])];
                    const response = await fetch("/api/invites", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ codes: nextCodes })
                    });
                    const data = await readJsonResponse(response);
                    if (!response.ok) throw new Error(data.error || "邀请码保存失败");
                    setInviteCodes(Array.isArray(data.codes) ? data.codes.map((code) => String(code || "").trim()).filter(Boolean) : nextCodes);
                    setAccessMessage("已快速生成 20 个邀请码");
                  })().catch((error) => setAccessMessage(error.message || "邀请码保存失败"));
                }}>生成 20 个</button>
              </div>
            </form>
            <div className="invite-list">
              <div className="invite-list-title">当前邀请码</div>
              <div className="invite-list-body">
                {inviteCodes.length ? inviteCodes.map((code) => (
                  <button
                    key={code}
                    className="invite-pill"
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(code).catch(() => null);
                      setAccessMessage(`已复制 ${code}`);
                    }}
                  >
                    {code}
                  </button>
                )) : <span className="invite-list-empty">还没有邀请码，先批量生成一批吧</span>}
              </div>
            </div>
            <form className="admin-password-form" onSubmit={(event) => {
              event.preventDefault();
              const nextPassword = adminPasswordInput.trim();
              if (!nextPassword) {
                setAccessMessage("请输入新密码");
                return;
              }
              setAdminPassword(nextPassword);
              setAdminPasswordInput("");
              setAccessMessage("管理员密码已更新");
            }}>
              <label>
                <span>修改管理员密码</span>
                <input
                  value={adminPasswordInput}
                  onChange={(event) => setAdminPasswordInput(event.target.value)}
                  placeholder="输入新密码"
                  type="password"
                />
              </label>
              <div className="admin-row">
                <button type="submit">更新密码</button>
                <button type="button" onClick={() => setAdminUnlocked(false)}>退出编辑</button>
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );

  useEffect(() => {
    localStorage.setItem(ADMIN_PASSWORD_KEY, adminPassword);
  }, [adminPassword]);

  useEffect(() => {
    if (!isAdminRoute || adminUnlocked) return;
    void refreshInviteCodes().catch(() => setInviteCodes([]));
  }, [adminUnlocked, isAdminRoute]);

  useEffect(() => {
    lyricSegmentsRef.current = lyricSegments;
  }, [lyricSegments]);

  if (isAdminRoute) {
    return (
      <main className="app cloud-stage">
        {adminPage}
      </main>
    );
  }

  useEffect(() => {
    const widthQuery = window.matchMedia("(max-width: 1180px)");
    const pointerQuery = window.matchMedia("(pointer: coarse)");
    const updateCompactControls = () => setIsCompactControls(widthQuery.matches || pointerQuery.matches);
    updateCompactControls();
    widthQuery.addEventListener?.("change", updateCompactControls);
    pointerQuery.addEventListener?.("change", updateCompactControls);
    return () => {
      widthQuery.removeEventListener?.("change", updateCompactControls);
      pointerQuery.removeEventListener?.("change", updateCompactControls);
    };
  }, []);

  function playbackSourceTracks() {
    const source = viewMode === "拾遗"
      ? Object.values(savedTrackItems)
      : globalSearchEnabled
        ? globalTracks
        : libraryTracks;
    return source.filter((item) => item && !item.artistCenter && !item.placeholder);
  }

  function accountHeaders(token = accountToken) {
    return token ? { Authorization: `Bearer ${token}`, "X-Caelum-Token": token } : {};
  }

  function persistDesktopAccountToken(token) {
    if (!token) return;
    window.caelumShaoDesktop?.setAccountToken?.(token).catch(() => null);
  }

  function clearDesktopAccountToken() {
    window.caelumShaoDesktop?.clearAccountToken?.().catch(() => null);
  }

  function clearCloudSession(messageText = "云韶账号登录已失效，请重新登录") {
    localStorage.removeItem(ACCOUNT_TOKEN_KEY);
    clearDesktopAccountToken();
    setAccountToken("");
    setCloudUser(null);
    setAccessGranted(false);
    setAccessMode("");
    setActivatedInvite("");
    setBetaEnabled(false);
    setTogetherRoom(null);
    setTogetherMessages([]);
    setTogetherPanelOpen(false);
    setAccessMessage(messageText);
    flash(messageText);
  }

  async function refreshInviteCodes() {
    const response = await fetch("/api/invites");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "邀请码读取失败");
    const codes = Array.isArray(data.codes) ? data.codes.map((code) => String(code || "").trim()).filter(Boolean) : [];
    setInviteCodes(codes);
    return codes;
  }

  function submitInviteCode(event) {
    event?.preventDefault?.();
    const trimmed = inviteInput.trim();
    if (!trimmed) {
      setAccessMessage("请输入邀请码");
      return;
    }
    void (async () => {
      const response = await fetch("/api/invites/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed, deviceId })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "邀请码不正确或已使用");
      if (data.user) setCloudUser(data.user);
      setAccessGranted(true);
      setAccessMode("invite");
      setActivatedInvite(trimmed);
      setBetaEnabled(true);
      localStorage.setItem("caelumshao.accessGranted.v1", "true");
      localStorage.setItem("caelumshao.accessMode.v1", "invite");
      localStorage.setItem("caelumshao.activatedInvite.v1", trimmed);
      localStorage.setItem(betaPreferenceKey("guest"), "true");
      if (data.user?.id) localStorage.setItem(betaPreferenceKey(data.user.id), "true");
      if (!data.user?.id) localStorage.setItem("caelumshao.betaDeviceInvite.v1", trimmed);
      setAccessMessage("内测权限已开启");
      setInviteInput("");
    })().catch((error) => setAccessMessage(error.message || "邀请码不正确或已使用"));
  }

  function applyAccountPayload(data = {}) {
    if (data.token) {
      localStorage.setItem(ACCOUNT_TOKEN_KEY, data.token);
      persistDesktopAccountToken(data.token);
      setAccountToken(data.token);
    }
    if (data.user) {
      setCloudUser(data.user);
      setAccessGranted(true);
      setAccessMode("account");
      const nextBeta = Boolean(data.user.betaAccess);
      setBetaEnabled(nextBeta);
      if (data.user.id && currentAccountId && data.user.id !== currentAccountId) {
        setSavedKeys(new Set());
        setSavedTrackItems({});
        setRecentTracks([]);
      }
      if (data.user.id) {
        const key = betaPreferenceKey(data.user.id);
        if (nextBeta) localStorage.setItem(key, "true");
        else localStorage.removeItem(key);
      }
    }
    if (Array.isArray(data.savedTracks)) {
      const nextItems = Object.fromEntries(data.savedTracks.map((track) => [track.key || trackKey(track), track]));
      setSavedTrackItems(nextItems);
      setSavedKeys(new Set(Object.keys(nextItems)));
      localStorage.setItem(savedTrackItemsKey, JSON.stringify(nextItems));
      localStorage.setItem(savedTracksKey, JSON.stringify(Object.keys(nextItems)));
    }
    if (Array.isArray(data.history)) {
      setRecentTracks(data.history);
      localStorage.setItem(recentTracksKey, JSON.stringify(data.history.slice(0, 500)));
    }
    if (Array.isArray(data.syncedTracks)) {
      const tracks = annotateEarthTracks(data.syncedTracks);
      setLibraryTracks(tracks);
      setLibraryCacheMeta({
        updatedAt: data.user?.lastSyncedAt || new Date().toISOString(),
        items: tracks
      });
      if (tracks.length) setMessage(`已从云韶账号载入 ${tracks.length} 首歌`);
    }
  }

  async function submitCloudAccount(event) {
    event?.preventDefault?.();
    if (accountBusy) return;
    const endpoint = accountMode === "register" ? "/api/account/register" : "/api/account/login";
    setAccountBusy(true);
    setAccessMessage(accountMode === "register" ? "正在注册云韶账号..." : "正在登录云韶账号...");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: accountUsername,
          password: accountPassword,
          inviteCode: accountMode === "register" ? accountInvite : "",
          deviceId
        })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "云韶账号请求失败");
      applyAccountPayload(data);
      setAccountPassword("");
      setAccountInvite("");
      setAccessMessage("");
      setAccessGranted(false);
      setAccessMode("");
      setAccessMessage(accountMode === "register" ? "云韶账号已注册并激活" : "云韶账号已登录");
    } catch (error) {
      setAccessMessage(error.message || "云韶账号请求失败");
    } finally {
      setAccountBusy(false);
    }
  }

  async function refreshCloudAccount(tokenOverride = accountToken) {
    const token = tokenOverride || "";
    if (!token) return;
    try {
      const response = await fetch("/api/account/me", { headers: accountHeaders(token) });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "云韶账号已失效");
      if (token && token !== accountToken) {
        localStorage.setItem(ACCOUNT_TOKEN_KEY, token);
        persistDesktopAccountToken(token);
        setAccountToken(token);
      }
      applyAccountPayload(data);
    } catch (_error) {
      clearCloudSession("云韶账号登录已失效，请重新登录");
    }
  }

  async function bindCurrentMusicAccounts() {
    if (!accountToken) {
      flash("请先登录云韶账号");
      return;
    }
    setBindingMusicAccount(true);
    setSettingsOpen(false);
    void openLoginPanel("qr");
  }

  async function finishMusicAccountBinding() {
    if (!accountToken || !bindingMusicAccount) return;
    try {
      const response = await fetch("/api/account/bind-current", { method: "POST", headers: accountHeaders() });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "绑定失败");
      setCloudUser(data.user || null);
      setBindingMusicAccount(false);
      flash("音乐账号已绑定到云韶账号");
    } catch (error) {
      flash(error.message || "绑定失败");
    }
  }

  async function syncCloudLibrary() {
    if (!accountToken) {
      flash("请先登录云韶账号");
      return;
    }
    try {
      setIsLibraryLoading(true);
      const response = await fetch("/api/account/sync-library", { method: "POST", headers: accountHeaders() });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "同步失败");
      setCloudUser(data.user || cloudUser);
      if (Array.isArray(data.items) && data.items.length) {
        const tracks = annotateEarthTracks(data.items);
        setLibraryTracks(tracks);
        setLibraryCacheMeta({
          updatedAt: data.user?.lastSyncedAt || new Date().toISOString(),
          items: tracks
        });
      }
      flash(`云韶账号已同步 ${data.items?.length || 0} 首`);
    } catch (error) {
      flash(error.message || "同步失败");
    } finally {
      setIsLibraryLoading(false);
    }
  }

  async function saveLibraryToAccount(items = []) {
    if (!accountToken || !items.length) return null;
    try {
      const response = await fetch("/api/account/sync-library", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ items: items.map(compactLibraryTrack) })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "云韶账号曲库保存失败");
      if (data.user) setCloudUser(data.user);
      return data;
    } catch (error) {
      console.warn("save library to account failed:", error?.message || error);
      return null;
    }
  }

  async function refreshTogetherRoom() {
    if (!accountToken) return;
    try {
      const response = await fetch("/api/account/together", { headers: accountHeaders() });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "一起听状态读取失败");
      setTogetherRoom(data.room || null);
      setTogetherMessages(Array.isArray(data.messages) ? data.messages : []);
      const version = Number(data.playbackVersion || 0);
      const remoteTrack = data.nowPlaying?.track || null;
      const remoteUserId = data.nowPlaying?.userId || "";
      if (remoteTrack && version && version > togetherPlaybackVersionRef.current && remoteUserId !== cloudUser?.id) {
        togetherPlaybackVersionRef.current = version;
        const remoteUpdatedAt = Date.parse(data.nowPlaying?.updatedAt || data.nowPlaying?.startedAt || "");
        const drift = data.nowPlaying?.playing && Number.isFinite(remoteUpdatedAt) ? Math.max(0, (Date.now() - remoteUpdatedAt) / 1000) : 0;
        const remoteTime = Math.max(0, Number(data.nowPlaying?.currentTime || 0) + drift);
        const sameTrack = currentTrackRef.current && trackKey(currentTrackRef.current) === trackKey(remoteTrack);
        if (!sameTrack) await playTrackFromUi(remoteTrack, { focus: false, fromTogether: true });
        window.setTimeout(() => {
          const audio = audioRef.current;
          if (!audio) return;
          suppressPlaybackStateRef.current = true;
          if (Number.isFinite(remoteTime) && Math.abs((audio.currentTime || 0) - remoteTime) > 0.45) audio.currentTime = remoteTime;
          if (data.nowPlaying?.playing) audio.play().catch(() => null);
          else audio.pause();
          window.setTimeout(() => {
            suppressPlaybackStateRef.current = false;
          }, 360);
        }, sameTrack ? 0 : 180);
        window.setTimeout(() => {
          suppressTogetherPublishRef.current = false;
        }, 1800);
      } else if (version > togetherPlaybackVersionRef.current) {
        togetherPlaybackVersionRef.current = version;
      }
    } catch (error) {
      flash(error.message || "一起听状态读取失败");
    }
  }

  async function publishTogetherPlaybackState({ playing = isPlaying, currentTime = audioRef.current?.currentTime || 0, force = false } = {}) {
    if (!accountToken || !togetherRoom || suppressTogetherPublishRef.current || suppressPlaybackStateRef.current || !currentTrackRef.current) return;
    const now = Date.now();
    if (!force && now - lastPlaybackPublishRef.current < 420) return;
    lastPlaybackPublishRef.current = now;
    try {
      const response = await fetch("/api/account/together/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ playing, currentTime })
      });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "一起听进度同步失败");
      togetherPlaybackVersionRef.current = Number(data.playbackVersion || togetherPlaybackVersionRef.current);
    } catch (error) {
      console.warn("publish together playback failed:", error?.message || error);
    }
  }

  async function createTogetherRoom() {
    if (!accountToken) return;
    try {
      const response = await fetch("/api/account/together/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ name: togetherRoomName || `${cloudUser?.username || "云韶"} 的一起听` })
      });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "创建一起听失败");
      setTogetherRoom(data.room || null);
      flash("一起听房间已创建");
      await refreshTogetherRoom();
    } catch (error) {
      flash(error.message || "创建一起听失败");
    }
  }

  async function joinTogetherRoom() {
    if (!accountToken) return;
    if (!togetherRoomCode.trim()) {
      flash("请输入房间号");
      return;
    }
    try {
      const response = await fetch("/api/account/together/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ roomId: togetherRoomCode.trim() })
      });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "加入一起听失败");
      setTogetherRoom(data.room || null);
      flash("已加入一起听");
      await refreshTogetherRoom();
    } catch (error) {
      flash(error.message || "加入一起听失败");
    }
  }

  async function sendTogetherMessage(event) {
    event?.preventDefault?.();
    if (!accountToken) return;
    const content = togetherDraft.trim();
    if (!content) return;
    try {
      const response = await fetch("/api/account/together/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ content })
      });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "发送消息失败");
      setTogetherMessages(Array.isArray(data.messages) ? data.messages : []);
      setTogetherDraft("");
    } catch (error) {
      flash(error.message || "发送消息失败");
    }
  }

  async function leaveTogetherRoom() {
    if (!accountToken) return;
    try {
      const response = await fetch("/api/account/together/leave", { method: "POST", headers: accountHeaders() });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "退出房间失败");
      setTogetherRoom(null);
      setTogetherMessages([]);
      togetherPlaybackVersionRef.current = 0;
      flash(data.dissolved ? "房间已解散" : "已退出房间");
    } catch (error) {
      flash(error.message || "退出房间失败");
    }
  }

  async function copyTogetherRoomId() {
    const roomId = togetherRoom?.id || "";
    if (!roomId) return;
    try {
      await navigator.clipboard?.writeText(roomId);
      flash("房间邀请码已复制");
    } catch (_error) {
      flash(`房间邀请码：${roomId}`);
    }
  }

  function startLyricDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const start = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      position: lyricPosition
    };
    lyricDragRef.current = start;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveLyricDrag(event) {
    const drag = lyricDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = {
      x: Math.max(8, Math.min(92, drag.position.x + ((event.clientX - drag.x) / Math.max(1, window.innerWidth)) * 100)),
      y: Math.max(8, Math.min(86, drag.position.y + ((event.clientY - drag.y) / Math.max(1, window.innerHeight)) * 100))
    };
    setLyricPosition(next);
  }

  function endLyricDrag(event) {
    const drag = lyricDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    lyricDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setLyricPosition((position) => {
      localStorage.setItem(LYRIC_POSITION_KEY, JSON.stringify(position));
      return position;
    });
  }

  async function publishTogetherTrack(track) {
    if (!accountToken || !togetherRoom || suppressTogetherPublishRef.current || !track) return;
    try {
      const response = await fetch("/api/account/together/track", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({ track })
      });
      const data = await readJsonResponse(response);
      if (response.status === 401) {
        clearCloudSession(data.error || "请先重新登录云韶账号");
        return;
      }
      if (!response.ok) throw new Error(data.error || "一起听同步失败");
      setTogetherRoom(data.room || togetherRoom);
      togetherPlaybackVersionRef.current = Number(data.playbackVersion || togetherPlaybackVersionRef.current);
      window.setTimeout(() => void refreshTogetherRoom(), 180);
    } catch (error) {
      console.warn("publish together track failed:", error?.message || error);
    }
  }

  function syncPlayHistory(track) {
    if (!track) return;
    const key = trackKey(track);
    const item = {
      ...track,
      key,
      playedAt: new Date().toISOString()
    };
    setRecentTracks((current) => {
      const next = [item, ...current.filter((entry) => (entry.key || trackKey(entry)) !== key)].slice(0, 500);
      localStorage.setItem(recentTracksKey, JSON.stringify(next));
      return next;
    });
    if (!accountToken) return;
    fetch("/api/account/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accountHeaders() },
      body: JSON.stringify({ track })
    }).catch(() => null);
  }

  function syncSavedTracks(nextItems) {
    if (!accountToken) return;
    localStorage.setItem(savedTrackItemsKey, JSON.stringify(nextItems || {}));
    localStorage.setItem(savedTracksKey, JSON.stringify(Object.keys(nextItems || {})));
    fetch("/api/account/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accountHeaders() },
      body: JSON.stringify({ savedTracks: Object.values(nextItems || {}) })
    }).catch(() => null);
  }

  function logoutCloudAccount() {
    fetch("/api/account/logout", { method: "POST", headers: accountHeaders() }).catch(() => null);
    if (cloudUser?.id) localStorage.removeItem(betaPreferenceKey(cloudUser.id));
    if (currentAccountId) {
      localStorage.removeItem(savedTracksKey);
      localStorage.removeItem(savedTrackItemsKey);
      localStorage.removeItem(recentTracksKey);
    }
    localStorage.removeItem(ACCOUNT_TOKEN_KEY);
    clearDesktopAccountToken();
    setAccountToken("");
    setCloudUser(null);
    setAccessGranted(false);
    setAccessMode("");
    setBetaEnabled(false);
    setSettingsOpen(false);
    flash("已退出云韶账号，请重新注册并登录");
  }

  function submitAdminPassword(event) {
    event?.preventDefault?.();
    if (adminPasswordInput !== adminPassword) {
      setAccessMessage("管理员密码错误");
      return;
    }
    setAdminUnlocked(true);
    setAccessMessage("");
  }

  function buildPlaybackQueue(track) {
    if (!track) return [];
    const source = playbackSourceTracks();
    if (!source.length) return [track];
    const currentKey = trackKey(track);
    const index = source.findIndex((item) => trackKey(item) === currentKey);
    const ordered = index >= 0 ? [...source.slice(index), ...source.slice(0, index)] : [track, ...source];
    const seen = new Set();
    return ordered.filter((item) => {
      const key = trackKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function loadLyricsForTrack(track, token) {
    if (!track?.id) return;
    const key = cacheKeyForTrack(track, "lyrics:");
    const cached = lyricsCacheRef.current[key];
    if (cached?.segments && token === playTokenRef.current) {
      const cachedSegments = Array.isArray(cached.segments) ? cached.segments : [];
      lyricSegmentsRef.current = cachedSegments;
      setLyricSegments(cachedSegments);
      return;
    }
    try {
      const response = await fetch("/api/lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: track.id,
          platform: track.platform || track.sourcePlatform || "netease",
          mediaId: track.mediaId || track.media_mid || track.raw?.strMediaMid || track.raw?.media_mid || "",
          songId: track.songId || track.songid || track.raw?.songid || "",
          raw: track.raw || null
        })
      });
      const data = await readJsonResponse(response);
      if (token !== playTokenRef.current) return;
      const segments = Array.isArray(data.segments) ? data.segments : [];
      lyricSegmentsRef.current = segments;
      setLyricSegments(segments);
      lyricsCacheRef.current = {
        ...lyricsCacheRef.current,
        [key]: { segments, savedAt: Date.now() }
      };
      writeObjectCache(LYRICS_CACHE_KEY, lyricsCacheRef.current, 260);
    } catch (error) {
      if (token === playTokenRef.current) {
        lyricSegmentsRef.current = [];
        setLyricSegments([]);
      }
      console.debug("lyrics unavailable", error?.message || error);
    }
  }

  async function refreshNeteaseState() {
    const response = await fetch("/api/netease/state");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "网易云状态读取失败");
    setNeteaseState(data);
    return data;
  }

  async function refreshQqMusicState() {
    const response = await fetch("/api/qqmusic/state");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "QQ 音乐状态读取失败");
    setQqMusicState(data);
    return data;
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshNeteaseState().catch(() => null);
      refreshQqMusicState().catch(() => null);
    }, 12000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadNeteaseLibrary() {
    const response = await fetch("/api/netease/library/tracks");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "网易云曲库暂时没有载入");
    return { items: data.items || [], warning: data.warning || "" };
  }

  async function loadQqMusicLibrary() {
    const response = await fetch("/api/qqmusic/library/tracks");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "QQ 音乐曲库暂时没有载入");
    return { items: data.items || [], warning: data.warning || "" };
  }

  async function loadAllLibraries({ background = false } = {}) {
    const token = libraryLoadRef.current + 1;
    libraryLoadRef.current = token;
    setIsLibraryLoading(true);
    const [neteaseResult, qqResult] = await Promise.all([
      loadNeteaseLibrary().catch((error) => ({ items: [], warning: error.message || "网易云曲库暂时没有载入" })),
      loadQqMusicLibrary().catch((error) => ({ items: [], warning: error.message || "QQ 音乐曲库暂时没有载入" }))
    ]);
    if (token !== libraryLoadRef.current) return [];
    const merged = annotateEarthTracks([...neteaseResult.items, ...qqResult.items]);
    const warnings = [neteaseResult.warning, qqResult.warning].filter(Boolean);
    if (merged.length) {
      const oldFingerprint = libraryFingerprint(libraryTracks);
      const nextFingerprint = libraryFingerprint(merged);
      if (oldFingerprint !== nextFingerprint) {
        setLibraryTracks(merged);
        const saved = await saveLibraryToAccount(merged);
        setLibraryCacheMeta({
          updatedAt: saved?.user?.lastSyncedAt || new Date().toISOString(),
          items: merged
        });
      }
      setMessage(background ? "" : `曲库已同步 ${merged.length} 首`);
    } else if (!libraryTracks.length) {
      if (cloudUser?.lastSyncedAt) {
        await refreshCloudAccount();
        setMessage("正在使用云韶账号保存的曲库，音乐账号登录可能已过期");
      } else {
        const cached = readLibraryCache(currentAccountId);
        if (cached.items.length) {
          setLibraryTracks(annotateEarthTracks(cached.items));
          setLibraryCacheMeta(cached);
          setMessage("正在使用旧版本地曲库缓存，登录可能已过期");
        } else {
          setMessage(warnings[0] || "还没有载入曲库，请先登录网易云或 QQ 音乐");
        }
      }
    } else if (warnings.length) {
      setMessage("正在使用缓存曲库，登录可能已过期");
    }
    setIsLibraryLoading(false);
    return merged.length ? merged : libraryTracks;
  }

  useEffect(() => {
    refreshNeteaseState().catch(() => setNeteaseState({ loggedIn: false }));
    refreshQqMusicState().catch(() => setQqMusicState({ loggedIn: false }));
    let cancelled = false;
    void (async () => {
      const desktopToken = !accountToken
        ? await window.caelumShaoDesktop?.getAccountToken?.().catch(() => "")
        : "";
      if (cancelled) return;
      await refreshCloudAccount(desktopToken || accountToken);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isAdminRoute || !adminUnlocked) return undefined;
    void refreshInviteCodes().catch(() => setInviteCodes([]));
    const timer = window.setInterval(() => {
      void refreshInviteCodes().catch(() => null);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [adminUnlocked, isAdminRoute]);

  useEffect(() => {
    if (!accountToken) return undefined;
    void refreshTogetherRoom();
    const timer = window.setInterval(() => {
      void refreshTogetherRoom();
    }, togetherPanelOpen ? 1200 : 2000);
    return () => window.clearInterval(timer);
  }, [accountToken, togetherPanelOpen]);

  useEffect(() => {
    const hash = window.location.hash || "";
    const marker = "#qqmusic_cookie=";
    if (!hash.startsWith(marker)) return;
    const cookieValue = decodeURIComponent(hash.slice(marker.length));
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setLoginOpen(true);
    setLoginProvider("qq");
    setLoginMode("qq-cookie");
    setLoginMessage("已收到 QQ 音乐网页 Cookie，正在自动登录");
    void loginWithQqCookieValue(cookieValue);
  }, []);

  useEffect(() => {
    if (!loginOpen || loginProvider !== "netease" || loginMode !== "qr") return undefined;
    if (neteaseQrAutoStartedRef.current) return undefined;
    if (loginBusy || neteaseState?.qrKey || neteaseState?.qrImg) return undefined;
    const timer = window.setTimeout(() => {
      neteaseQrAutoStartedRef.current = true;
      void startNeteaseQrLogin();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loginBusy, loginMode, loginOpen, loginProvider, neteaseState?.qrImg, neteaseState?.qrKey]);

  useEffect(() => {
    if (loginOpen && loginProvider === "netease" && loginMode === "qr") return;
    neteaseQrAutoStartedRef.current = false;
  }, [loginMode, loginOpen, loginProvider]);

  useEffect(() => {
    const cached = readLibraryCache(currentAccountId);
    if (cached.items.length && !libraryTracks.length) {
      setLibraryTracks(cached.items);
      setLibraryCacheMeta(cached);
      setMessage(`已载入缓存曲库 ${cached.items.length} 首，正在后台同步`);
    }
    loadAllLibraries({ background: Boolean(cached.items.length || libraryTracks.length) }).catch((error) => {
      setIsLibraryLoading(false);
      if (!libraryTracks.length && cached.items.length) {
        setLibraryTracks(annotateEarthTracks(cached.items));
        setLibraryCacheMeta(cached);
      }
      setMessage(error?.message || "正在使用缓存曲库");
    });
  }, [isNeteaseLoggedIn, isQqMusicLoggedIn]);

  useEffect(() => {
    if (!loginOpen || loginProvider !== "netease" || loginMode !== "qr" || !neteaseState?.qrKey) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/netease/login/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: neteaseState.qrKey })
        });
        const data = await readJsonResponse(response);
        if (!response.ok) throw new Error(data.error || "二维码状态检查失败");
        if (data.loggedIn || data.code === 803 || data.code === 200) {
          setLoginMessage(bindingMusicAccount ? "登录成功，正在绑定到云韶账号" : "登录成功，正在同步歌单");
          setLoginOpen(false);
          setNeteaseState(data);
          await loadAllLibraries().catch(() => null);
          await finishMusicAccountBinding();
        } else if (data.qrStatus || data.payload?.message) {
          setLoginMessage(data.qrStatus || data.payload?.message);
        }
      } catch (error) {
        setLoginMessage(error.message || "二维码状态检查失败");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [bindingMusicAccount, loginMode, loginOpen, loginProvider, neteaseState?.qrKey]);

  useEffect(() => {
    if (!loginOpen || loginProvider !== "qq" || !isQqQrLoginMode(loginMode) || !qqMusicState?.qrSig) return undefined;
    const expectedLoginType = qqQrLoginTypeFromMode(loginMode);
    if (qqMusicState?.qrLoginType && qqMusicState.qrLoginType !== expectedLoginType) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/qqmusic/login/qr/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qrSig: qqMusicState.qrSig })
        });
        const data = await readJsonResponse(response);
        if (!response.ok) throw new Error(data.error || "QQ 音乐二维码状态检查失败");
        setQqMusicState(data);
        if (data.loggedIn || data.code === 0 || data.code === 200 || data.code === 803) {
          setLoginMessage(bindingMusicAccount ? "QQ 音乐登录成功，正在绑定到云韶账号" : "QQ 音乐登录成功，正在同步歌单");
          setLoginOpen(false);
          setQqMusicState(data);
          await loadAllLibraries().catch(() => null);
          await finishMusicAccountBinding();
        } else if (data.qrAlternative === "wx") {
          setLoginMode("qq-wx-qr");
          setQqMusicState((state) => (state ? { ...state, qrSig: "", qrImg: "", qrStatus: data.qrStatus || "", qrLoginType: "wx" } : data));
          setLoginMessage("QQ 扫码状态无法确认，请切换到微信扫码后重新生成二维码。");
        } else if (data.qrAlternative === "cookie") {
          setLoginMode("qq-cookie");
          setLoginMessage(data.qrStatus || "扫码状态暂时无法读取，请使用网页导入完成登录。");
        } else if (data.needCookieImport) {
          setLoginMode("qq-cookie");
          setLoginMessage("扫码成功，但腾讯没有返回 QQ 音乐 Cookie。请使用网页 Cookie 导入完成登录。");
        } else if (data.qrNeedsRefresh) {
          setQqQrConfigIndex(Number(data.nextQrConfigIndex || 0));
          setLoginMessage(`${data.qrStatus || "当前扫码配置不可用"}。请点击“刷新二维码”重试。`);
        } else if (data.qrStatus) {
          setLoginMessage(data.qrStatus);
        }
      } catch (error) {
        setLoginMessage(error.message || "QQ 音乐二维码状态检查失败");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [bindingMusicAccount, loginMode, loginOpen, loginProvider, qqMusicState?.qrLoginType, qqMusicState?.qrSig]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || "").toLowerCase();
      if (key === "h" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag !== "input" && tag !== "textarea") setUiHidden((value) => !value);
      }
      if (event.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    setAudioTime(0);
    setAudioDuration(0);
    setIsPlaying(false);

    const onTime = () => setAudioTime(audio.currentTime || 0);
    const onPlay = () => {
      setIsPlaying(true);
      void publishTogetherPlaybackState({ playing: true, currentTime: audio.currentTime || 0, force: true });
    };
    const onPause = () => {
      if (singleLoop && audio.ended) return;
      setIsPlaying(false);
      void publishTogetherPlaybackState({ playing: false, currentTime: audio.currentTime || 0, force: true });
    };
    const onMeta = () => setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnded = () => {
      if (singleLoop) {
        audio.currentTime = 0;
        setAudioTime(0);
        const track = currentTrackRef.current || queueRef.current[queueIndexRef.current] || selectedTrack;
        if (track && !lyricSegmentsRef.current.length) void loadLyricsForTrack(track, playTokenRef.current);
        audio.play().catch(() => null);
        return;
      }
      const nextIndex = queueIndexRef.current + 1;
      if (nextIndex < queueRef.current.length) {
        void playQueueTrack(nextIndex, { autoAdvance: true });
      } else {
        setIsPlaying(false);
        setMessage("播放完成");
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnded);
    };
  }, [isLoggedIn, playerSource, singleLoop]);

  useEffect(() => {
    let raf = 0;
    const startedAt = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const pulse = 0.18 + Math.sin(elapsed * 2.4) * 0.06 + Math.sin(elapsed * 5.7) * 0.035;
      setEnergy(isPlaying ? Math.max(0.1, Math.min(0.42, pulse)) : 0.08);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playerSource, isPlaying]);

  useEffect(() => {
    podcastEnabledRef.current = podcastEnabled;
    localStorage.setItem(PODCAST_ENABLED_KEY, podcastEnabled ? "true" : "false");
    if (!podcastEnabled) {
      stopPodcastOverlay();
      setMessage("播客已关闭，只播放音乐");
    }
  }, [podcastEnabled]);

  useEffect(() => {
    const key = currentBetaKey;
    const hasPermission = Boolean(cloudUser?.betaAccess || betaInviteEnabled);
    if (!hasPermission && betaEnabled) {
      setBetaEnabled(false);
      localStorage.removeItem(key);
      return;
    }
    if (!hasPermission) {
      localStorage.removeItem(key);
      if (betaEnabled) setBetaEnabled(false);
      return;
    }
    localStorage.setItem(key, betaEnabled ? "true" : "false");
    if (!betaEnabled && sceneMode === "earth") {
      setSceneMode("nebula");
    }
  }, [betaEnabled, betaInviteEnabled, currentBetaKey, sceneMode, cloudUser?.betaAccess]);

  function stopPodcastOverlay() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const podcastAudio = podcastAudioRef.current;
    if (podcastAudio) {
      podcastAudio.pause();
      podcastAudio.removeAttribute("src");
      podcastAudio.load?.();
    }
    if (audioRef.current) audioRef.current.volume = 1;
  }

  async function resolveTrackMusic(track) {
    if (!track) return "";
    const directUrl = track.musicUrl || track.url || "";
    if (directUrl) return directUrl;
    const key = cacheKeyForTrack(track, "music:");
    const cached = resolvedMusicCacheRef.current[key];
    if (cached?.musicUrl) return cached.musicUrl;
    const response = await fetch("/api/music/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...track,
        keyword: track.qqSearchKey || track.musicKeyword || `${track.title || ""} ${track.artist || ""}`.trim()
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "原曲解析失败");
    const musicUrl = data.musicUrl || "";
    if (musicUrl) {
      resolvedMusicCacheRef.current = {
        ...resolvedMusicCacheRef.current,
        [key]: { musicUrl, savedAt: Date.now() }
      };
      writeObjectCache(RESOLVED_MUSIC_CACHE_KEY, resolvedMusicCacheRef.current, 260);
    }
    return musicUrl;
  }

  async function prefetchQueueTrack(index) {
    const queue = queueRef.current;
    const track = queue[index];
    if (!track) return;
    const key = cacheKeyForTrack(track, "music:");
    if (track.musicUrl || track.url || resolvedMusicCacheRef.current[key]?.musicUrl || prefetchingRef.current.has(key)) return;
    prefetchingRef.current.add(key);
    try {
      const musicUrl = await resolveTrackMusic(track);
      if (musicUrl && queueRef.current[index] && trackKey(queueRef.current[index]) === trackKey(track)) {
        const nextQueue = [...queueRef.current];
        nextQueue[index] = { ...nextQueue[index], musicUrl };
        queueRef.current = nextQueue;
        setTrackQueue(nextQueue);
      }
    } catch (error) {
      console.debug("prefetch next track failed:", error?.message || error);
    } finally {
      prefetchingRef.current.delete(key);
    }
  }

  async function startTtsPodcastOverlay(track, token) {
    if (!track || !podcastEnabledRef.current) return;
    const musicAudio = audioRef.current;
    const podcastAudio = podcastAudioRef.current;
    if (!musicAudio || !podcastAudio) {
      setMessage("播客音频轨道未就绪");
      return;
    }
    try {
      const key = cacheKeyForTrack(track, "podcast:");
      let data = podcastCacheRef.current[key];
      const cacheFresh = data?.audioUrl && Date.now() - Number(data.savedAt || 0) < PODCAST_CACHE_TTL;
      if (!cacheFresh) {
        const response = await fetch("/api/track/tts-podcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            track,
            currentTime: musicAudio.currentTime || 0
          })
        });
        data = await readJsonResponse(response);
        if (!response.ok || !data.audioUrl) throw new Error(data.error || "播客语音生成失败");
        podcastCacheRef.current = {
          ...podcastCacheRef.current,
          [key]: {
            audioUrl: data.audioUrl,
            lyricSegments: Array.isArray(data.lyricSegments) ? data.lyricSegments : [],
            savedAt: Date.now()
          }
        };
        writeObjectCache(PODCAST_CACHE_KEY, podcastCacheRef.current, 120);
      }
      if (token !== playTokenRef.current) return;
      podcastAudio.src = data.audioUrl;
      podcastAudio.volume = 1;
      podcastAudio.onplay = () => {
        if (token === playTokenRef.current && audioRef.current) audioRef.current.volume = 0.34;
        const current = audioRef.current?.currentTime || 0;
        const currentLyric = (data.lyricSegments || []).find((segment) => current >= Number(segment.start || 0) && current < Number(segment.end || Number(segment.start || 0) + 4));
        setMessage(currentLyric?.text ? `播客接入当前歌词：${currentLyric.text}` : "播客已叠加，音乐保持播放");
      };
      podcastAudio.onended = podcastAudio.onerror = () => {
        if (token === playTokenRef.current && audioRef.current) audioRef.current.volume = 1;
      };
      await podcastAudio.play();
    } catch (error) {
      console.warn("tts podcast overlay failed:", error?.message || error);
      if (token === playTokenRef.current) {
        const key = cacheKeyForTrack(track, "podcast:");
        if (podcastCacheRef.current[key]) {
          const nextCache = { ...podcastCacheRef.current };
          delete nextCache[key];
          podcastCacheRef.current = nextCache;
          writeObjectCache(PODCAST_CACHE_KEY, nextCache, 120);
        }
        if (audioRef.current) audioRef.current.volume = 1;
        setMessage(error.message || "播客语音接入失败，音乐继续播放");
      }
    }
  }

  async function playQueueTrack(index, options = {}) {
    const queue = queueRef.current;
    const track = queue[index];
    if (!track) return;
    const token = ++playTokenRef.current;
    stopPodcastOverlay();
    currentTrackRef.current = track;
    queueIndexRef.current = index;
    setQueueIndex(index);
    setSelectedTrack(track);
    setPlayerTitle(track.title || BRAND_CN);
    setPlayerArtist(track.artist || track.playlistName || "podcast mix");
    lyricSegmentsRef.current = [];
    setLyricSegments([]);
    setMessage(`正在准备播放 ${index + 1}/${queue.length || 1}`);

    const playSourceNow = (nextSource, nextMessage = "") => {
      if (token !== playTokenRef.current || !nextSource) return false;
      setPlayerSource(nextSource);
      setMessage(nextMessage);
      window.setTimeout(() => {
        if (audioRef.current) audioRef.current.volume = 1;
        audioRef.current?.load?.();
        audioRef.current?.play().catch(() => setMessage("点击播放后浏览器才允许出声"));
      }, 80);
      return true;
    };

    try {
      const originalUrl = await resolveTrackMusic(track);
      if (!originalUrl) throw new Error("原曲解析失败：没有可播放链接");
      const playMessage = podcastEnabledRef.current
        ? `音乐已播放 ${index + 1}/${queue.length || 1}，正在后台生成播客`
        : `音乐已播放 ${index + 1}/${queue.length || 1}`;
      const started = playSourceNow(originalUrl, playMessage);
      if (started) {
        queue[index] = { ...track, musicUrl: originalUrl };
        queueRef.current = [...queue];
        setTrackQueue([...queue]);
        syncPlayHistory({ ...track, musicUrl: originalUrl });
        void publishTogetherTrack({ ...track, musicUrl: originalUrl });
        void loadLyricsForTrack(track, token);
        void prefetchQueueTrack(index + 1);
        window.setTimeout(() => {
          if (token === playTokenRef.current && podcastEnabledRef.current) void startTtsPodcastOverlay({ ...track, musicUrl: originalUrl }, token);
        }, 1200);
      }
    } catch (error) {
      console.warn("quick original playback failed:", error?.message || error);
      if (options.autoAdvance && index + 1 < queueRef.current.length) {
        setMessage(`跳过无法播放的歌曲：${track.title || "未知歌曲"}`);
        return playQueueTrack(index + 1, options);
      }
      throw error;
    }
  }

  async function selectSphereTrack(track) {
    if (!track) return;
    if (track.artistCenter) {
      setPanelOpen(true);
      setSelectedTrack(track);
      setHoveredTrack(track);
      flash(`${track.title} · ${track.artistSongs?.length || 0} 首歌`);
      return;
    }
    setDeepFocus(false);
    setJumping(false);
    setSelectedTrack(track);
    setHoveredTrack(track);
    setPlayerTitle(track.title || BRAND_CN);
    setPlayerArtist(track.artist || track.playlistName || "song point");
    const nextQueue = buildPlaybackQueue(track);
    queueRef.current = nextQueue;
    setTrackQueue(nextQueue);
    try {
      await playQueueTrack(0);
    } catch (error) {
      setMessage(error.message || "播放失败");
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setMessage("点击播放后浏览器才允许出声"));
    else audio.pause();
  }

  function seek(event) {
    const audio = audioRef.current;
    if (!audio || !audioDuration) return;
    const next = Number(event.target.value);
    audio.currentTime = (next / 100) * audioDuration;
    setAudioTime(audio.currentTime);
    void publishTogetherPlaybackState({ playing: !audio.paused, currentTime: audio.currentTime || 0, force: true });
  }

  function flash(text) {
    setToast(text);
    setMessage(text);
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => setToast(""), 2200);
  }

  async function openLoginPanel(mode = "qr") {
    setLoginOpen(true);
    setLoginProvider("netease");
    setLoginMode(mode);
    setLoginMessage("");
    if (mode !== "qr") return;
    neteaseQrAutoStartedRef.current = true;
    await startNeteaseQrLogin();
  }

  async function startNeteaseQrLogin() {
    setLoginBusy(true);
    setNeteaseState((state) => ({
      ...(state || {}),
      loggedIn: false,
      cookies: [],
      uid: "",
      profile: null,
      qrKey: "",
      qrImg: "",
      qrStatus: "正在生成网易云登录二维码"
    }));
    try {
      const response = await fetch("/api/netease/login/start", { method: "POST" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "二维码生成失败");
      setNeteaseState(data);
      setLoginMessage("请用网易云音乐扫码登录");
    } catch (error) {
      setLoginMessage(error.message || "二维码生成失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function sendCaptcha() {
    setLoginBusy(true);
    setLoginMessage("");
    try {
      const response = await fetch("/api/netease/login/captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, countrycode: "86" })
      });
      const data = await readJsonResponse(response);
      if (!response.ok || data.ok === false) {
        const riskText = data.risk ? "网易云判定手机号云端登录存在风险，请优先使用扫码登录或在 Vercel 配置 NETEASE_COOKIE。" : "";
        throw new Error(riskText || data.error || data.payload?.message || data.payload?.msg || "验证码发送失败");
      }
      setLoginMessage("验证码已发送");
    } catch (error) {
      setLoginMessage(error.message || "验证码发送失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function loginWithPhone(event) {
    event?.preventDefault?.();
    setLoginBusy(true);
    setLoginMessage("");
    try {
      const response = await fetch("/api/netease/login/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, captcha, countrycode: "86" })
      });
      const data = await readJsonResponse(response);
      if (!response.ok || data.ok === false) {
        const riskText = data.risk ? "网易云判定手机号云端登录存在风险，请优先使用扫码登录或在 Vercel 配置 NETEASE_COOKIE。" : "";
        throw new Error(riskText || data.error || data.payload?.message || data.payload?.msg || "手机号登录失败");
      }
      const nextState = data.state || (await refreshNeteaseState());
      setNeteaseState(nextState);
      setLoginOpen(false);
      setLoginMessage("");
      flash(bindingMusicAccount ? "网易云登录成功，正在绑定到云韶账号" : "网易云登录成功，正在同步歌单");
      await loadAllLibraries().catch(() => null);
      await finishMusicAccountBinding();
    } catch (error) {
      setLoginMessage(error.message || "手机号登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logoutNetease() {
    setLoginBusy(true);
    try {
      const response = await fetch("/api/netease/logout", { method: "POST" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "退出失败");
      setNeteaseState(data);
      await loadAllLibraries().catch(() => setLibraryTracks([]));
      setLoginOpen(false);
      flash("已退出网易云");
    } catch (error) {
      flash(error.message || "退出失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logoutCurrentMusicAccount() {
    const tasks = [];
    if (isNeteaseLoggedIn) tasks.push(logoutNetease());
    if (isQqMusicLoggedIn) tasks.push(logoutQqMusic());
    if (!tasks.length) {
      flash("当前没有已登录的音乐账号");
      return;
    }
    try {
      await Promise.allSettled(tasks);
      setBindingMusicAccount(false);
      setLoginOpen(false);
      setLoginProvider("netease");
      setLoginMode("qr");
      setLoginMessage("");
      setNeteaseState((state) => (state ? { ...state, loggedIn: false, cookies: [], uid: "", profile: null, qrKey: "", qrImg: "" } : state));
      setQqMusicState((state) => (state ? { ...state, loggedIn: false, cookies: [], uin: "", profile: null, qrSig: "", qrImg: "", qrStatus: "" } : state));
      flash("已退出当前音乐账号");
    } catch (error) {
      flash(error.message || "退出音乐账号失败");
    }
  }

  function openQqMusicLoginPanel() {
    setLoginOpen(true);
    setLoginProvider("qq");
    setLoginMode("qq-qr");
    setQqMusicState((state) => ({
      ...(state || {}),
      loggedIn: false,
      cookies: [],
      uin: "",
      profile: null,
      api1Credential: null,
      qrSig: "",
      qrImg: "",
      qrStatus: "正在生成 QQ 音乐二维码",
      qrLoginType: "qq"
    }));
    setLoginMessage("正在生成 QQ 音乐二维码。若 QQ 扫码无法确认，可切换微信扫码或网页导入。");
    window.setTimeout(() => startQqMusicQrLogin(qqQrConfigIndex, "qq"), 0);
  }

  function showQqMusicQrPanel() {
    setLoginProvider("qq");
    setLoginMode("qq-qr");
    setQqMusicState((state) => ({
      ...(state || {}),
      loggedIn: false,
      cookies: [],
      uin: "",
      profile: null,
      api1Credential: null,
      qrSig: "",
      qrImg: "",
      qrStatus: "正在生成 QQ 扫码二维码",
      qrLoginType: "qq"
    }));
    setLoginMessage("正在生成 QQ 扫码二维码。若确认后仍无法完成，请切换微信扫码。");
    window.setTimeout(() => startQqMusicQrLogin(qqQrConfigIndex, "qq"), 0);
  }

  function showQqMusicWxQrPanel() {
    setLoginProvider("qq");
    setLoginMode("qq-wx-qr");
    setQqMusicState((state) => ({
      ...(state || {}),
      loggedIn: false,
      cookies: [],
      uin: "",
      profile: null,
      api1Credential: null,
      qrSig: "",
      qrImg: "",
      qrStatus: "正在生成微信扫码二维码",
      qrLoginType: "wx"
    }));
    setLoginMessage("正在生成微信扫码二维码。");
    window.setTimeout(() => startQqMusicQrLogin(qqQrConfigIndex, "wx"), 0);
  }

  async function startQqMusicQrLogin(configIndex = qqQrConfigIndex, forcedLoginType = "") {
    const nextConfigIndex = Number.isFinite(Number(configIndex)) ? Number(configIndex) : qqQrConfigIndex;
    const loginType = forcedLoginType || qqQrLoginTypeFromMode(loginMode);
    setLoginBusy(true);
    setLoginMessage("");
    setQqMusicState((state) => ({
      ...(state || {}),
      loggedIn: false,
      cookies: [],
      uin: "",
      profile: null,
      api1Credential: null,
      qrSig: "",
      qrImg: "",
      qrStatus: `正在生成${loginType === "wx" ? "微信" : "手机 QQ"}扫码二维码`,
      qrLoginType: loginType
    }));
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      const response = await fetch("/api/qqmusic/login/qr/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configIndex: nextConfigIndex, loginType }),
        signal: controller.signal
      });
      window.clearTimeout(timeout);
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "QQ 音乐二维码生成失败");
      setQqMusicState(data);
      setQqQrConfigIndex(Number(data.qrConfigIndex || nextConfigIndex || 0));
      setLoginMode(loginType === "wx" ? "qq-wx-qr" : "qq-qr");
      setLoginMessage(`请使用${loginType === "wx" ? "微信" : "手机 QQ"}扫码${data.qrConfigLabel ? `（${data.qrConfigLabel}）` : ""}。`);
    } catch (error) {
      setLoginMode(loginType === "wx" ? "qq-wx-qr" : "qq-qr");
      setLoginMessage(error.name === "AbortError" ? "QQ 音乐二维码生成超时，可以重试或切换网页 Cookie 导入。" : error.message || "QQ 音乐二维码生成失败，可以重试或切换网页 Cookie 导入。");
    } finally {
      setLoginBusy(false);
    }
  }

  async function loginWithQqCookie(event) {
    event?.preventDefault?.();
    await loginWithQqCookieValue(qqCookie);
  }

  async function loginWithQqCookieValue(cookieValue) {
    setLoginBusy(true);
    setLoginMessage("");
    try {
      const response = await fetch("/api/qqmusic/login/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookieValue })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "QQ 音乐登录失败");
      setQqMusicState(data);
      setQqCookie("");
      setLoginOpen(false);
      flash(bindingMusicAccount ? "QQ 音乐登录成功，正在绑定到云韶账号" : "QQ 音乐登录成功，正在同步歌单");
      await loadAllLibraries().catch(() => null);
      await finishMusicAccountBinding();
    } catch (error) {
      setLoginMessage(error.message || "QQ 音乐登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function copyQqMusicImportScript() {
    const targetUrl = `${window.location.origin}${window.location.pathname}`;
    const script = `javascript:(()=>{location.href=${JSON.stringify(targetUrl)}+'#qqmusic_cookie='+encodeURIComponent(document.cookie)})()`;
    try {
      await navigator.clipboard?.writeText(script);
      setLoginMessage("导入脚本已复制。打开已登录的 QQ 音乐网页版，把脚本粘贴到地址栏执行。");
    } catch (_error) {
      setQqCookie(script);
      setLoginMessage("复制失败，脚本已放入输入框，请手动复制。");
    }
  }

  async function logoutQqMusic() {
    setLoginBusy(true);
    try {
      const response = await fetch("/api/qqmusic/logout", { method: "POST" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "QQ 音乐退出失败");
      setQqMusicState(data);
      await loadAllLibraries().catch(() => setLibraryTracks([]));
      setLoginOpen(false);
      flash("已退出 QQ 音乐");
    } catch (error) {
      flash(error.message || "QQ 音乐退出失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function playTrackFromUi(track, options = {}) {
    if (!track) return;
    if (options.fromTogether) suppressTogetherPublishRef.current = true;
    if (track.regionCenter) {
      setPanelOpen(true);
      setSelectedTrack(track);
      setHoveredTrack(track);
      flash("地球内测已暂停");
      return;
    }
    const shouldFocus = options.focus !== false;
    if (track.artistCenter) {
      setPanelOpen(true);
      setSelectedTrack(track);
      setHoveredTrack(track);
      flash(`${track.title} · ${track.artistSongs?.length || 0} 首歌`);
      return;
    }
    setPanelOpen(true);
    setSelectedTrack(track);
    setHoveredTrack(track);
    setJumpTrack(track);
    setDeepFocus(shouldFocus);
    setJumping(shouldFocus);
    if (!shouldFocus) {
      setJumpTrack(null);
      window.clearTimeout(playTrackFromUi.timer);
    }
    const nextQueue = buildPlaybackQueue(track);
    queueRef.current = nextQueue;
    setTrackQueue(nextQueue);
    void playQueueTrack(0).catch((error) => setMessage(error.message || "播放失败"));
    flash(`正在播放 ${track.title || "目标星点"}`);
    if (shouldFocus) {
      window.clearTimeout(playTrackFromUi.timer);
      playTrackFromUi.timer = window.setTimeout(() => setJumping(false), 3200);
    }
  }

  async function runGlobalSearch() {
    const keyword = query.trim();
    if (!keyword) {
      setGlobalTracks([]);
      setGlobalSearchStats([]);
      flash("请输入关键词后再进行全网搜索");
      return;
    }
    setGlobalSearching(true);
    setMessage("正在聚合全网歌曲");
    try {
      const modeMap = { 歌曲: "song", 歌手: "artist", 歌单: "playlist", 年代: "year" };
      const requestCount = searchMode === "歌手" ? 72 : qualityMode === "high" ? 48 : 24;
      const response = await fetch(`/api/music/search-all?keyword=${encodeURIComponent(keyword)}&count=${requestCount}&mode=${modeMap[searchMode] || "song"}`);
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "全网搜索失败");
      const items = (data.items || []).map((track, index) => ({
        ...track,
        libraryKey: `global:${track.platform || track.sourcePlatform || "music"}:${track.id || track.url || index}:${index}`,
        playlistName: "全网搜索",
        globalSearch: true,
        globalSearchMode: modeMap[searchMode] || "song",
        qqSearchKey: track.qqSearchKey || keyword
      }));
      setGlobalTracks(items);
      setGlobalSearchStats(data.stats || []);
      setViewMode(searchMode === "歌手" ? "歌手" : "歌单");
      setSelectedTrack(null);
      setHoveredTrack(null);
      setPanelOpen(true);
      flash(items.length ? (searchMode === "歌手" ? `全网聚合 ${items.length} 首，按歌手聚类` : `全网找到 ${items.length} 首歌曲，点击星星播放`) : "全网没有找到匹配内容");
    } catch (error) {
      flash(error.message || "全网搜索失败");
    } finally {
      setGlobalSearching(false);
    }
  }

  function submitSearch(event) {
    event?.preventDefault?.();
    if (globalSearching) return;
    if (globalSearchEnabled) {
      void runGlobalSearch();
      return;
    }
    const first = searchResults[0];
    if (first) void playTrackFromUi(first);
    else flash("没有找到匹配歌曲");
  }

  function selectViewMode(mode) {
    setViewMode(mode);
    setPanelOpen(true);
    setHoveredTrack(null);
    if (sceneMode !== "earth") {
      setSelectedTrack((current) => {
        if (current && filteredTracks.some((track) => trackKey(track) === trackKey(current))) return current;
        return current;
      });
    }
    flash(`${mode} 视图`);
  }

  function selectSceneMode(mode) {
    if (mode === "earth") {
      setSceneMode("nebula");
      setEarthSelection(null);
      flash("地球内测已暂停");
      return;
    }
    setSceneMode(mode);
    setPanelOpen(true);
    setEarthSelection((current) => (mode === "earth" ? current : null));
    setSphereResetToken((value) => value + 1);
    window.requestAnimationFrame(() => {
      runtimeRef.current?.updateInstances({ resetProgressive: true });
      if (mode === "earth") runtimeRef.current?.resetCamera();
    });
    flash(mode === "earth" ? "地球视图" : "星云视图");
  }

  function selectSortMode(mode) {
    setSortMode(mode);
    flash(`${mode} 排列`);
  }

  function resetNebulaView() {
    setDeepFocus(false);
    setJumping(false);
    setJumpTrack(null);
    setSphereResetToken((value) => value + 1);
    flash("已回到星云中心");
  }

  async function shareTrack() {
    if (!displayTrack) return;
    const title = `${BRAND_CN} · ${displayTrack.title || "歌曲"}`;
    const text = [
      `${displayTrack.title || "歌曲"} - ${displayTrack.artist || "未知艺人"}`,
      displayTrack.album ? `专辑：${displayTrack.album}` : "",
      displayTrack.playlistName ? `星图：${displayTrack.playlistName}` : "",
      `来自 ${BRAND_CN} ${BRAND_EN}`
    ].filter(Boolean).join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url: window.location.href });
        flash("分享已唤起");
      } else {
        await navigator.clipboard?.writeText(`${text}\n${window.location.href}`);
        flash("已复制分享文本");
      }
    } catch (error) {
      if (error?.name !== "AbortError") flash("分享失败，已保留当前星歌");
    }
  }

  async function saveSnapshot() {
    if (!displayTrack) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#06080d");
    gradient.addColorStop(0.48, "#0b1711");
    gradient.addColorStop(1, "#170711");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < 900; i += 1) {
      const x = (seededNoise(i + 42) * canvas.width);
      const y = (seededNoise(i + 440) * canvas.height);
      const r = 0.45 + seededNoise(i + 88) * 1.4;
      ctx.fillStyle = i % 5 === 0 ? "rgba(255,210,122,0.62)" : "rgba(255,255,255,0.42)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const cx = canvas.width * 0.64;
    const cy = canvas.height * 0.52;
    const halo = ctx.createRadialGradient(cx, cy, 8, cx, cy, 230);
    halo.addColorStop(0, "rgba(255,255,255,0.98)");
    halo.addColorStop(0.16, "rgba(255,210,122,0.68)");
    halo.addColorStop(0.44, "rgba(255,210,122,0.18)");
    halo.addColorStop(1, "rgba(255,210,122,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(cx - 260, cy - 260, 520, 520);

    if (displayTrack.cover) {
      try {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.src = displayTrack.cover;
        await image.decode();
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(88, 92, 210, 210, 22);
        ctx.clip();
        ctx.drawImage(image, 88, 92, 210, 210);
        ctx.restore();
      } catch (_error) {
        ctx.fillStyle = "rgba(255,210,122,0.16)";
        ctx.fillRect(88, 92, 210, 210);
      }
    }

    ctx.fillStyle = "#ffd27a";
    ctx.font = "700 34px serif";
    ctx.fillText(BRAND_CN, 88, 382);
    ctx.fillStyle = "#f6f2e6";
    ctx.font = "700 54px serif";
    ctx.fillText(String(displayTrack.title || "未命名歌曲").slice(0, 18), 88, 455);
    ctx.fillStyle = "#f6dca6";
    ctx.font = "500 28px sans-serif";
    ctx.fillText(String(displayTrack.artist || "未知艺人").slice(0, 28), 92, 506);
    ctx.fillStyle = "#8b93a7";
    ctx.font = "500 22px sans-serif";
    ctx.fillText([displayTrack.album, displayTrack.year || displayTrack.playlistName].filter(Boolean).join(" · ").slice(0, 42), 92, 552);
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.font = "500 18px sans-serif";
    ctx.fillText(`${BRAND_EN} · ${new Date().toLocaleDateString("zh-CN")}`, 92, 640);

    canvas.toBlob((blob) => {
      if (!blob) {
        flash("留影生成失败");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeFileName(displayTrack.title || BRAND_EN)}-留影.png`;
      link.click();
      URL.revokeObjectURL(url);
      flash("留影已保存为图片");
    }, "image/png");
  }

  function toggleSavedTrack() {
    if (!displayTrack) return;
    const key = trackKey(displayTrack);
    const next = new Set(savedKeys);
    const nextItems = { ...savedTrackItems };
    if (next.has(key)) {
      next.delete(key);
      delete nextItems[key];
      flash("已移出拾遗");
    } else {
      next.add(key);
      nextItems[key] = {
        ...displayTrack,
        savedAt: new Date().toISOString()
      };
      flash("已收进拾遗");
    }
    setSavedKeys(next);
    setSavedTrackItems(nextItems);
    localStorage.setItem(savedTracksKey, JSON.stringify([...next]));
    localStorage.setItem(savedTrackItemsKey, JSON.stringify(nextItems));
    syncSavedTracks(nextItems);
  }

  function captureRandomSong(point = {}) {
    if (globalSearchEnabled && !globalTracks.length) {
      flash("全网模式需要先输入关键词搜索到内容，才能随机捕捉");
      return;
    }
    const source = (globalSearchEnabled ? globalTracks : (sphereTracks.length ? sphereTracks : [...libraryTracks, ...Object.values(savedTrackItems)]))
      .filter((track) => track && !track.artistCenter && !track.placeholder);
    if (!source.length) {
      flash("还没有可捕捉的歌曲");
      return;
    }
    const seed = Math.floor((point.x || window.innerWidth / 2) * 17 + (point.y || window.innerHeight / 2) * 31 + Date.now());
    const picked = source[Math.abs(seed) % source.length];
    const id = `capture-${Date.now()}`;
    setCaptureOrb({ id, x: point.x || window.innerWidth / 2, y: point.y || window.innerHeight / 2, title: picked.title || "捕捉星歌" });
    flash("捕捉小球已释放");
    window.setTimeout(() => {
      setCaptureOrb((current) => current?.id === id ? { ...current, locked: true } : current);
      void playTrackFromUi(picked, { focus: false });
      flash(`捕捉到 ${picked.title || "一首歌"}`);
    }, 3200);
    window.setTimeout(() => {
      setCaptureOrb((current) => current?.id === id ? null : current);
    }, 4300);
  }

  const musicLoginPanel = !uiHidden && loginOpen && (
    <section className="login-panel" role="dialog" aria-modal="true" aria-label="音乐平台登录">
      <button className="panel-close" aria-label="关闭登录面板" type="button" onClick={() => {
        setLoginOpen(false);
        setBindingMusicAccount(false);
      }}>×</button>
      <div className="login-title">{bindingMusicAccount ? "绑定音乐账号" : loginProvider === "qq" ? "QQ 音乐登录" : "网易云登录"}</div>
      {bindingMusicAccount && <div className="login-hint">请选择网易云或 QQ 音乐登录，成功后会绑定到当前云韶账号。</div>}
      <div className="login-provider-tabs">
        <button className={loginProvider === "netease" ? "on" : ""} type="button" onClick={() => openLoginPanel("qr")}>网易云</button>
        <button className={loginProvider === "qq" ? "on" : ""} type="button" onClick={openQqMusicLoginPanel}>QQ 音乐</button>
      </div>
      {loginProvider === "qq" ? (
        <>
          <div className="login-tabs">
            <button className={loginMode === "qq-qr" ? "on" : ""} type="button" onClick={showQqMusicQrPanel}>QQ 扫码</button>
            <button className={loginMode === "qq-wx-qr" ? "on" : ""} type="button" onClick={showQqMusicWxQrPanel}>微信扫码</button>
            <button className={loginMode === "qq-cookie" ? "on" : ""} type="button" onClick={() => setLoginMode("qq-cookie")}>网页导入</button>
          </div>
          {isQqQrLoginMode(loginMode) ? (
            <div className="qr-login">
              <div className="qr-box">
                {qqMusicState?.qrImg ? <img src={qqMusicState.qrImg} alt="QQ 音乐登录二维码" /> : <span>{loginBusy ? "生成中" : "二维码生成中"}</span>}
              </div>
              {qqMusicState?.qrImg && (
                <button className="login-action" type="button" onClick={() => startQqMusicQrLogin()} disabled={loginBusy}>
                  刷新二维码
                </button>
              )}
            </div>
          ) : (
            <form className="phone-login qq-cookie-login" onSubmit={loginWithQqCookie}>
              <button className="login-action" type="button" onClick={copyQqMusicImportScript} disabled={loginBusy}>复制 QQ 网页自动导入脚本</button>
              <a className="qq-open-link" href="https://y.qq.com" target="_blank" rel="noreferrer">打开 QQ 音乐网页版</a>
              <textarea value={qqCookie} onChange={(event) => setQqCookie(event.target.value)} placeholder="也可以手动粘贴 https://y.qq.com 登录后的 Cookie，例如 uin=...; qm_keyst=...; qqmusic_key=..." />
              <button className="login-action" type="submit" disabled={loginBusy}>登录并同步 QQ 歌单</button>
            </form>
          )}
        </>
      ) : (
        <>
          <div className="login-tabs">
            <button className={loginMode === "qr" ? "on" : ""} type="button" onClick={() => openLoginPanel("qr")}>扫码</button>
            <button className={loginMode === "phone" ? "on" : ""} type="button" onClick={() => setLoginMode("phone")}>手机验证码</button>
          </div>
          {loginMode === "qr" ? (
            <div className="qr-login">
              <div className="qr-box">
                {neteaseState?.qrImg ? <img src={neteaseState.qrImg} alt="网易云登录二维码" /> : <span>{loginBusy ? "生成中" : "二维码生成中"}</span>}
              </div>
              {neteaseState?.qrImg && (
                <button className="login-action" type="button" onClick={() => openLoginPanel("qr")} disabled={loginBusy}>
                  刷新二维码
                </button>
              )}
            </div>
          ) : (
            <form className="phone-login" onSubmit={loginWithPhone}>
              <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="手机号码" />
              <div className="captcha-row">
                <input value={captcha} onChange={(event) => setCaptcha(event.target.value)} inputMode="numeric" placeholder="验证码" />
                <button type="button" onClick={sendCaptcha} disabled={loginBusy}>发送验证码</button>
              </div>
              <button className="login-action" type="submit" disabled={loginBusy}>登录并同步歌单</button>
            </form>
          )}
        </>
      )}
      <p className="login-message">{loginMessage || (loginProvider === "qq" ? "优先尝试扫码；如果腾讯没有返回音乐站 Cookie，请使用网页导入完成登录。" : "登录后会把你的网易云歌单变成星云中的歌曲点。")}</p>
    </section>
  );

  return (
    <main className="app cloud-stage">
      {!cloudUser ? (
        <section className="invite-gate">
          <div className="invite-card">
            <div className="invite-brand">
              <div className="title">{BRAND_CN} <span className="title-en">{BRAND_EN}</span></div>
              <p>云韶账号</p>
            </div>
            <form className="account-form" onSubmit={submitCloudAccount}>
              <div className="account-tabs">
                <button type="button" className={accountMode === "login" ? "on" : ""} onClick={() => setAccountMode("login")}>登录</button>
                <button type="button" className={accountMode === "register" ? "on" : ""} onClick={() => setAccountMode("register")}>注册</button>
              </div>
              <input value={accountUsername} onChange={(event) => setAccountUsername(event.target.value)} placeholder="云韶账号 / 邮箱" autoComplete="username" />
              <input value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} placeholder="密码" type="password" autoComplete={accountMode === "register" ? "new-password" : "current-password"} />
              <button type="submit" disabled={accountBusy}>{accountBusy ? (accountMode === "register" ? "注册中..." : "登录中...") : (accountMode === "register" ? "注册并进入" : "登录云韶账号")}</button>
              {accessMessage && <small className="account-message">{accessMessage}</small>}
              <small>注册后可跨设备同步最近播放、拾遗和绑定的音乐账号。</small>
            </form>
            {musicLoginPanel}
          </div>
        </section>
      ) : (
      <>
      <div className="space-field" />
      {!isDesktopApp && lyricDisplay?.lines?.length > 0 && (
        <div
          className="top-lyric"
          aria-live="polite"
          style={{
            "--lyric-progress": `${Math.round((lyricDisplay.progress || 0) * 100)}%`,
            "--lyric-x": `${lyricPosition.x}%`,
            "--lyric-y": `${lyricPosition.y}%`
          }}
          onPointerDown={startLyricDrag}
          onPointerMove={moveLyricDrag}
          onPointerUp={endLyricDrag}
          onPointerCancel={endLyricDrag}
        >
          {lyricDisplay.lines.map(({ segment, role }) => (
            <div key={`${role}-${segment.start}-${segment.text}`} className={`lyric-row ${role}`}>
              <span>{segment.text}</span>
            </div>
          ))}
        </div>
      )}
      {!uiHidden && (
      <header className="hud-top">
        <div className="title">
          {BRAND_CN} <span className="title-en">{BRAND_EN}</span>
        </div>
        {isCompactControls ? (
          <>
            <label className="select-shell">
              <span>视图</span>
              <select value={viewMode} onChange={(event) => selectViewMode(event.target.value)} aria-label="选择视图">
                {["歌手", "歌单", "封面", "年代", "拾遗"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
            <label className="select-shell compact">
              <span>排序</span>
              <select value={sortMode} onChange={(event) => selectSortMode(event.target.value)} aria-label="选择排序">
                {["热门", "最近", "更多"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            <div className="seg">
              {["歌手", "歌单", "封面", "年代", "拾遗"].map((mode) => (
                <button key={mode} className={`seg-btn ${viewMode === mode ? "on" : ""}`} onClick={() => selectViewMode(mode)} type="button">
                  {mode}
                </button>
              ))}
            </div>
            {["热门", "最近", "更多"].map((mode) => (
              <button key={mode} className={`filter ${sortMode === mode ? "on" : ""}`} onClick={() => selectSortMode(mode)} type="button">
                {mode}
              </button>
            ))}
          </>
        )}
        <button className={`filter ${globalSearchEnabled ? "on danger" : ""}`} type="button" onClick={() => {
          const next = !globalSearchEnabled;
          setGlobalSearchEnabled(next);
          if (!next) {
            setGlobalTracks([]);
            setGlobalSearchStats([]);
            setGlobalSearching(false);
          }
          if (next) flash("全网星图会显著增加星点，配置低的电脑请使用低画质");
        }}>
          {globalSearching ? "聚合中" : "全网搜索"}
        </button>
        <button className={`filter ${qualityMode === "high" ? "on" : ""}`} type="button" onClick={() => setQualityMode((mode) => mode === "high" ? "low" : "high")}>
          {qualityMode === "high" ? "高画质" : "低画质"}
        </button>
        <button className="filter" type="button" onClick={resetNebulaView}>
          回中心
        </button>
        <button className={`filter settings-trigger ${settingsOpen ? "on" : ""}`} type="button" onClick={() => setSettingsOpen((value) => !value)}>
          设置
        </button>
        {betaEnabled && (
          <button className={`filter ${togetherPanelOpen ? "on" : ""}`} type="button" onClick={() => setTogetherPanelOpen((value) => !value)}>
            一起听
          </button>
        )}
        {cloudUser && <span className="stat">云韶 · {cloudUser.username}</span>}
        <span className="stat">{isLibraryLoading ? "同步曲库中" : `${playlistCount || 0} 歌单 · ${libraryTracks.length || 0} 首`}</span>
        <button className="ui-hide-btn" onClick={() => setUiHidden(true)} type="button">隐藏界面 · H</button>
      </header>
      )}

      {uiHidden && <button className="ui-restore" type="button" onClick={() => setUiHidden(false)}>显示界面 · H</button>}

      {!uiHidden && settingsOpen && (
        <section className="settings-panel" role="dialog" aria-label="播放设置">
          <button className="panel-close" aria-label="关闭设置" type="button" onClick={() => setSettingsOpen(false)}>×</button>
          <div className="settings-title">播放设置</div>
          <label className="setting-row">
            <span>
              <strong>音乐播客</strong>
              <small>{podcastEnabled ? "点歌后会在后台生成讲述并叠加播放" : "只播放原曲，不再叠加 AI 播客"}</small>
            </span>
            <input
              type="checkbox"
              checked={podcastEnabled}
              onChange={(event) => setPodcastEnabled(event.target.checked)}
              aria-label="开启或关闭音乐播客"
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>单曲循环</strong>
              <small>{singleLoop ? "当前歌曲播放结束后会重新播放" : "播放结束后按队列继续下一首"}</small>
            </span>
            <input
              type="checkbox"
              checked={singleLoop}
              onChange={(event) => setSingleLoop(event.target.checked)}
              aria-label="开启或关闭单曲循环"
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>内测模式</strong>
              <small>{betaEnabled ? "会显示星云 / 地球切换、一起听等内测功能，部分功能可能不稳定" : "隐藏星云 / 地球切换和一起听，使用更稳定的基础界面"}</small>
            </span>
            <input
              type="checkbox"
              checked={betaEnabled}
              onChange={(event) => {
                const next = event.target.checked;
                if (next && !cloudUser?.betaAccess && !betaInviteEnabled) {
                  flash("当前账号还没有内测权限，请先输入邀请码激活");
                  event.target.checked = false;
                  return;
                }
                setBetaEnabled(next);
                if (next) flash("已开启内测模式，部分功能可能导致网页不稳定");
                else flash("已关闭内测模式");
              }}
              aria-label="开启或关闭内测模式"
            />
          </label>
          {!betaEnabled && (
            <div className="phone-login invite-activate">
              <div className="cover-section-title">内测邀请码</div>
              <div className="captcha-row">
                <input value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="输入邀请码开启内测" />
                <button type="button" onClick={submitInviteCode}>开启</button>
              </div>
            </div>
          )}
          <div className="account-tools">
            <strong>{cloudUser ? `云韶账号：${cloudUser.username}` : "云韶账号未登录"}</strong>
            <span>{cloudUser ? `拾遗 ${cloudUser.savedCount || 0} · 最近播放 ${cloudUser.historyCount || 0}` : "登录后可跨设备同步拾遗、最近播放和绑定的音乐账号。"}</span>
            <div className="admin-row">
              <button type="button" onClick={() => setCollectionPanelOpen(true)}>最近播放 / 拾遗</button>
              <button type="button" onClick={bindCurrentMusicAccounts}>绑定当前音乐账号</button>
              {(isNeteaseLoggedIn || isQqMusicLoggedIn) && (
                <button type="button" onClick={logoutCurrentMusicAccount}>退出当前音乐账号</button>
              )}
              <button type="button" onClick={syncCloudLibrary}>手动同步歌单</button>
              {cloudUser && (
                <button type="button" onClick={logoutCloudAccount}>退出云韶</button>
              )}
            </div>
          </div>
        </section>
      )}

      {!uiHidden && togetherPanelOpen && accountToken && betaEnabled && (
        <section className="together-panel" role="dialog" aria-modal="true" aria-label="一起听">
          <button className="panel-close together-close" aria-label="关闭一起听" type="button" onClick={() => setTogetherPanelOpen(false)}>×</button>
          <div className="together-head">
            <div>
              <div className="settings-title">一起听</div>
              <p>{togetherRoom ? "播放、暂停和进度会在房间内同步" : "创建房间或输入房间号，和搭子听同一首歌"}</p>
            </div>
            {togetherRoom && <button type="button" onClick={leaveTogetherRoom}>{togetherRoom.isOwner ? "解散" : "退出"}</button>}
          </div>
          {togetherRoom ? (
            <>
              <div className="together-room-card">
                <button type="button" onClick={copyTogetherRoomId} title="复制房间邀请码">
                  <span>房间号</span>
                  <strong>{togetherRoom.id}</strong>
                </button>
                <div>
                  <span>成员</span>
                  <strong>{[togetherRoom.ownerId, togetherRoom.mateId].filter(Boolean).length}/2</strong>
                </div>
                <div>
                  <span>状态</span>
                  <strong>{isPlaying ? "同步播放中" : "等待播放"}</strong>
                </div>
              </div>
              <div className="together-block together-chat">
                <div className="cover-section-title">聊天</div>
                <div className="chat-list">
                  {togetherMessages.length ? togetherMessages.map((item) => (
                    <div key={item.id} className={`chat-item ${item.userId === cloudUser?.id ? "mine" : ""}`}>
                      <strong>{item.username || "匿名"}</strong>
                      <span>{item.content}</span>
                    </div>
                  )) : <div className="cover-empty">还没有消息</div>}
                </div>
                <form className="together-chat-compose" onSubmit={sendTogetherMessage}>
                  <input value={togetherDraft} onChange={(event) => setTogetherDraft(event.target.value)} placeholder="发一句话..." />
                  <button type="submit">发送</button>
                </form>
              </div>
            </>
          ) : (
            <div className="together-actions">
              <form className="together-block" onSubmit={(event) => {
                event.preventDefault();
                void createTogetherRoom();
              }}>
                <div className="cover-section-title">创建</div>
                <input value={togetherRoomName} onChange={(event) => setTogetherRoomName(event.target.value)} placeholder="房间名称，可不填" />
                <button type="submit">创建房间</button>
              </form>
              <form className="together-block" onSubmit={(event) => {
                event.preventDefault();
                void joinTogetherRoom();
              }}>
                <div className="cover-section-title">加入</div>
                <input value={togetherRoomCode} onChange={(event) => setTogetherRoomCode(event.target.value)} placeholder="输入房间号" />
                <button type="submit">加入房间</button>
              </form>
            </div>
          )}
        </section>
      )}

      {!uiHidden && collectionPanelOpen && (
        <section className="collection-panel" role="dialog" aria-modal="true" aria-label="最近播放与拾遗">
          <button className="panel-close" aria-label="关闭列表" type="button" onClick={() => setCollectionPanelOpen(false)}>×</button>
          <div className="settings-title">最近播放 / 拾遗</div>
          <div className="cover-section">
            <div className="cover-section-title">最近播放</div>
            <div className="cover-grid">
              {recentTrackList.length ? recentTrackList.map((track, index) => (
                <button key={`${trackKey(track)}-${index}`} className="cover-tile" type="button" onClick={() => playTrackFromUi(track)}>
                  {track.cover ? <img src={track.cover} alt="" loading="lazy" /> : <span />}
                </button>
              )) : <div className="cover-empty">暂无最近播放</div>}
            </div>
          </div>
          <div className="cover-section">
            <div className="cover-section-title">拾遗</div>
            <div className="cover-grid">
              {savedTrackList.length ? savedTrackList.map((track, index) => (
                <button key={`${trackKey(track)}-${index}`} className="cover-tile" type="button" onClick={() => playTrackFromUi(track)}>
                  {track.cover ? <img src={track.cover} alt="" loading="lazy" /> : <span />}
                </button>
              )) : <div className="cover-empty">暂无拾遗</div>}
            </div>
          </div>
        </section>
      )}

      {!uiHidden && (
      <aside className="search">
        {isCompactControls ? (
          <div className="search-compact-row">
            <label className="select-shell search-select">
              <span>搜索</span>
              <select value={searchMode} onChange={(event) => setSearchMode(event.target.value)} aria-label="选择搜索类型">
                {["歌曲", "歌手", "歌单", "年代"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
            <button className="stab collapse" onClick={() => setUiHidden((value) => !value)} type="button">⌃</button>
          </div>
        ) : (
          <div className="search-tabs">
            {["歌曲", "歌手", "歌单", "年代"].map((mode) => (
              <button key={mode} className={`stab ${searchMode === mode ? "on" : ""}`} onClick={() => setSearchMode(mode)} type="button">
                {mode}
              </button>
            ))}
            <button className="stab collapse" onClick={() => setUiHidden((value) => !value)} type="button">⌃</button>
          </div>
        )}
        <form onSubmit={submitSearch}>
          <input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} disabled={globalSearching} placeholder={globalSearchEnabled ? `全网${searchMode}聚合，回车后等待点击星星` : `${searchMode === "年代" ? "只搜索年代" : searchMode === "歌单" ? "只搜索歌单/专辑" : searchMode === "歌手" ? "只搜索歌手" : "只搜索歌曲"}…`} />
        </form>
        {globalSearchEnabled && (
          <div className="global-warning">
            {globalSearching ? "正在从 QQ、网易、酷我、酷狗聚合星点…" : "全网星图会生成大量星点，低配置电脑建议保持低画质。"}
            {globalSearchStats.length > 0 && (
              <span>{globalSearchStats.map((item) => `${platformLabel(item.platform)} ${item.count}`).join(" · ")}</span>
            )}
          </div>
        )}
        {(query || searchMode !== "歌曲") && (
          <div className="search-results">
            {searchResults.length ? searchResults.map((track) => (
              <button key={trackKey(track)} className="search-row" type="button" onClick={() => playTrackFromUi(track)}>
                <span>
                  <span className="sr-name">{track.title}</span>
                  <span className="sr-title">{track.artist}</span>
                </span>
                <span className="sr-meta">{track.artistCenter ? "歌手星" : platformLabel(track.sourcePlatform || track.platform)} · {track.year || track.playlistName || "未知"}</span>
              </button>
            )) : (
              <button className="search-row" type="button" disabled>
                <span className="sr-name">没有找到匹配歌曲</span>
              </button>
            )}
          </div>
        )}
      </aside>
      )}

      <SongSphere
        tracks={sphereTracks}
        energy={energy}
        playing={isPlaying}
        jumping={jumping}
        deepFocus={deepFocus}
        globalMode={globalSearchEnabled}
        qualityMode={qualityMode}
        artistQuery={searchMode === "歌手" ? query : ""}
        sceneMode={sceneMode}
        resetToken={sphereResetToken}
        selectedKey={trackKey(selectedTrack)}
        onSelect={selectSphereTrack}
        onHover={setHoveredTrack}
        onBlankDoubleClick={captureRandomSong}
      />

      {captureOrb && (
        <div
          className={`capture-orb ${captureOrb.locked ? "locked" : ""}`}
          style={{ "--capture-x": `${captureOrb.x}px`, "--capture-y": `${captureOrb.y}px` }}
          aria-hidden="true"
        >
          <span />
          <em>{captureOrb.locked ? captureOrb.title : "捕捉中"}</em>
        </div>
      )}

      {jumping && jumpTrack && (
        <div className="warp-field" aria-hidden="true">
          <div className="warp-beam" />
          <div className="warp-core" />
          <div className="warp-grid" />
          <div className="warp-label">{jumpTrack.title}</div>
        </div>
      )}

      {musicLoginPanel}

      {!uiHidden && panelOpen && displayTrack && (
        <section className="detail-panel poem-panel">
          <button className="panel-close" aria-label="关闭" type="button" onClick={() => setPanelOpen(false)}>×</button>
          <div className="poem-body">
            {titleLines.map((line, index) => (
              <div className="poem-line" key={`${line}-${index}`}>{line}</div>
            ))}
            {displayTrack.artist && <div className="poem-line sub-line">{displayTrack.artist}</div>}
          </div>
          <div className="poem-meta">
            {displayTrack.artistCenter && (
              <div className="artist-song-list">
                {(displayTrack.artistSongs || []).map((song) => (
                  <button key={trackKey(song)} type="button" onClick={() => playTrackFromUi(song)}>
                    <span>{song.title}</span>
                    <small>{platformLabel(song.sourcePlatform || song.platform)} · {song.album || song.playlistName || song.year || "歌曲"}</small>
                  </button>
                ))}
              </div>
            )}
            {displayTrack.cover && (
              <div className="cover-row">
                <img src={displayTrack.cover} alt="" />
                <div>
                  <span className="meta-k">封面</span>
                  <span className="meta-v">{displayTrack.album || "未知专辑"}</span>
                </div>
              </div>
            )}
            <div className="meta-row">
              <span className="meta-k">歌单</span>
              <span className="meta-v">{displayTrack.playlistName || "网易云曲库"}</span>
            </div>
            <div className="meta-row">
              <span className="meta-k">年代</span>
              <span className="meta-v">{displayTrack.year || "年代未知"}</span>
            </div>
            <div className="meta-row">
              <span className="meta-k">歌曲编号</span>
              <span className="meta-v idx full">{String(displayTrack.id || trackKey(displayTrack))}</span>
            </div>
            <div className="poem-foot">点击歌星后播放音乐；是否叠加 AI 播客可在设置中随时切换。</div>
            <div className="poem-share">
              <button className="copy-btn share" type="button" onClick={shareTrack}>分享</button>
              <button className="copy-btn" type="button" onClick={saveSnapshot}>留影</button>
              <button className={`copy-btn ${savedKeys.has(trackKey(displayTrack)) ? "saved" : ""}`} type="button" onClick={toggleSavedTrack}>
                {savedKeys.has(trackKey(displayTrack)) ? "已收进拾遗" : "收进拾遗"}
              </button>
            </div>
          </div>
        </section>
      )}

      {showPlayer && !uiHidden && (
        <section className="player-dock">
          <button className="play-button" onClick={togglePlayback}>{isPlaying ? "Pause" : "Play"}</button>
          <div className="player-copy">
            <strong>{playerTitle}</strong>
            <span>{toast || message || playerArtist}</span>
            <input className="dock-progress" type="range" min="0" max="100" step="0.1" value={progress} onChange={seek} aria-label="播放进度" />
          </div>
          <time>{formatTime(audioTime)} / {formatTime(audioDuration)}</time>
        </section>
      )}

      {!uiHidden && (
      <footer className="hud-bottom">
        <span className="hint">搜索跃迁定位 · WASD/方向键移动镜头 · 拖拽旋转 · <b>点击歌星</b>播放音乐</span>
        <span className="speed">{jumping ? "速度 ×1.49 · 星系跃迁中" : deepFocus ? `近距离锁定 · ${jumpTrack?.title || "目标星点"}` : `${isPlaying ? "正在播放" : message || "待命"} · ${formatTime(audioTime)}`}</span>
      </footer>
      )}

      <audio ref={audioRef} src={playerSource || undefined} preload="auto" />
      <audio ref={podcastAudioRef} preload="auto" />
      </>
      )}

    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
