const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 8000;
const BASE_URL = `http://${HOST}:${PORT}`;

const HEALTH_TIMEOUT_MS = 1000;
const STARTUP_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 250;

const projectRoot = path.join(__dirname, "..");

// Only set when this process started the server, so quitting never kills a
// uvicorn someone is running themselves.
let backend = null;

let mainWindow = null;


function pythonPath() {
    const inVenv = path.join(projectRoot, ".venv", "bin", "python");

    return fs.existsSync(inVenv) ? inVenv : "python3";
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function backendIsUp() {
    return new Promise(resolve => {
        const request = http.get(`${BASE_URL}/api/health`, response => {
            response.resume();

            resolve(response.statusCode === 200);
        });

        request.on("error", () => resolve(false));

        request.setTimeout(HEALTH_TIMEOUT_MS, () => {
            request.destroy();

            resolve(false);
        });
    });
}

async function startBackend() {
    if (await backendIsUp()) {
        return;
    }

    // No --reload: the reloader runs the server in a child process, which
    // would outlive the signal sent on quit.
    backend = spawn(
        pythonPath(),
        [
            "-m", "uvicorn", "server:app",
            "--host", HOST,
            "--port", String(PORT)
        ],
        {
            cwd: projectRoot,
            stdio: "inherit"
        }
    );

    backend.on("error", error => {
        dialog.showErrorBox(
            "Could not start the backend",
            `Running ${pythonPath()} failed. ${error.message}`
        );
    });

    backend.on("exit", () => {
        backend = null;
    });
}

function stopBackend() {
    if (!backend) {
        return;
    }

    backend.kill("SIGTERM");

    backend = null;
}

async function waitForBackend() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (await backendIsUp()) {
            return true;
        }

        await delay(POLL_INTERVAL_MS);
    }

    return false;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 800,
        minWidth: 820,
        minHeight: 560,

        // Matches the page so resizing does not flash white.
        backgroundColor: "#111111",

        title: "MusicPlayer",

        // Keeps the traffic lights but drops the title bar; the app's own top
        // bar acts as the drag handle.
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

app.whenReady().then(async () => {
    await startBackend();

    const ready = await waitForBackend();

    if (!ready) {
        dialog.showErrorBox(
            "The backend did not start",
            `Nothing answered at ${BASE_URL} within ` +
            `${STARTUP_TIMEOUT_MS / 1000} seconds. Check the terminal output ` +
            `for why uvicorn failed to start.`
        );
    }

    createWindow();
});

app.on("window-all-closed", () => {
    app.quit();
});

app.on("will-quit", stopBackend);

// A crash or a kill should not leave uvicorn running in the background.
process.on("exit", stopBackend);
