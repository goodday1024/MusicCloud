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
  getAccountToken() {
    return ipcRenderer.invoke("account-token:get");
  },
  setAccountToken(token) {
    return ipcRenderer.invoke("account-token:set", token);
  },
  clearAccountToken() {
    return ipcRenderer.invoke("account-token:clear");
  }
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("is-electron");
});
