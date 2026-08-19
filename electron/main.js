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

function graphicsProfile() {
    if (process.env.MUSICPLAYER_GRAPHICS_PROFILE) {
        return process.env.MUSICPLAYER_GRAPHICS_PROFILE;
    }

    if (process.platform === "linux" && ["arm", "arm64"].includes(process.arch)) {
        return "pi";
    }

    return null;
}

function loadUrl() {
    const profile = graphicsProfile();

    if (!profile) {
        return BASE_URL;
    }

    try {
        const url = new URL(BASE_URL);

        if (!url.searchParams.has("graphics")) {
            url.searchParams.set("graphics", profile);
        }

        return url.toString();
    } catch (error) {
        return BASE_URL;
    }
}

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

    mainWindow.loadURL(loadUrl());

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

if (process.env.MUSICPLAYER_GPU_DIAGNOSTICS === "1") {
    app.on("gpu-info-update", async () => {
        console.log("Hardware acceleration:", app.isHardwareAccelerationEnabled());
        console.log("GPU features:", app.getGPUFeatureStatus());
        console.log("GPU info:", await app.getGPUInfo("basic"));
    });
}

app.whenReady().then(() => {
    createWindow();
});

app.on("window-all-closed", () => {
    app.quit();
});
