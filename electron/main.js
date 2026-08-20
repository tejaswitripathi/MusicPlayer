const { app, BrowserWindow, shell } = require("electron");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const DEFAULT_BASE_URL = "https://commission-clip-shade-instead.trycloudflare.com";
const RELEASES_API_URL = "https://api.github.com/repos/tejaswitripathi/MusicPlayer/releases/latest";
const CONFIG_FILE = path.join(app.getPath("userData"), "musicplayer-config.json");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const OFFLINE_DIR = path.join(app.getPath("userData"), "offline");
const UPDATE_DIR = path.join(app.getPath("userData"), "updates");
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

function localJson(res, status, body) {
    sendResponse(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function collectBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");

            if (!raw) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function safeName(value) {
    return String(value || "")
        .replace(/[^a-z0-9._-]+/ig, "-")
        .replace(/^-+|-+$/g, "") || "item";
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function requestUpstream(pathname, options = {}) {
    return new Promise((resolve, reject) => {
        let upstreamUrl;

        try {
            upstreamUrl = new URL(pathname, API_BASE_URL);
        } catch (error) {
            reject(error);
            return;
        }

        const transport = upstreamUrl.protocol === "https:" ? https : http;
        const request = transport.request(
            upstreamUrl,
            {
                method: options.method || "GET",
                headers: options.headers || {}
            },
            response => resolve(response)
        );

        request.on("error", reject);

        if (options.body) {
            request.write(options.body);
        }

        request.end();
    });
}

function readStreamBody(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}

async function requestUpstreamJson(pathname, cookie) {
    const response = await requestUpstream(pathname, {
        headers: cookie ? { cookie } : {}
    });
    const body = await readStreamBody(response);

    if ((response.statusCode || 500) >= 400) {
        throw new Error(body.toString("utf8") || response.statusMessage || "Request failed");
    }

    return JSON.parse(body.toString("utf8"));
}

function collectionFile(kind, id) {
    return path.join(OFFLINE_DIR, kind, `${safeName(id)}.json`);
}

function trackFile(trackId) {
    return path.join(OFFLINE_DIR, "tracks", `${safeName(trackId)}.audio`);
}

function readOfflineCollections() {
    const out = { albums: [], playlists: [] };

    for (const kind of Object.keys(out)) {
        const dir = path.join(OFFLINE_DIR, kind);

        try {
            out[kind] = fs.readdirSync(dir)
                .filter(name => name.endsWith(".json"))
                .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
                .map(item => item.id)
                .filter(Boolean);
        } catch (error) {
            out[kind] = [];
        }
    }

    return out;
}

function writeOfflineCollection(kind, collection) {
    ensureDir(path.join(OFFLINE_DIR, kind));
    fs.writeFileSync(
        collectionFile(kind, collection.id),
        JSON.stringify(collection, null, 2)
    );
}

async function downloadTrack(track, cookie) {
    ensureDir(path.join(OFFLINE_DIR, "tracks"));

    const filePath = trackFile(track.id);

    if (fs.existsSync(filePath)) {
        return filePath;
    }

    const response = await requestUpstream(`/api/tracks/${encodeURIComponent(track.id)}/stream`, {
        headers: cookie ? { cookie } : {}
    });

    if ((response.statusCode || 500) >= 400) {
        const body = await readStreamBody(response);
        throw new Error(body.toString("utf8") || `Could not download ${track.title || track.id}`);
    }

    await new Promise((resolve, reject) => {
        const tmpPath = `${filePath}.part`;
        const out = fs.createWriteStream(tmpPath);

        response.pipe(out);
        response.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => {
            fs.rename(tmpPath, filePath, error => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    });

    return filePath;
}

async function handleOfflineDownload(req, res) {
    try {
        const body = await collectBody(req);
        const kind = body.kind === "playlists" ? "playlists" : "albums";
        const item = body.item || {};
        const id = item.id;

        if (!id) {
            localJson(res, 400, { detail: "Missing collection id." });
            return;
        }

        const cookie = req.headers.cookie || "";
        const tracksPath = kind === "playlists"
            ? `/api/playlists/${encodeURIComponent(id)}/tracks`
            : `/api/albums/${encodeURIComponent(id)}/tracks`;
        const tracks = await requestUpstreamJson(tracksPath, cookie);

        for (const track of tracks) {
            await downloadTrack(track, cookie);
        }

        const collection = {
            ...item,
            kind,
            id,
            tracks,
            downloadedAt: new Date().toISOString()
        };

        writeOfflineCollection(kind, collection);
        localJson(res, 200, { saved: true, id, kind, tracks: tracks.length });
    } catch (error) {
        localJson(res, 500, { detail: error.message });
    }
}

function sendOfflineTracks(pathname, res) {
    const match = pathname.match(/^\/local\/offline\/(albums|playlists)\/([^/]+)\/tracks$/);

    if (!match) {
        return false;
    }

    try {
        const collection = JSON.parse(
            fs.readFileSync(collectionFile(match[1], decodeURIComponent(match[2])), "utf8")
        );

        localJson(res, 200, collection.tracks || []);
    } catch (error) {
        localJson(res, 404, { detail: "Offline collection not found." });
    }

    return true;
}

function sendOfflineTrack(pathname, req, res) {
    const match = pathname.match(/^\/local\/offline\/tracks\/([^/]+)\/stream$/);

    if (!match) {
        return false;
    }

    const filePath = trackFile(decodeURIComponent(match[1]));

    fs.stat(filePath, (error, stat) => {
        if (error || !stat.isFile()) {
            sendResponse(res, 404, "Offline track not found");
            return;
        }

        const range = req.headers.range;

        if (range) {
            const parsed = range.match(/^bytes=(\d*)-(\d*)$/);
            const start = parsed && parsed[1] ? Number(parsed[1]) : 0;
            const end = parsed && parsed[2] ? Number(parsed[2]) : stat.size - 1;
            const boundedEnd = Math.min(end, stat.size - 1);

            res.writeHead(206, {
                "Accept-Ranges": "bytes",
                "Content-Length": boundedEnd - start + 1,
                "Content-Range": `bytes ${start}-${boundedEnd}/${stat.size}`,
                "Content-Type": "audio/flac"
            });
            fs.createReadStream(filePath, { start, end: boundedEnd }).pipe(res);
            return;
        }

        res.writeHead(200, {
            "Accept-Ranges": "bytes",
            "Content-Length": stat.size,
            "Content-Type": "audio/flac"
        });
        fs.createReadStream(filePath).pipe(res);
    });

    return true;
}

function semverGreater(left, right) {
    const parse = value => String(value || "")
        .replace(/^v/i, "")
        .split(".")
        .map(part => Number.parseInt(part, 10) || 0);
    const a = parse(left);
    const b = parse(right);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) {
            return true;
        }

        if ((a[i] || 0) < (b[i] || 0)) {
            return false;
        }
    }

    return false;
}

function matchingReleaseAsset(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const names = assets.map(asset => ({
        asset,
        name: String(asset.name || "").toLowerCase()
    }));

    if (process.platform === "darwin") {
        return names.find(item => item.name.endsWith(".dmg"))?.asset ||
            names.find(item => item.name.endsWith(".zip"))?.asset;
    }

    if (process.platform === "win32") {
        return names.find(item => item.name.endsWith(".exe"))?.asset;
    }

    if (process.platform === "linux") {
        const arch = process.arch === "arm64" ? "arm64" : "x64";

        return names.find(item => item.name.includes(arch) && item.name.endsWith(".tar.xz"))?.asset ||
            names.find(item => item.name.endsWith(".tar.xz"))?.asset;
    }

    return null;
}

function requestJsonUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                "Accept": "application/vnd.github+json",
                "User-Agent": "MusicPlayer"
            }
        }, response => {
            readStreamBody(response)
                .then(buffer => {
                    if ((response.statusCode || 500) >= 400) {
                        reject(new Error(buffer.toString("utf8") || response.statusMessage));
                        return;
                    }

                    resolve(JSON.parse(buffer.toString("utf8")));
                })
                .catch(reject);
        }).on("error", reject);
    });
}

async function handleReleaseCheck(res) {
    try {
        const release = await requestJsonUrl(RELEASES_API_URL);
        const current = app.getVersion();
        const latest = release.tag_name || release.name || current;
        const asset = matchingReleaseAsset(release);

        localJson(res, 200, {
            current,
            latest,
            available: semverGreater(latest, current) && Boolean(asset),
            asset: asset ? { name: asset.name, url: asset.browser_download_url } : null,
            page: release.html_url
        });
    } catch (error) {
        localJson(res, 200, { available: false, detail: error.message });
    }
}

async function handleReleaseDownload(req, res) {
    try {
        const body = await collectBody(req);
        const asset = body.asset || {};
        const url = asset.url;
        const name = safeName(asset.name || "MusicPlayer-update");

        if (!url) {
            localJson(res, 400, { detail: "Missing release asset." });
            return;
        }

        ensureDir(UPDATE_DIR);

        const filePath = path.join(UPDATE_DIR, name);

        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(filePath);

            https.get(url, { headers: { "User-Agent": "MusicPlayer" } }, response => {
                if ((response.statusCode || 500) >= 400) {
                    readStreamBody(response)
                        .then(buffer => reject(new Error(buffer.toString("utf8") || response.statusMessage)))
                        .catch(reject);
                    return;
                }

                response.pipe(out);
                response.on("error", reject);
                out.on("error", reject);
                out.on("finish", resolve);
            }).on("error", reject);
        });

        localJson(res, 200, { downloaded: true, path: filePath });

        setTimeout(() => {
            shell.openPath(filePath).finally(() => app.quit());
        }, 250);
    } catch (error) {
        localJson(res, 500, { detail: error.message });
    }
}

function handleLocal(req, res) {
    const pathname = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && pathname === "/local/offline") {
        localJson(res, 200, readOfflineCollections());
        return true;
    }

    if (req.method === "POST" && pathname === "/local/offline/download") {
        handleOfflineDownload(req, res);
        return true;
    }

    if (req.method === "GET" && sendOfflineTracks(pathname, res)) {
        return true;
    }

    if (req.method === "GET" && sendOfflineTrack(pathname, req, res)) {
        return true;
    }

    if (req.method === "GET" && pathname === "/local/releases/check") {
        handleReleaseCheck(res);
        return true;
    }

    if (req.method === "POST" && pathname === "/local/releases/download") {
        handleReleaseDownload(req, res);
        return true;
    }

    return false;
}

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

            if (pathname.startsWith("/local/") && handleLocal(req, res)) {
                return;
            }

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
