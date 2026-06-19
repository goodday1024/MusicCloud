import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import "./styles.css";

const BRAND_CN = "云韶";
const BRAND_EN = "CaelumShao";
const RENDER_LIMITS = {
  low: { tracks: 650, dust: 9000 },
  high: { tracks: 1800, dust: 26000 }
};

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
    if (!track?.artistCenter) return;
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
    color.set(0xd6d3c7);
  } else if (radius < 2.18) {
    const mix = Math.min(1, Math.max(0, (radius - 1.05) / 1.13));
    color.set(0x2fcf85).lerp(new THREE.Color(0x009b62), Math.max(0.35, mix));
  } else {
    const mix = Math.min(1, Math.max(0, (radius - 2.18) / 1.35));
    color.set(0xc94a32).lerp(new THREE.Color(0xff5a36), Math.max(0.28, mix));
  }
  return color;
}

function SongSphere({ tracks = [], energy = 0, selectedKey = "", playing = false, jumping = false, deepFocus = false, globalMode = false, qualityMode = "low", artistQuery = "", onSelect, onHover }) {
  const mountRef = useRef(null);
  const runtimeRef = useRef(null);
  const tracksRef = useRef(tracks);
  const selectedKeyRef = useRef(selectedKey);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const energyRef = useRef(energy);
  const jumpingRef = useRef(jumping);
  const deepFocusRef = useRef(deepFocus);
  const globalModeRef = useRef(globalMode);
  const qualityModeRef = useRef(qualityMode);
  const artistQueryRef = useRef(artistQuery);

  useEffect(() => {
    tracksRef.current = tracks;
    runtimeRef.current?.updateInstances();
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
    energyRef.current = energy;
  }, [energy]);

  useEffect(() => {
    jumpingRef.current = jumping;
  }, [jumping]);

  useEffect(() => {
    deepFocusRef.current = deepFocus;
  }, [deepFocus]);

  useEffect(() => {
    globalModeRef.current = globalMode;
    runtimeRef.current?.updateInstances();
  }, [globalMode]);

  useEffect(() => {
    qualityModeRef.current = qualityMode;
    runtimeRef.current?.updateInstances();
  }, [qualityMode]);

  useEffect(() => {
    artistQueryRef.current = artistQuery;
    runtimeRef.current?.updateInstances();
  }, [artistQuery]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 0, 6.4);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.42;
    host.appendChild(renderer.domElement);

    const group = new THREE.Group();
    group.rotation.x = -0.12;
    group.rotation.z = -0.08;
    scene.add(group);

    let trackCloud = null;
    let dust = null;
    let beams = null;
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
      const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.58, "rgba(255,255,255,0.92)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const pointTexture = makePointTexture();
    const dustMaterial = new THREE.PointsMaterial({
      size: 0.013,
      map: pointTexture,
      transparent: true,
      opacity: 0.98,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const trackMaterial = new THREE.PointsMaterial({
      size: 0.045,
      map: pointTexture,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.96,
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
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.075;
    const pointer = new THREE.Vector2();
    const activePointers = new Map();
    let dragging = false;
    let lastCenter = null;
    let lastPointerDown = { x: 0, y: 0, time: 0 };
    let wheelZoom = 1;
    let wheelZoomTarget = 1;
    let raf = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const updateInstances = () => {
      const sourceTracks = tracksRef.current.length
        ? pickRenderTracks(tracksRef.current, selectedKeyRef.current, RENDER_LIMITS[qualityModeRef.current]?.tracks || RENDER_LIMITS.low.tracks)
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

      const artistCenters = new Map();
      const artistGroups = new Map();
      if (globalModeRef.current) {
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

      const dustLimit = RENDER_LIMITS[qualityModeRef.current]?.dust || RENDER_LIMITS.low.dust;
      const dustCount = Math.max(18000, Math.min(dustLimit, Math.max(list.length * 42, 18000)));
      const dustPositions = new Float32Array(dustCount * 3);
      const dustColors = new Float32Array(dustCount * 3);
      for (let i = 0; i < dustCount; i += 1) {
        const point = galaxyPoint(i, dustCount, 9000);
        const core = 1 - Math.min(1, point.length() / 3.6);
        dustPositions[i * 3] = point.x;
        dustPositions[i * 3 + 1] = point.y + (seededNoise(i + 55) - 0.5) * 0.08;
        dustPositions[i * 3 + 2] = point.z;
        const c = nebulaLayerColor(point);
        const band = point.length() < 1.05 ? 0.72 : point.length() < 2.18 ? 1.85 : 2.15;
        const warmth = band + core * 0.08 + seededNoise(i + 88) * 0.12;
        dustColors[i * 3] = c.r * warmth;
        dustColors[i * 3 + 1] = c.g * warmth;
        dustColors[i * 3 + 2] = c.b * warmth;
      }
      const dustGeometry = new THREE.BufferGeometry();
      dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
      dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
      dust = new THREE.Points(dustGeometry, dustMaterial);
      group.add(dust);

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
        const isGlobalHit = globalModeRef.current && !track.placeholder && (track.globalSearch || track.artistCenter);
        const artistHit = q && normalizeText(track.artistGroupName || track.title || track.artist || "").includes(q);
        const isSearchGold = isGlobalHit && (!q || artistHit || track.globalSearchMode === "artist");
        const lifted = positions[index].clone();
        if (isActive || isHover) {
          lifted.add(positions[index].clone().normalize().multiplyScalar(isActive ? 0.08 : 0.045));
        }
        trackPositions[index * 3] = lifted.x;
        trackPositions[index * 3 + 1] = lifted.y;
        trackPositions[index * 3 + 2] = lifted.z;
        color.copy(isSearchGold ? goldColor : track.artistCenter || isActive ? coreStarColor : isHover ? hoverStarColor : nebulaLayerColor(lifted));
        const boost = isSearchGold ? (track.artistCenter ? 3.8 : 2.45) : track.artistCenter ? 2.2 : isActive ? 1.6 : isHover ? 1.35 : globalModeRef.current ? 0.42 : 0.88;
        trackColors[index * 3] = color.r * boost;
        trackColors[index * 3 + 1] = color.g * boost;
        trackColors[index * 3 + 2] = color.b * boost;
        if (!track.placeholder && !track.artistCenter) {
          const height = isSearchGold || isActive || isHover ? 1.35 : 0.58;
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
      host.classList.toggle("has-hover", Boolean(track && !track.placeholder));
      onHoverRef.current?.(track && !track.placeholder ? track : null);
    };

    const selectInstance = (instanceId) => {
      const track = renderList[instanceId];
      if (!track || track.placeholder) return;
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
      lastCenter = centerFromPointers();
      lastPointerDown = { x: event.clientX, y: event.clientY, time: Date.now() };
    };

    const onPointerMove = (event) => {
      if (!activePointers.has(event.pointerId)) {
        setHover(hitTest(event));
        return;
      }
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const center = centerFromPointers();
      if (!dragging || !center || !lastCenter) return;
      const dx = center.x - lastCenter.x;
      const dy = center.y - lastCenter.y;
      group.rotation.y += dx * 0.0062;
      group.rotation.x += dy * 0.0046;
      group.rotation.x = Math.max(-1.08, Math.min(1.08, group.rotation.x));
      lastCenter = center;
    };

    const onPointerUp = (event) => {
      activePointers.delete(event.pointerId);
      host.releasePointerCapture?.(event.pointerId);
      const moved = Math.hypot(event.clientX - lastPointerDown.x, event.clientY - lastPointerDown.y);
      if (moved < 7 && Date.now() - lastPointerDown.time < 420 && trackCloud) {
        const instanceId = hitTest(event);
        if (Number.isFinite(instanceId)) selectInstance(instanceId);
      }
      lastCenter = centerFromPointers();
      dragging = activePointers.size > 0;
    };

    const onWheel = (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const factor = direction > 0 ? 1.11 : 0.9;
      wheelZoomTarget = Math.max(0.55, Math.min(2.85, wheelZoomTarget * factor));
    };

    const animate = () => {
      const closeFocus = jumpingRef.current || deepFocusRef.current;
      const jumpBoost = jumpingRef.current ? 0.32 : deepFocusRef.current ? 0.18 : 0;
      const focusScale = hasFocus ? (closeFocus ? 4.85 : 1.52) : 1;
      wheelZoom += (wheelZoomTarget - wheelZoom) * 0.12;
      const pulse = (focusScale + jumpBoost + Math.min(0.06, energyRef.current * 0.06)) * wheelZoom;
      group.scale.lerp(new THREE.Vector3(pulse, pulse, pulse), closeFocus ? 0.115 : 0.075);
      if (hasFocus && !dragging) {
        focusWorld.copy(focusTarget).multiplyScalar(pulse).applyEuler(group.rotation);
        focusWorld.set(-focusWorld.x, -focusWorld.y, -focusWorld.z * 0.16);
        group.position.lerp(focusWorld, closeFocus ? 0.16 : 0.065);
      } else if (!dragging) {
        group.position.lerp(new THREE.Vector3(0, 0, 0), 0.035);
      }
      focusPoints.scale.setScalar(closeFocus ? 3.2 : 1.65);
      focusHalo.scale.setScalar(closeFocus ? 0.38 : 0.28);
      focusCore.scale.setScalar(closeFocus ? 0.22 : 0.11);
      focusMaterial.opacity = closeFocus ? 0.98 : 0.78;
      focusHaloMaterial.opacity = closeFocus ? 0.78 : 0.62;
      focusCoreMaterial.opacity = closeFocus ? 0.98 : 0.86;
      dustMaterial.size = closeFocus ? 0.008 : 0.013;
      trackMaterial.size = closeFocus ? 0.032 : 0.038;
      if (!dragging) {
        group.rotation.y += (closeFocus ? 0.00002 : hasFocus ? 0.00008 : 0.00065) + energyRef.current * (closeFocus ? 0.00004 : hasFocus ? 0.00035 : 0.0014);
        group.rotation.x += closeFocus ? 0.00001 : 0;
      }
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };

    runtimeRef.current = { updateInstances };
    resize();
    updateInstances();
    animate();
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    const onPointerLeave = () => setHover(null);
    host.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(raf);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", resize);
      runtimeRef.current = null;
      dustMaterial.dispose();
      trackMaterial.dispose();
      beamMaterial.dispose();
      focusGeometry.dispose();
      focusMaterial.dispose();
      focusHaloMaterial.dispose();
      focusTexture.dispose();
      focusCoreMaterial.dispose();
      focusCoreTexture.dispose();
      pointTexture.dispose();
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
  const [neteaseState, setNeteaseState] = useState(null);
  const [qqMusicState, setQqMusicState] = useState(null);
  const [libraryTracks, setLibraryTracks] = useState([]);
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
  const [energy, setEnergy] = useState(0.08);
  const [message, setMessage] = useState("");
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [viewMode, setViewMode] = useState("歌手");
  const [sortMode, setSortMode] = useState("热门");
  const [searchMode, setSearchMode] = useState("歌曲");
  const [query, setQuery] = useState("");
  const [globalSearchEnabled, setGlobalSearchEnabled] = useState(false);
  const [qualityMode, setQualityMode] = useState("low");
  const [globalTracks, setGlobalTracks] = useState([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchStats, setGlobalSearchStats] = useState([]);
  const [uiHidden, setUiHidden] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [savedKeys, setSavedKeys] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("agentio.savedTracks") || "[]"));
    } catch (_error) {
      return new Set();
    }
  });
  const [toast, setToast] = useState("");
  const [jumpTrack, setJumpTrack] = useState(null);
  const [jumping, setJumping] = useState(false);
  const [deepFocus, setDeepFocus] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginProvider, setLoginProvider] = useState("netease");
  const [loginMode, setLoginMode] = useState("qr");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [qqCookie, setQqCookie] = useState("");
  const [qqQrConfigIndex, setQqQrConfigIndex] = useState(0);

  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const queueRef = useRef([]);
  const queueIndexRef = useRef(-1);
  const playTokenRef = useRef(0);
  const libraryLoadRef = useRef(0);

  const isNeteaseLoggedIn = Boolean(neteaseState?.loggedIn);
  const isQqMusicLoggedIn = Boolean(qqMusicState?.loggedIn);
  const isLoggedIn = isNeteaseLoggedIn || isQqMusicLoggedIn;
  const showPlayer = Boolean(playerSource || trackQueue.length);
  const starTracks = useMemo(() => withArtistCenters(globalSearchEnabled ? globalTracks : libraryTracks, globalSearchEnabled), [globalSearchEnabled, globalTracks, libraryTracks]);
  const filteredTracks = useMemo(() => {
    const base = starTracks.filter((track) => {
      if (viewMode === "封面" && !track.cover) return false;
      if (viewMode === "年代" && !trackYearValue(track)) return false;
      if (viewMode === "歌单" && !track.playlistName) return false;
      if (viewMode === "歌手" && !track.artistCenter) return false;
      return true;
    });
    return sortVisibleTracks(base, sortMode);
  }, [sortMode, starTracks, viewMode]);
  const sphereTracks = globalSearchEnabled ? starTracks : filteredTracks;
  const searchResults = useMemo(() => {
    const q = normalizeText(query);
    const source = filteredTracks.length ? filteredTracks : starTracks;
    if (!q) return source.slice(0, searchMode === "年代" ? 12 : 8);
    return source.filter((track) => {
      if (searchMode === "年代") return String(trackYearValue(track) || "").includes(q) || trackSearchText(track).includes(q);
      if (searchMode === "歌曲") return normalizeText(track?.title || "").includes(q);
      if (searchMode === "歌单") return normalizeText(`${track?.playlistName || ""} ${track?.album || ""} ${track?.playlistDescription || ""}`).includes(q);
      if (searchMode === "歌手") return normalizeText(track?.artistCenter ? track.title : primaryArtist(track)).includes(q);
      return trackSearchText(track).includes(q);
    }).slice(0, 18);
  }, [filteredTracks, query, searchMode, starTracks]);
  const infoTrack = hoveredTrack || selectedTrack;
  const progress = audioDuration ? Math.min(100, (audioTime / audioDuration) * 100) : 0;
  const displayTrack = panelOpen ? infoTrack || selectedTrack || filteredTracks[0] || libraryTracks[0] || null : null;
  const playlistCount = new Set(libraryTracks.map((track) => track.playlistId).filter(Boolean)).size;
  const titleLines = splitTitle(displayTrack?.title || BRAND_CN);

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

  async function loadNeteaseLibrary() {
    const response = await fetch("/api/netease/library/tracks");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "网易云曲库暂时没有载入");
    return data.items || [];
  }

  async function loadQqMusicLibrary() {
    const response = await fetch("/api/qqmusic/library/tracks");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "QQ 音乐曲库暂时没有载入");
    return data.items || [];
  }

  async function loadAllLibraries() {
    const token = libraryLoadRef.current + 1;
    libraryLoadRef.current = token;
    setIsLibraryLoading(true);
    const [neteaseItems, qqItems] = await Promise.all([
      loadNeteaseLibrary().catch(() => []),
      loadQqMusicLibrary().catch(() => [])
    ]);
    if (token !== libraryLoadRef.current) return [];
    const merged = [...neteaseItems, ...qqItems];
    setLibraryTracks(merged);
    if (!merged.length) setMessage("还没有载入曲库，请先登录网易云或 QQ 音乐");
    else setMessage("");
    setIsLibraryLoading(false);
    return merged;
  }

  useEffect(() => {
    refreshNeteaseState().catch(() => setNeteaseState({ loggedIn: false }));
    refreshQqMusicState().catch(() => setQqMusicState({ loggedIn: false }));
  }, []);

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
    loadAllLibraries().catch(() => {
      setLibraryTracks([]);
      setIsLibraryLoading(false);
      setMessage("曲库暂时没有载入");
    });
  }, [isNeteaseLoggedIn, isQqMusicLoggedIn]);

  useEffect(() => {
    if (!loginOpen || loginMode !== "qr" || !neteaseState?.qrKey || isLoggedIn) return undefined;
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
          setLoginMessage("登录成功，正在同步歌单");
          setLoginOpen(false);
          setNeteaseState(data);
          await loadAllLibraries().catch(() => null);
        } else if (data.qrStatus || data.payload?.message) {
          setLoginMessage(data.qrStatus || data.payload?.message);
        }
      } catch (error) {
        setLoginMessage(error.message || "二维码状态检查失败");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [isLoggedIn, loginMode, loginOpen, neteaseState?.qrKey]);

  useEffect(() => {
    if (!loginOpen || loginProvider !== "qq" || !isQqQrLoginMode(loginMode) || !qqMusicState?.qrSig || isQqMusicLoggedIn) return undefined;
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
        if (data.loggedIn && !data.needCookieImport) {
          setLoginMessage("QQ 音乐登录成功，正在同步歌单");
          setLoginOpen(false);
          await loadAllLibraries().catch(() => null);
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
  }, [isQqMusicLoggedIn, loginMode, loginOpen, loginProvider, qqMusicState?.qrLoginType, qqMusicState?.qrSig]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() === "h" && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onMeta = () => setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnded = () => {
      const nextIndex = queueIndexRef.current + 1;
      if (nextIndex < queueRef.current.length) {
        void playQueueTrack(nextIndex);
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
  }, [playerSource]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return undefined;
    const audioCtx = audioContextRef.current || new AudioContext();
    audioContextRef.current = audioCtx;
    const analyser = analyserRef.current || audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.88;
    analyserRef.current = analyser;

    if (!sourceNodeRef.current) {
      try {
        sourceNodeRef.current = audioCtx.createMediaElementSource(audio);
        sourceNodeRef.current.connect(analyser);
        analyser.connect(audioCtx.destination);
      } catch (error) {
        console.debug("audio analyser unavailable", error?.message || error);
      }
    }

    const bins = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      const avg = bins.reduce((sum, value) => sum + value, 0) / bins.length / 255;
      setEnergy(isPlaying ? Math.max(0.08, Math.min(0.72, avg * 1.7)) : 0.08);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playerSource, isPlaying]);

  async function playQueueTrack(index) {
    const queue = queueRef.current;
    const track = queue[index];
    if (!track) return;
    const token = ++playTokenRef.current;
    queueIndexRef.current = index;
    setQueueIndex(index);
    setSelectedTrack(track);
    setPlayerTitle(track.title || BRAND_CN);
    setPlayerArtist(track.artist || track.playlistName || "podcast mix");
    setMessage("正在生成播客混音");

    let source = track.podcastAudioUrl || track.outputUrl || "";
    if (!source) {
      const response = await fetch("/api/track/podcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track, prompt: "", voice: "alloy" })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "单曲播客生成失败");
      source = data.podcastAudioUrl || data.outputUrl || "";
      queue[index] = { ...track, ...data };
      queueRef.current = [...queue];
      setTrackQueue([...queue]);
    }

    if (token !== playTokenRef.current || !source) return;
    setPlayerSource(source);
    setMessage("");
    window.setTimeout(() => {
      audioRef.current?.play().catch(() => setMessage("点击播放后浏览器才允许出声"));
    }, 160);
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
    queueRef.current = [track];
    setTrackQueue([track]);
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
    setLoginBusy(true);
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
      flash("网易云登录成功，正在同步歌单");
      await loadAllLibraries().catch(() => null);
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

  function openQqMusicLoginPanel() {
    setLoginOpen(true);
    setLoginProvider("qq");
    setLoginMode("qq-qr");
    setLoginMessage("点击生成二维码后扫码登录。若 QQ 扫码无法确认，可切换微信扫码或网页导入。");
  }

  function showQqMusicQrPanel() {
    setLoginProvider("qq");
    setLoginMode("qq-qr");
    setQqMusicState((state) => (state ? { ...state, qrSig: "", qrImg: "", qrStatus: "", qrLoginType: "qq" } : state));
    setLoginMessage("点击生成二维码后，用手机 QQ 扫码。若确认后仍无法完成，请切换微信扫码。");
  }

  function showQqMusicWxQrPanel() {
    setLoginProvider("qq");
    setLoginMode("qq-wx-qr");
    setQqMusicState((state) => (state ? { ...state, qrSig: "", qrImg: "", qrStatus: "", qrLoginType: "wx" } : state));
    setLoginMessage("点击生成二维码后，用微信扫码确认 QQ 音乐登录。");
  }

  async function startQqMusicQrLogin(configIndex = qqQrConfigIndex) {
    const nextConfigIndex = Number.isFinite(Number(configIndex)) ? Number(configIndex) : qqQrConfigIndex;
    const loginType = qqQrLoginTypeFromMode(loginMode);
    setLoginBusy(true);
    setLoginMessage("");
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
      flash("QQ 音乐登录成功，正在同步歌单");
      await loadAllLibraries().catch(() => null);
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

  async function playTrackFromUi(track) {
    if (!track) return;
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
    setDeepFocus(true);
    setJumping(true);
    flash(`正在贴近 ${track.title || "目标星点"}，点击中心星点后播放`);
    window.clearTimeout(playTrackFromUi.timer);
    playTrackFromUi.timer = window.setTimeout(() => setJumping(false), 3200);
  }

  async function runGlobalSearch() {
    const keyword = query.trim();
    if (!keyword) {
      flash("请输入全网搜索关键词");
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
        qqSearchKey: track.qqSearchKey || keyword
      }));
      setGlobalTracks(items);
      setGlobalSearchStats(data.stats || []);
      setViewMode("歌手");
      setSelectedTrack(null);
      setHoveredTrack(null);
      setPanelOpen(true);
      flash(`全网聚合 ${items.length} 首，按歌手聚类`);
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
    setSelectedTrack((current) => {
      if (current && filteredTracks.some((track) => trackKey(track) === trackKey(current))) return current;
      return current;
    });
    flash(`${mode} 视图`);
  }

  function selectSortMode(mode) {
    setSortMode(mode);
    flash(`${mode} 排列`);
  }

  async function shareTrack() {
    if (!displayTrack) return;
    const text = `${BRAND_CN} · ${displayTrack.title || "歌曲"} - ${displayTrack.artist || "未知艺人"}`;
    try {
      await navigator.clipboard?.writeText(text);
      flash("已复制分享文本");
    } catch (_error) {
      flash(text);
    }
  }

  function saveSnapshot() {
    if (!displayTrack) return;
    const payload = {
      title: displayTrack.title || BRAND_CN,
      artist: displayTrack.artist || "",
      album: displayTrack.album || "",
      playlist: displayTrack.playlistName || "",
      year: displayTrack.year || "",
      savedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${displayTrack.title || "agentio"}-snapshot.json`;
    link.click();
    URL.revokeObjectURL(url);
    flash("留影已下载");
  }

  function toggleSavedTrack() {
    if (!displayTrack) return;
    const key = trackKey(displayTrack);
    const next = new Set(savedKeys);
    if (next.has(key)) {
      next.delete(key);
      flash("已移出拾遗");
    } else {
      next.add(key);
      flash("已收进拾遗");
    }
    setSavedKeys(next);
    localStorage.setItem("agentio.savedTracks", JSON.stringify([...next]));
  }

  return (
    <main className="app cloud-stage">
      <div className="space-field" />
      {!uiHidden && (
      <header className="hud-top">
        <div className="title">
          {BRAND_CN} <span className="title-en">{BRAND_EN}</span>
        </div>
        <div className="seg">
          {["歌手", "播客", "歌单", "封面", "年代"].map((mode) => (
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
        <span className="stat">{isLibraryLoading ? "同步曲库中" : `${playlistCount || 0} 歌单 · ${libraryTracks.length || 0} 首`}</span>
        <div className="login-actions">
          {isNeteaseLoggedIn ? (
            <div className="login-chip">
              <span>{neteaseState?.profile?.nickname || neteaseState?.uid || "网易云已登录"}</span>
              <button type="button" onClick={logoutNetease} aria-label="退出网易云">退出</button>
            </div>
          ) : (
            <button className="login-entry" onClick={() => openLoginPanel("qr")} type="button">网易云登录</button>
          )}
          {isQqMusicLoggedIn ? (
            <div className="login-chip qq">
              <span>{qqMusicState?.profile?.creator?.hostname || qqMusicState?.profile?.nick || qqMusicState?.uin || "QQ 音乐已登录"}</span>
              <button type="button" onClick={logoutQqMusic} aria-label="退出 QQ 音乐">退出</button>
            </div>
          ) : (
            <button className="login-entry qq" onClick={openQqMusicLoginPanel} type="button">QQ 音乐登录</button>
          )}
        </div>
        <button className="ui-hide-btn" onClick={() => setUiHidden(true)} type="button">隐藏界面 · H</button>
      </header>
      )}

      {uiHidden && <button className="ui-restore" type="button" onClick={() => setUiHidden(false)}>显示界面 · H</button>}

      {!uiHidden && (
      <aside className="search">
        <div className="search-tabs">
          {["歌曲", "歌手", "歌单", "年代"].map((mode) => (
            <button key={mode} className={`stab ${searchMode === mode ? "on" : ""}`} onClick={() => setSearchMode(mode)} type="button">
              {mode}
            </button>
          ))}
          <button className="stab collapse" onClick={() => setUiHidden((value) => !value)} type="button">⌃</button>
        </div>
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
        selectedKey={trackKey(selectedTrack)}
        onSelect={selectSphereTrack}
        onHover={setHoveredTrack}
      />

      {jumping && jumpTrack && (
        <div className="warp-field" aria-hidden="true">
          <div className="warp-beam" />
          <div className="warp-core" />
          <div className="warp-grid" />
          <div className="warp-label">{jumpTrack.title}</div>
        </div>
      )}

      {!uiHidden && loginOpen && (
        <section className="login-panel" role="dialog" aria-modal="true" aria-label="音乐平台登录">
          <button className="panel-close" aria-label="关闭登录面板" type="button" onClick={() => setLoginOpen(false)}>×</button>
          <div className="login-title">{loginProvider === "qq" ? "QQ 音乐登录" : "网易云登录"}</div>
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
                    {qqMusicState?.qrImg ? <img src={qqMusicState.qrImg} alt="QQ 音乐登录二维码" /> : <span>{loginBusy ? "生成中" : "点击刷新二维码"}</span>}
                  </div>
                  <button className="login-action" type="button" onClick={() => startQqMusicQrLogin()} disabled={loginBusy}>
                    {qqMusicState?.qrImg ? "刷新二维码" : `生成${loginMode === "qq-wx-qr" ? "微信" : "QQ"}二维码`}
                  </button>
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
                    {neteaseState?.qrImg ? <img src={neteaseState.qrImg} alt="网易云登录二维码" /> : <span>{loginBusy ? "生成中" : "点击刷新二维码"}</span>}
                  </div>
                  <button className="login-action" type="button" onClick={() => openLoginPanel("qr")} disabled={loginBusy}>
                    {neteaseState?.qrImg ? "刷新二维码" : "生成二维码"}
                  </button>
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
      )}

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
            <div className="poem-foot">点击歌星后生成播客混音；播客不报主持人名，只讲歌曲与场景本身。</div>
            <div className="poem-share">
              <button className="copy-btn share" type="button" onClick={shareTrack}>分享</button>
              <button className="copy-btn" type="button" onClick={saveSnapshot}>留影</button>
              <button className="copy-btn" type="button" onClick={toggleSavedTrack}>{savedKeys.has(trackKey(displayTrack)) ? "已收进拾遗" : "收进拾遗"}</button>
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
        <span className="hint">搜索跃迁定位 · 拖拽旋转 · <b>点击歌星</b>生成播客混音</span>
        <span className="speed">{jumping ? "速度 ×1.49 · 星系跃迁中" : deepFocus ? `近距离锁定 · ${jumpTrack?.title || "目标星点"}` : `${isPlaying ? "正在播放" : message || "待命"} · ${formatTime(audioTime)}`}</span>
      </footer>
      )}

      {playerSource && <audio ref={audioRef} src={playerSource} preload="auto" />}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
