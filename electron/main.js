const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const DEFAULT_BASE_URL = "https://commission-clip-shade-instead.trycloudflare.com";
const CONFIG_FILE = path.join(app.getPath("userData"), "musicplayer-config.json");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".otf": "font/otf",
    ".opus": "audio/ogg",
    ".png": "image/png",
    ".ttf": "font/ttf",
    ".webp": "image/webp"
};

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

const API_BASE_URL = readConfiguredBaseUrl();

let mainWindow = null;
let frontendServer = null;

function graphicsProfile() {
    if (process.env.MUSICPLAYER_GRAPHICS_PROFILE) {
        return process.env.MUSICPLAYER_GRAPHICS_PROFILE;
    }

    if (process.platform === "linux" && ["arm", "arm64"].includes(process.arch)) {
        return "pi";
    }

    return null;
}

const ACTIVE_GRAPHICS_PROFILE = graphicsProfile();

if (ACTIVE_GRAPHICS_PROFILE === "pi") {
    app.commandLine.appendSwitch("force-device-scale-factor", "1");
    app.commandLine.appendSwitch("high-dpi-support", "1");
}

function loadUrl(localOrigin) {
    try {
        const url = new URL(localOrigin);

        if (ACTIVE_GRAPHICS_PROFILE && !url.searchParams.has("graphics")) {
            url.searchParams.set("graphics", ACTIVE_GRAPHICS_PROFILE);
        }

        return url.toString();
    } catch (error) {
        return localOrigin;
    }
}

function sendResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
}

function staticFilePath(requestUrl) {
    let pathname;

    try {
        pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
    } catch (error) {
        return null;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(FRONTEND_DIR, relativePath);
    const rootPath = path.resolve(FRONTEND_DIR);

    if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) {
        return null;
    }

    return filePath;
}

function serveStatic(req, res) {
    const filePath = staticFilePath(req.url);

    if (!filePath) {
        sendResponse(res, 400, "Bad request");
        return;
    }

    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            sendResponse(res, 404, "Not found");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Length": stat.size,
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
        });

        fs.createReadStream(filePath).pipe(res);
    });
}

function localProxyHeaders(headers) {
    const out = { ...headers };
    const cookies = out["set-cookie"];

    if (Array.isArray(cookies)) {
        out["set-cookie"] = cookies.map(cookie => cookie.replace(/;\s*secure/ig, ""));
    } else if (typeof cookies === "string") {
        out["set-cookie"] = cookies.replace(/;\s*secure/ig, "");
    }

    return out;
}

function proxyApi(req, res) {
    let upstreamUrl;

    try {
        upstreamUrl = new URL(req.url, API_BASE_URL);
    } catch (error) {
        sendResponse(res, 502, "Invalid API base URL");
        return;
    }

    const headers = { ...req.headers, host: upstreamUrl.host };

    delete headers.connection;

    const transport = upstreamUrl.protocol === "https:" ? https : http;
    const proxyReq = transport.request(
        upstreamUrl,
        {
            method: req.method,
            headers: headers
        },
        proxyRes => {
            res.writeHead(proxyRes.statusCode || 502, localProxyHeaders(proxyRes.headers));
            proxyRes.pipe(res);
        }
    );

    proxyReq.on("error", error => {
        if (!res.headersSent) {
            sendResponse(res, 502, `API proxy error: ${error.message}`);
        } else {
            res.destroy(error);
        }
    });

    req.pipe(proxyReq);
}

function startFrontendServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const pathname = new URL(req.url, "http://localhost").pathname;

            if (pathname.startsWith("/api/")) {
                proxyApi(req, res);
                return;
            }

            serveStatic(req, res);
        });

        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            frontendServer = server;
            const address = server.address();

            resolve(`http://127.0.0.1:${address.port}/`);
        });
    });
}

function windowBounds() {
    if (ACTIVE_GRAPHICS_PROFILE === "pi") {
        return {
            width: 1280,
            height: 720,
            minWidth: 800,
            minHeight: 480
        };
    }

    return {
        width: 1180,
        height: 800,
        minWidth: 820,
        minHeight: 560
    };
}

function createWindow(localOrigin) {
    const bounds = windowBounds();

    mainWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        minWidth: bounds.minWidth,
        minHeight: bounds.minHeight,
        useContentSize: ACTIVE_GRAPHICS_PROFILE === "pi",

        backgroundColor: "#111111",
        title: "MusicPlayer",
        titleBarStyle: "hiddenInset",

        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(loadUrl(localOrigin));

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

app.whenReady().then(async () => {
    const localOrigin = await startFrontendServer();

    createWindow(localOrigin);
}).catch(error => {
    console.error("Could not start MusicPlayer:", error);
    app.quit();
});

app.on("window-all-closed", () => {
    if (frontendServer) {
        frontendServer.close();
        frontendServer = null;
    }

    app.quit();
});
