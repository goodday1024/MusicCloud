const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("caelumShaoDesktop", {
  platform: process.platform,
  isDesktop: true
});
