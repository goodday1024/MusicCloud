import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import "./styles.css";

function trackKey(track) {
  if (!track) return "";
  return String(track.libraryKey || track.id || track.podcastAudioUrl || track.musicUrl || `${track.title || ""}-${track.artist || ""}`);
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function splitTitle(title) {
  const chars = Array.from(String(title || "Agentio"));
  if (chars.length <= 10) return [chars.join("")];
  const midpoint = Math.ceil(chars.length / 2);
  return [chars.slice(0, midpoint).join(""), chars.slice(midpoint).join("")];
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
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

function SongSphere({ tracks = [], energy = 0, selectedKey = "", playing = false, jumping = false, deepFocus = false, onSelect, onHover }) {
  const mountRef = useRef(null);
  const runtimeRef = useRef(null);
  const tracksRef = useRef(tracks);
  const selectedKeyRef = useRef(selectedKey);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const energyRef = useRef(energy);
  const jumpingRef = useRef(jumping);
  const deepFocusRef = useRef(deepFocus);

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
    let positions = [];
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
    const dustMaterial = new THREE.PointsMaterial({
      size: 0.011,
      transparent: true,
      opacity: 0.84,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const trackMaterial = new THREE.PointsMaterial({
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.96,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const color = new THREE.Color();
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.075;
    const pointer = new THREE.Vector2();
    const activePointers = new Map();
    let dragging = false;
    let lastCenter = null;
    let lastPointerDown = { x: 0, y: 0, time: 0 };
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
      const list = tracksRef.current.length
        ? tracksRef.current
        : Array.from({ length: 220 }, (_, index) => ({
            title: "等待曲库",
            artist: "Agentio",
            libraryKey: `placeholder-${index}`,
            placeholder: true
          }));

      if (trackCloud) {
        group.remove(trackCloud);
        trackCloud.geometry.dispose();
      }
      if (dust) {
        group.remove(dust);
        dust.geometry.dispose();
      }

      positions = list.map((track, index) => {
        const seed = String(track.libraryKey || track.id || track.title || index).split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        return galaxyPoint(index, Math.max(list.length, 1), seed);
      });

      const dustCount = Math.max(18000, Math.min(42000, list.length * 42));
      const dustPositions = new Float32Array(dustCount * 3);
      const dustColors = new Float32Array(dustCount * 3);
      const palette = [0xffd27a, 0xf05aa8, 0x48d69a, 0xf26a32, 0xa7b6ff, 0xffffff];
      for (let i = 0; i < dustCount; i += 1) {
        const point = galaxyPoint(i, dustCount, 9000);
        const core = 1 - Math.min(1, point.length() / 3.6);
        dustPositions[i * 3] = point.x;
        dustPositions[i * 3 + 1] = point.y + (seededNoise(i + 55) - 0.5) * 0.08;
        dustPositions[i * 3 + 2] = point.z;
        const c = new THREE.Color(palette[(i + Math.floor(point.length() * 10)) % palette.length]);
        const warmth = 0.38 + core * 0.72 + seededNoise(i + 88) * 0.16;
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
      list.forEach((track, index) => {
        const isActive = index === activeId;
        const isHover = index === hoverId;
        const lifted = positions[index].clone();
        if (isActive || isHover) {
          lifted.add(positions[index].clone().normalize().multiplyScalar(isActive ? 0.08 : 0.045));
        }
        trackPositions[index * 3] = lifted.x;
        trackPositions[index * 3 + 1] = lifted.y;
        trackPositions[index * 3 + 2] = lifted.z;
        const tint = index % 5;
        color.set(isActive ? 0xffffff : isHover ? 0xfff2bd : tint === 0 ? 0xffd27a : tint === 1 ? 0x48d69a : tint === 2 ? 0xf05aa8 : tint === 3 ? 0xf26a32 : 0xa7b6ff);
        const boost = isActive ? 1.6 : isHover ? 1.35 : 0.88;
        trackColors[index * 3] = color.r * boost;
        trackColors[index * 3 + 1] = color.g * boost;
        trackColors[index * 3 + 2] = color.b * boost;
      });
      const trackGeometry = new THREE.BufferGeometry();
      trackGeometry.setAttribute("position", new THREE.BufferAttribute(trackPositions, 3));
      trackGeometry.setAttribute("color", new THREE.BufferAttribute(trackColors, 3));
      trackCloud = new THREE.Points(trackGeometry, trackMaterial);
      group.add(trackCloud);
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
      updateInstances();
      const track = hoverId >= 0 ? tracksRef.current[hoverId] : null;
      host.classList.toggle("has-hover", Boolean(track && !track.placeholder));
      onHoverRef.current?.(track && !track.placeholder ? track : null);
    };

    const selectInstance = (instanceId) => {
      const track = tracksRef.current[instanceId];
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

    const animate = () => {
      const closeFocus = jumpingRef.current || deepFocusRef.current;
      const jumpBoost = jumpingRef.current ? 0.32 : deepFocusRef.current ? 0.18 : 0;
      const focusScale = hasFocus ? (closeFocus ? 4.85 : 1.52) : 1;
      const pulse = focusScale + jumpBoost + Math.min(0.06, energyRef.current * 0.06);
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
      dustMaterial.size = closeFocus ? 0.0065 : 0.011;
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
    const onPointerLeave = () => setHover(null);
    host.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(raf);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", resize);
      runtimeRef.current = null;
      dustMaterial.dispose();
      trackMaterial.dispose();
      focusGeometry.dispose();
      focusMaterial.dispose();
      focusHaloMaterial.dispose();
      focusTexture.dispose();
      focusCoreMaterial.dispose();
      focusCoreTexture.dispose();
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
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [hoveredTrack, setHoveredTrack] = useState(null);
  const [trackQueue, setTrackQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [playerSource, setPlayerSource] = useState("");
  const [playerTitle, setPlayerTitle] = useState("Agentio");
  const [playerArtist, setPlayerArtist] = useState("click a golden song point");
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [energy, setEnergy] = useState(0.08);
  const [message, setMessage] = useState("");
  const [viewMode, setViewMode] = useState("歌星");
  const [sortMode, setSortMode] = useState("热门");
  const [searchMode, setSearchMode] = useState("歌曲");
  const [query, setQuery] = useState("");
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
  const [loginMode, setLoginMode] = useState("qr");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [captcha, setCaptcha] = useState("");

  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const queueRef = useRef([]);
  const queueIndexRef = useRef(-1);
  const playTokenRef = useRef(0);

  const isLoggedIn = Boolean(neteaseState?.loggedIn);
  const showPlayer = Boolean(playerSource || trackQueue.length);
  const filteredTracks = useMemo(() => {
    const base = libraryTracks.filter((track) => {
      if (viewMode === "封面" && !track.cover) return false;
      if (viewMode === "年代" && !trackYearValue(track)) return false;
      if (viewMode === "歌单" && !track.playlistName) return false;
      return true;
    });
    return sortVisibleTracks(base, sortMode);
  }, [libraryTracks, sortMode, viewMode]);
  const searchResults = useMemo(() => {
    const q = normalizeText(query);
    const source = filteredTracks.length ? filteredTracks : libraryTracks;
    if (!q) return source.slice(0, searchMode === "年代" ? 12 : 8);
    return source.filter((track) => {
      if (searchMode === "年代") return String(trackYearValue(track) || "").includes(q) || trackSearchText(track).includes(q);
      if (searchMode === "寻歌") return normalizeText(`${track?.title || ""} ${track?.artist || ""}`).includes(q);
      if (searchMode === "探歌") return normalizeText(`${track?.playlistName || ""} ${track?.album || ""} ${track?.playlistDescription || ""}`).includes(q) || trackSearchText(track).includes(q);
      return trackSearchText(track).includes(q);
    }).slice(0, 18);
  }, [filteredTracks, libraryTracks, query, searchMode]);
  const infoTrack = hoveredTrack || selectedTrack;
  const progress = audioDuration ? Math.min(100, (audioTime / audioDuration) * 100) : 0;
  const displayTrack = panelOpen ? infoTrack || filteredTracks[0] || libraryTracks[0] || null : null;
  const playlistCount = new Set(libraryTracks.map((track) => track.playlistId).filter(Boolean)).size;
  const titleLines = splitTitle(displayTrack?.title || "Agentio");

  async function refreshNeteaseState() {
    const response = await fetch("/api/netease/state");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "网易云状态读取失败");
    setNeteaseState(data);
    return data;
  }

  async function loadNeteaseLibrary() {
    const response = await fetch("/api/netease/library/tracks");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "网易云曲库暂时没有载入");
    setLibraryTracks(data.items || []);
    return data.items || [];
  }

  useEffect(() => {
    refreshNeteaseState().catch(() => setNeteaseState({ loggedIn: false }));
  }, []);

  useEffect(() => {
    loadNeteaseLibrary().catch(() => {
      setLibraryTracks([]);
      setMessage("网易云曲库暂时没有载入");
    });
  }, [isLoggedIn]);

  useEffect(() => {
    if (!loginOpen || loginMode !== "qr" || !neteaseState?.qrKey || isLoggedIn) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/netease/login/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: neteaseState.qrKey })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "二维码状态检查失败");
        if (data.loggedIn || data.code === 803 || data.code === 200) {
          const nextState = await refreshNeteaseState();
          setLoginMessage("登录成功，正在同步歌单");
          setLoginOpen(false);
          setNeteaseState(nextState);
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
    setPlayerTitle(track.title || "Agentio");
    setPlayerArtist(track.artist || track.playlistName || "podcast mix");
    setMessage("正在生成播客混音");

    let source = track.podcastAudioUrl || track.outputUrl || "";
    if (!source) {
      const response = await fetch("/api/track/podcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track, prompt: "", voice: "alloy" })
      });
      const data = await response.json();
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
    setDeepFocus(false);
    setJumping(false);
    setSelectedTrack(track);
    setHoveredTrack(track);
    setPlayerTitle(track.title || "Agentio");
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
    setLoginMode(mode);
    setLoginMessage("");
    if (mode !== "qr") return;
    setLoginBusy(true);
    try {
      const response = await fetch("/api/netease/login/start", { method: "POST" });
      const data = await response.json();
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
      const data = await response.json();
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
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        const riskText = data.risk ? "网易云判定手机号云端登录存在风险，请优先使用扫码登录或在 Vercel 配置 NETEASE_COOKIE。" : "";
        throw new Error(riskText || data.error || data.payload?.message || data.payload?.msg || "手机号登录失败");
      }
      const nextState = data.state || (await refreshNeteaseState());
      setNeteaseState(nextState);
      setLoginOpen(false);
      setLoginMessage("");
      flash("网易云登录成功，正在同步歌单");
      await loadNeteaseLibrary().catch(() => null);
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "退出失败");
      setNeteaseState(data);
      setLibraryTracks([]);
      setLoginOpen(false);
      flash("已退出网易云");
    } catch (error) {
      flash(error.message || "退出失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function playTrackFromUi(track) {
    if (!track) return;
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

  function submitSearch(event) {
    event?.preventDefault?.();
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
    const text = `Agentio · ${displayTrack.title || "歌曲"} - ${displayTrack.artist || "未知艺人"}`;
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
      title: displayTrack.title || "Agentio",
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
          Agentio <span className="title-en">Music Cloud</span>
        </div>
        <div className="seg">
          {["歌星", "播客", "歌单", "封面", "年代"].map((mode) => (
            <button key={mode} className={`seg-btn ${viewMode === mode ? "on" : ""}`} onClick={() => selectViewMode(mode)} type="button">
              {mode}
            </button>
          ))}
        </div>
        {["热门", "最近", "更多", "画质·高"].map((mode) => (
          <button key={mode} className={`filter ${sortMode === mode ? "on" : ""}`} onClick={() => selectSortMode(mode)} type="button">
            {mode}
          </button>
        ))}
        <span className="stat">{playlistCount || 0} 歌单 · {libraryTracks.length || 0} 首</span>
        {isLoggedIn ? (
          <div className="login-chip">
            <span>{neteaseState?.profile?.nickname || neteaseState?.uid || "网易云已登录"}</span>
            <button type="button" onClick={logoutNetease} aria-label="退出网易云">退出</button>
          </div>
        ) : (
          <button className="login-entry" onClick={() => openLoginPanel("qr")} type="button">网易云登录</button>
        )}
        <button className="ui-hide-btn" onClick={() => setUiHidden(true)} type="button">隐藏界面 · H</button>
      </header>
      )}

      {uiHidden && <button className="ui-restore" type="button" onClick={() => setUiHidden(false)}>显示界面 · H</button>}

      {!uiHidden && (
      <aside className="search">
        <div className="search-tabs">
          {["歌曲", "寻歌", "探歌", "年代"].map((mode) => (
            <button key={mode} className={`stab ${searchMode === mode ? "on" : ""}`} onClick={() => setSearchMode(mode)} type="button">
              {mode}
            </button>
          ))}
          <button className="stab collapse" onClick={() => setUiHidden((value) => !value)} type="button">⌃</button>
        </div>
        <form onSubmit={submitSearch}>
          <input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${searchMode === "年代" ? "搜索年代" : searchMode === "探歌" ? "搜索歌单/专辑" : "搜索歌曲"}…（回车跃迁到第一个）`} />
        </form>
        {(query || searchMode !== "歌曲") && (
          <div className="search-results">
            {searchResults.length ? searchResults.map((track) => (
              <button key={trackKey(track)} className="search-row" type="button" onClick={() => playTrackFromUi(track)}>
                <span>
                  <span className="sr-name">{track.title}</span>
                  <span className="sr-title">{track.artist}</span>
                </span>
                <span className="sr-meta">{track.year || track.playlistName || "未知"}</span>
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
        tracks={filteredTracks}
        energy={energy}
        playing={isPlaying}
        jumping={jumping}
        deepFocus={deepFocus}
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
        <section className="login-panel" role="dialog" aria-modal="true" aria-label="网易云登录">
          <button className="panel-close" aria-label="关闭登录面板" type="button" onClick={() => setLoginOpen(false)}>×</button>
          <div className="login-title">网易云登录</div>
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
          <p className="login-message">{loginMessage || "登录后会把你的网易云歌单变成星云中的歌曲点。"}</p>
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

      {playerSource && <audio ref={audioRef} src={playerSource} preload="auto" crossOrigin="anonymous" />}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
