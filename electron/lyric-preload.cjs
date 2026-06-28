const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floatingLyrics", {
  onUpdate(callback) {
    ipcRenderer.on("floating-lyric:update", (_event, payload) => callback(payload));
  },
  returnToApp() {
    ipcRenderer.send("floating-lyric:return-to-app");
  }
});
