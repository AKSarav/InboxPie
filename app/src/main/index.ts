import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerIpcHandlers, cancelBackgroundWork } from "./ipc/handlers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "InboxPie",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // When the renderer reloads (Cmd+R / dev hot-reload), tear down background work so
  // orphaned scan subprocesses and index loops don't pile up across reloads.
  let hasLoadedOnce = false;
  mainWindow.webContents.on("did-start-loading", () => {
    if (hasLoadedOnce) cancelBackgroundWork();
    hasLoadedOnce = true;
  });
  // A crashed/killed renderer should also stop its background work.
  mainWindow.webContents.on("render-process-gone", () => cancelBackgroundWork());

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Kill scan subprocesses and stop indexing so nothing lingers after the app exits.
  cancelBackgroundWork();
});
