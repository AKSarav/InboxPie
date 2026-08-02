import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerIpcHandlers, cancelBackgroundWork } from "./ipc/handlers";
import { prewarmEmbeddingModel, terminateEmbeddingWorker } from "./agent/embeddings";
import { prewarmRerankerModel, terminateRerankerWorker } from "./agent/reranker";
import { inboxPieDb } from "./db/inboxpie-db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the icon path - works in both dev and production
const getIconPath = (): string => {
  // In production (built app), icon is in the app resources
  const productionIcon = path.join(__dirname, "../renderer/assets/icon.png");
  // In dev, use the src directory directly
  const devIcon = path.join(__dirname, "../../src/renderer/assets/icon.png");
  
  try {
    // Try production path first
    const fs = require("fs");
    if (fs.existsSync(productionIcon)) {
      return productionIcon;
    }
    return devIcon;
  } catch {
    return devIcon;
  }
};

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "InboxPie",
    icon: getIconPath(),
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

  // Pre-download the embedding model in the background so the first indexing run
  // doesn't stall on a ~335MB download. Emits `inboxpie:event` so the setup screen
  // can update live without polling (falls back to polling if the window isn't ready yet).
  prewarmEmbeddingModel((status) => {
    console.log(`[embeddings] prewarm: phase=${status.phase}${status.pct != null ? ` pct=${status.pct}` : ""}${status.error ? ` err=${status.error}` : ""}`);
    // Written here (not just inside getSetupStatus) so it's set on EVERY boot that
    // successfully loads the model — getSetupStatus is skipped entirely once
    // app_ready="yes", so relying on it alone left this preference permanently
    // unset for anyone past their first run.
    if (status.phase === "ready") inboxPieDb.setPreference("is_embedding_downloaded", "yes");
    mainWindow?.webContents.send("inboxpie:event", {
      action: "embeddingProgress",
      phase:  status.phase,
      pct:    status.pct ?? (status.phase === "ready" ? 100 : 0),
      error:  status.error,
    });
  }).catch((e) => console.warn("[embeddings] prewarm failed:", (e as Error).message));

  // Same rationale, larger model (~1.1GB quantized) — pre-download the cross-encoder
  // reranker so the first AgentChat semantic search doesn't stall on it mid-conversation.
  prewarmRerankerModel((status) => {
    console.log(`[reranker] prewarm: phase=${status.phase}${status.pct != null ? ` pct=${status.pct}` : ""}${status.error ? ` err=${status.error}` : ""}`);
    if (status.phase === "ready") inboxPieDb.setPreference("is_reranker_downloaded", "yes");
    mainWindow?.webContents.send("inboxpie:event", {
      action: "rerankerProgress",
      phase:  status.phase,
      pct:    status.pct ?? (status.phase === "ready" ? 100 : 0),
      error:  status.error,
    });
  }).catch((e) => console.warn("[reranker] prewarm failed:", (e as Error).message));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Kill scan subprocesses, stop indexing, and terminate the embedding/reranker
  // workers so no threads or processes linger after the app exits.
  cancelBackgroundWork();
  terminateEmbeddingWorker();
  terminateRerankerWorker();
});
