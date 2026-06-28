const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("caelumShaoDesktop", {
  platform: process.platform,
  isDesktop: true,
  updateFloatingLyric(payload) {
    ipcRenderer.send("floating-lyric:update", payload);
  },
  hideFloatingLyric() {
    ipcRenderer.send("floating-lyric:hide");
  },
  onFloatingLyricReturn(callback) {
    const listener = () => callback();
    ipcRenderer.on("floating-lyric:return-to-app", listener);
    return () => ipcRenderer.removeListener("floating-lyric:return-to-app", listener);
  },
  getAccountToken() {
    return ipcRenderer.invoke("account-token:get");
  },
  setAccountToken(token) {
    return ipcRenderer.invoke("account-token:set", token);
  },
  clearAccountToken() {
    return ipcRenderer.invoke("account-token:clear");
  },
  remoteFetch(payload) {
    return ipcRenderer.invoke("remote-fetch", payload);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("is-electron");
});
