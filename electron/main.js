const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "https://commission-clip-shade-instead.trycloudflare.com";
const CONFIG_FILE = path.join(app.getPath("userData"), "musicplayer-config.json");

function readConfiguredBaseUrl() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf8");
        const config = JSON.parse(raw);
        const value = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";

        if (value) {
            return value;
        }
    } catch (error) {
        // No config file or invalid JSON yet; use the default.
    }

    return process.env.MUSICPLAYER_BASE_URL || DEFAULT_BASE_URL;
}

const BASE_URL = readConfiguredBaseUrl();

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 800,
        minWidth: 820,
        minHeight: 560,

        backgroundColor: "#111111",
        title: "MusicPlayer",
        titleBarStyle: "hiddenInset",

        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(BASE_URL);

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();
});

app.on("window-all-closed", () => {
    app.quit();
});
