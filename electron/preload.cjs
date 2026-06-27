const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("caelumShaoDesktop", {
  platform: process.platform,
  isDesktop: true,
  updateFloatingLyric(payload) {
    ipcRenderer.send("floating-lyric:update", payload);
  },
  hideFloatingLyric() {
    ipcRenderer.send("floating-lyric:hide");
  }
});
