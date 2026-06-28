const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
let mainWindow = null;
let lyricWindow = null;

function sessionFilePath() {
  return path.join(app.getPath("userData"), "caelumshao-session.json");
}

function readDesktopSession() {
  try {
    const raw = fs.readFileSync(sessionFilePath(), "utf8");
    const data = JSON.parse(raw);
    return {
      accountToken: String(data.accountToken || "")
    };
  } catch (_error) {
    return { accountToken: "" };
  }
}

function writeDesktopSession(next = {}) {
  const payload = {
    ...readDesktopSession(),
    ...next,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(sessionFilePath()), { recursive: true });
  fs.writeFileSync(sessionFilePath(), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function createLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) return lyricWindow;
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  lyricWindow = new BrowserWindow({
    width: Math.min(860, Math.max(520, width - 280)),
    height: 150,
    x: Math.max(80, Math.round((width - Math.min(860, Math.max(520, width - 280))) / 2)),
    y: 92,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "云韶悬浮歌词",
    webPreferences: {
      preload: path.join(__dirname, "lyric-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  lyricWindow.setAlwaysOnTop(true, "screen-saver");
  lyricWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lyricWindow.loadFile(path.join(__dirname, "floating-lyrics.html"));
  lyricWindow.on("closed", () => {
    lyricWindow = null;
  });
  return lyricWindow;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: "云韶 CaelumShao",
    backgroundColor: "#04050a",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return mainWindow;
}

app.name = "云韶 CaelumShao";

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
  }
  Menu.setApplicationMenu(null);
  createMainWindow();
  createLyricWindow();

  app.on("activate", () => {
    createMainWindow();
  });
});

ipcMain.on("floating-lyric:update", (_event, payload = {}) => {
  const win = createLyricWindow();
  if (!payload?.lines?.length) {
    win.hide();
    return;
  }
  if (!win.isVisible()) win.showInactive();
  win.webContents.send("floating-lyric:update", payload);
});

ipcMain.on("floating-lyric:hide", () => {
  if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.hide();
});

ipcMain.on("floating-lyric:return-to-app", () => {
  if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.hide();
  const win = createMainWindow();
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send("floating-lyric:return-to-app");
});

ipcMain.handle("account-token:get", () => readDesktopSession().accountToken || "");

ipcMain.handle("account-token:set", (_event, token = "") => {
  writeDesktopSession({ accountToken: String(token || "") });
  return true;
});

ipcMain.handle("account-token:clear", () => {
  writeDesktopSession({ accountToken: "" });
  return true;
});

ipcMain.handle("remote-fetch", async (_event, payload = {}) => {
  const targetUrl = String(payload.url || "");
  if (!/^https:\/\/www\.zihang\.fun\/(?:api|media)(?:\/|$)/.test(targetUrl)) {
    return { ok: false, status: 400, statusText: "Bad Request", headers: {}, body: JSON.stringify({ error: "不允许的桌面端请求地址" }) };
  }
  const init = payload.init || {};
  const response = await fetch(targetUrl, {
    method: init.method || "GET",
    headers: init.headers || {},
    body: init.body || undefined
  });
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
    url: response.url
  };
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
