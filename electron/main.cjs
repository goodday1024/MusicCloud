const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require("electron");
const path = require("node:path");

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
let mainWindow = null;
let lyricWindow = null;

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
