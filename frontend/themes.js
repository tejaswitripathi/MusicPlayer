/* Theme, profile picture, and personalization settings. */

const SETTINGS_KEY = "musicplayer.settings";

const BASIC_THEMES = [
    {
        id: "default-dark",
        name: "Default Dark",
        background: "#111111",
        surface: "#181818",
        raised: "#242424"
    },
    {
        id: "turquoise",
        name: "Turquoise",
        background: "#0a3d40",
        surface: "#0f4a4e",
        raised: "#156065"
    },
    {
        id: "maroon",
        name: "Maroon",
        background: "#3a1018",
        surface: "#4a1620",
        raised: "#5c1c28"
    },
    {
        id: "pine-green",
        name: "Pine Green",
        background: "#14241a",
        surface: "#1a2e22",
        raised: "#223a2c"
    }
];

const EXTREME_THEMES = [
    {
        id: "windows7",
        name: "Windows 7",
        preview: "linear-gradient(135deg, #4a90d9, #8ec8f5 45%, #f5d7a1)"
    },
    {
        id: "ps3",
        name: "PlayStation 3",
        preview: "linear-gradient(135deg, #1a4f8c, #2ec4d6)"
    }
];

/* Authentic PS3 XMB month day/night presets from linkev/PlayStation-3-XMB.
   Labels follow the classic look the picker should communicate. */
const PS3_GRADIENTS = [
    {
        id: "07_day",
        label: "Light blue → cyan",
        start: [0, 167, 146],
        end: [10, 240, 239],
        angle: 26.5
    },
    {
        id: "12_day",
        label: "Red → pink-red",
        start: [236, 68, 45],
        end: [214, 63, 43],
        angle: 170.5
    },
    {
        id: "03_day",
        label: "Light green",
        start: [142, 190, 40],
        end: [104, 168, 22],
        angle: 106
    },
    {
        id: "04_day",
        label: "Dark pink → magenta",
        start: [216, 182, 182],
        end: [231, 66, 117],
        angle: 136.75
    },
    {
        id: "08_day",
        label: "Blue",
        start: [0, 0, 95],
        end: [33, 217, 255],
        angle: 62.5
    },
    {
        id: "08_night",
        label: "Dark blue → navy",
        start: [20, 159, 176],
        end: [0, 0, 31],
        angle: 69.5
    },
    {
        id: "09_day",
        label: "Deep purple",
        start: [146, 44, 155],
        end: [217, 98, 236],
        angle: 148.5
    },
    {
        id: "10_day",
        label: "Orange",
        start: [227, 151, 15],
        end: [224, 187, 2],
        angle: 128.5
    },
    {
        id: "06_day",
        label: "Light purple → lavender",
        start: [198, 120, 238],
        end: [103, 77, 161],
        angle: 148.75
    },
    {
        id: "02_day",
        label: "Yellow → gold",
        start: [203, 158, 13],
        end: [219, 214, 41],
        angle: 67
    },
    {
        id: "05_day",
        label: "Olive → dark green",
        start: [19, 108, 19],
        end: [24, 156, 24],
        angle: 1.5
    },
    {
        id: "11_day",
        label: "Brown → bronze",
        start: [115, 68, 20],
        end: [154, 118, 47],
        angle: 90
    }
];

const LEGACY_PS3_GRADIENT_MAP = {
    "light-blue-cyan": "07_day",
    "red-pink": "12_day",
    "light-green": "03_day",
    "dark-pink-magenta": "04_day",
    "blue": "08_day",
    "dark-blue-navy": "08_night",
    "deep-purple": "09_day",
    "orange": "10_day",
    "light-purple-lavender": "06_day",
    "yellow-gold": "02_day",
    "olive-dark-green": "05_day",
    "brown-bronze": "11_day"
};

const WIN7_OSCOPE = {
    lime: { r: 50, g: 255, b: 50 },
    sky: { r: 70, g: 180, b: 255 }
};

const VISUALIZER_TYPES = new Set(["oscilloscope", "fft-bars", "fft-dots"]);

const defaultSettings = () => ({
    mode: "basic",
    basicTheme: "default-dark",
    extremeTheme: null,
    ps3Gradient: "08_day",
    visualizerType: "oscilloscope",
    oscilloscopeColor: "#ffffff",
    win7Oscilloscope: "lime",
    profilePicture: null,
    hideExtremeWarning: false
});

let settings = loadSettings();
let pendingExtremeTheme = null;

const themePageAudio = new Audio("assets/ps3/page.opus");
const themeBackAudio = new Audio("assets/ps3/back.opus");

themePageAudio.preload = "auto";
themeBackAudio.preload = "auto";


function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);

        if (!raw) {
            return defaultSettings();
        }

        return normalizeSettings({ ...defaultSettings(), ...JSON.parse(raw) });
    } catch (error) {
        return defaultSettings();
    }
}

function normalizeSettings(loaded) {
    if (LEGACY_PS3_GRADIENT_MAP[loaded.ps3Gradient]) {
        loaded.ps3Gradient = LEGACY_PS3_GRADIENT_MAP[loaded.ps3Gradient];
    }

    if (!PS3_GRADIENTS.some(item => item.id === loaded.ps3Gradient)) {
        loaded.ps3Gradient = "08_day";
    }

    if (!VISUALIZER_TYPES.has(loaded.visualizerType)) {
        loaded.visualizerType = "oscilloscope";
    }

    return loaded;
}

const THEME_PREFERENCE_KEYS = [
    "mode",
    "basicTheme",
    "extremeTheme",
    "ps3Gradient",
    "visualizerType",
    "oscilloscopeColor",
    "win7Oscilloscope",
    "hideExtremeWarning"
];

let preferencesTimer = null;

function userSettingsKey(username) {
    return `${SETTINGS_KEY}.${username}`;
}

function themePreferences() {
    const prefs = {};

    THEME_PREFERENCE_KEYS.forEach(key => {
        prefs[key] = settings[key];
    });

    return prefs;
}

function hasThemePrefs(prefs) {
    return THEME_PREFERENCE_KEYS.some(key => prefs[key] !== undefined);
}

function saveSettingsLocalOnly() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

    if (typeof currentUser !== "undefined" && currentUser) {
        localStorage.setItem(
            userSettingsKey(currentUser.username),
            JSON.stringify(settings)
        );
    }
}

function saveSettings() {
    saveSettingsLocalOnly();
    schedulePreferencesSync();
}

function schedulePreferencesSync() {
    if (typeof currentUser === "undefined" || !currentUser) {
        return;
    }

    clearTimeout(preferencesTimer);
    preferencesTimer = setTimeout(pushPreferences, 400);
}

function pushPreferences() {
    if (typeof currentUser === "undefined" || !currentUser) {
        return;
    }

    fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(themePreferences())
    }).catch(() => {});
}

function applyLoadedSettings(loaded) {
    settings = normalizeSettings({ ...defaultSettings(), ...loaded });
    saveSettingsLocalOnly();
    applyTheme();
}

function loadAccountPreferences() {
    if (typeof currentUser === "undefined" || !currentUser) {
        return Promise.resolve();
    }

    try {
        const raw = localStorage.getItem(userSettingsKey(currentUser.username));

        if (raw) {
            applyLoadedSettings({ ...settings, ...JSON.parse(raw) });
        }
    } catch (error) {
        // Keep whatever is already on screen.
    }

    return fetch("/api/preferences")
        .then(readJson)
        .then(prefs => {
            if (hasThemePrefs(prefs)) {
                applyLoadedSettings({ ...settings, ...prefs });
                return;
            }

            pushPreferences();
        })
        .catch(() => {});
}

function hexToRgb(hex) {
    const value = hex.replace("#", "");
    const full = value.length === 3
        ? value.split("").map(ch => ch + ch).join("")
        : value;

    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16)
    };
}

function rgbCss(rgb, alpha) {
    if (alpha === undefined) {
        return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    }

    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function currentOscilloscopeRgb() {
    if (settings.mode === "extreme" && settings.extremeTheme === "windows7") {
        return WIN7_OSCOPE[settings.win7Oscilloscope] || WIN7_OSCOPE.lime;
    }

    return hexToRgb(settings.oscilloscopeColor || "#ffffff");
}

function currentVisualizerType() {
    return VISUALIZER_TYPES.has(settings.visualizerType)
        ? settings.visualizerType
        : "oscilloscope";
}

function applyOscilloscopeCssVars() {
    const rgb = currentOscilloscopeRgb();

    document.documentElement.style.setProperty("--oscope-r", String(rgb.r));
    document.documentElement.style.setProperty("--oscope-g", String(rgb.g));
    document.documentElement.style.setProperty("--oscope-b", String(rgb.b));
}

function clearThemeClasses() {
    const doomed = [];

    document.body.classList.forEach(name => {
        if (name.startsWith("theme-basic-") || name.startsWith("theme-extreme-")) {
            doomed.push(name);
        }
    });

    doomed.forEach(name => document.body.classList.remove(name));
}

function ps3GradientById(id) {
    return PS3_GRADIENTS.find(item => item.id === id) || PS3_GRADIENTS[0];
}

function applyPs3GradientBackground() {
    clearBodyBackgroundImage();

    const backdrop = document.getElementById("theme-backdrop");
    const gradient = ps3GradientById(settings.ps3Gradient);

    if (backdrop) {
        backdrop.style.background =
            `linear-gradient(${gradient.angle}deg, rgb(${gradient.start.join(",")}), rgb(${gradient.end.join(",")}))`;
    }
}

function clearBodyBackgroundImage() {
    document.body.style.backgroundImage = "";
    document.body.style.backgroundAttachment = "";

    const backdrop = document.getElementById("theme-backdrop");

    if (backdrop) {
        backdrop.style.background = "";
    }
}

function ensureWin7Bubbles() {
    const host = document.getElementById("win7-bubbles");

    if (!host || host.childElementCount > 0) {
        return;
    }

    for (let i = 0; i < 18; i++) {
        const bubble = document.createElement("div");

        bubble.className = "win7-bubble";

        const size = 18 + Math.random() * 70;

        bubble.style.width = `${size}px`;
        bubble.style.height = `${size}px`;
        bubble.style.left = `${-10 - Math.random() * 30}vw`;
        bubble.style.top = `${8 + Math.random() * 80}%`;
        bubble.style.setProperty("--bubble-rise", `${-80 + Math.random() * 160}px`);
        bubble.style.animationDuration = `${14 + Math.random() * 22}s`;
        bubble.style.animationDelay = `${-Math.random() * 20}s`;
        bubble.style.opacity = String(0.25 + Math.random() * 0.45);

        host.appendChild(bubble);
    }
}

function stopPs3Waves() {
    if (window.Ps3XmbRuntime) {
        window.Ps3XmbRuntime.stop();
    }
}

function startPs3Waves() {
    if (!window.Ps3XmbRuntime) {
        return;
    }

    const gradient = ps3GradientById(settings.ps3Gradient);

    window.Ps3XmbRuntime.start(gradient.id);
}

function updateThemeBackdropBlur() {
    const libraryVisible = !document.getElementById("library-page")?.classList.contains("hidden");
    const visualizerOpen = typeof openPanel === "string" && openPanel === "visualizer";
    const queueOpen = typeof openPanel === "string" && openPanel === "queue";
    const extreme = settings.mode === "extreme";

    document.body.classList.toggle(
        "theme-backdrop-blur",
        extreme && (!libraryVisible || visualizerOpen || queueOpen)
    );

    document.body.classList.toggle("oscope-open", visualizerOpen);
    document.body.classList.toggle(
        "oscope-extreme",
        visualizerOpen && extreme
    );
}

function applyTheme() {
    clearThemeClasses();
    clearBodyBackgroundImage();
    stopPs3Waves();

    if (settings.mode === "extreme" && settings.extremeTheme === "windows7") {
        document.body.classList.add("theme-extreme-windows7");
        ensureWin7Bubbles();
    } else if (settings.mode === "extreme" && settings.extremeTheme === "ps3") {
        document.body.classList.add("theme-extreme-ps3");
        applyPs3GradientBackground();
        startPs3Waves();
    } else {
        const basic = settings.basicTheme || "default-dark";

        if (basic !== "default-dark") {
            document.body.classList.add(`theme-basic-${basic}`);
        }
    }

    applyOscilloscopeCssVars();
    updateThemeBackdropBlur();
    updateProfileAvatar();
    renderThemePickers();
    renderVisualizersPage();
    renderOscilloscopeColorPage();
}

function playPs3Sound(kind) {
    if (settings.mode !== "extreme" || settings.extremeTheme !== "ps3") {
        return;
    }

    const audio = kind === "back" ? themeBackAudio : themePageAudio;

    audio.currentTime = 0;
    audio.play().catch(() => {});
}

function updateProfileAvatar() {
    const avatar = document.getElementById("user-avatar");
    const fallback = document.getElementById("user-avatar-fallback");
    const preview = document.getElementById("profile-preview-image");
    const removeButton = document.getElementById("remove-profile-picture");
    const picture = settings.profilePicture;

    if (!avatar || !fallback) {
        return;
    }

    if (picture) {
        avatar.src = picture;
        avatar.classList.remove("hidden");
        fallback.classList.add("hidden");

        if (preview) {
            preview.src = picture;
            preview.classList.remove("missing");
        }

        removeButton?.classList.remove("hidden");
    } else {
        avatar.removeAttribute("src");
        avatar.classList.add("hidden");
        fallback.classList.remove("hidden");

        if (preview) {
            preview.removeAttribute("src");
            preview.classList.add("missing");
        }

        removeButton?.classList.add("hidden");
    }
}

function closeUserDropdown() {
    const dropdown = document.getElementById("user-dropdown");
    const button = document.getElementById("user-button");

    dropdown?.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
}

function toggleUserDropdown() {
    const dropdown = document.getElementById("user-dropdown");
    const button = document.getElementById("user-button");

    if (!dropdown || !button) {
        return;
    }

    const open = dropdown.classList.contains("hidden");

    dropdown.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeDialog() {
    document.getElementById("dialog-overlay")?.classList.add("hidden");
    document.getElementById("dialog-extra").textContent = "";
    document.getElementById("dialog-actions").textContent = "";
    pendingExtremeTheme = null;
}

function openDialog({ title, message, extra, actions }) {
    const overlay = document.getElementById("dialog-overlay");

    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-message").textContent = message;

    const extraHost = document.getElementById("dialog-extra");
    const actionsHost = document.getElementById("dialog-actions");

    replaceChildren(extraHost, extra ? [extra] : []);
    replaceChildren(
        actionsHost,
        actions.map(action => {
            const button = element("button", `dialog-button${action.primary ? " primary" : ""}`, action.label);

            button.type = "button";
            button.addEventListener("click", () => action.onClick());

            return button;
        })
    );

    overlay.classList.remove("hidden");
}

function chooseBasicTheme(id) {
    settings.mode = "basic";
    settings.basicTheme = id;
    settings.extremeTheme = null;
    saveSettings();
    applyTheme();
}

function activateExtremeTheme(id) {
    settings.mode = "extreme";
    settings.extremeTheme = id;
    saveSettings();
    applyTheme();
}

function requestExtremeTheme(id) {
    if (id === "ps3") {
        openPs3GradientDialog();
        return;
    }

    if (settings.hideExtremeWarning) {
        activateExtremeTheme(id);
        return;
    }

    pendingExtremeTheme = id;

    const check = element("label", "dialog-check");
    const input = element("input");

    input.type = "checkbox";
    input.id = "hide-extreme-warning";

    check.appendChild(input);
    check.appendChild(document.createTextNode("Don't show this message again"));

    openDialog({
        title: "Extreme theme",
        message:
            "Extreme themes override all other theme choices, including basic colors and oscilloscope settings.",
        extra: check,
        actions: [
            {
                label: "Cancel",
                onClick: closeDialog
            },
            {
                label: "Continue",
                primary: true,
                onClick: () => {
                    if (document.getElementById("hide-extreme-warning")?.checked) {
                        settings.hideExtremeWarning = true;
                        saveSettings();
                    }

                    const themeId = pendingExtremeTheme;

                    closeDialog();

                    if (themeId) {
                        activateExtremeTheme(themeId);
                    }
                }
            }
        ]
    });
}

function openPs3GradientDialog() {
    const warnFirst = !settings.hideExtremeWarning &&
        !(settings.mode === "extreme" && settings.extremeTheme === "ps3");

    function showPicker() {
        const shell = element("div");
        shell.id = "ps3-gradient-picker";

        shell.appendChild(element("h3", null, "Select Background"));

        const grid = element("div", "ps3-gradient-grid");
        let selected = settings.ps3Gradient;

        PS3_GRADIENTS.forEach(gradient => {
            const swatch = element("button", "ps3-gradient-swatch");

            swatch.type = "button";
            swatch.title = gradient.label;
            swatch.style.background =
                `linear-gradient(${gradient.angle}deg, rgb(${gradient.start.join(",")}), rgb(${gradient.end.join(",")}))`;

            if (gradient.id === selected) {
                swatch.classList.add("selected");
            }

            swatch.addEventListener("click", () => {
                selected = gradient.id;

                grid.querySelectorAll(".ps3-gradient-swatch").forEach(node => {
                    node.classList.toggle("selected", node === swatch);
                });
            });

            grid.appendChild(swatch);
        });

        shell.appendChild(grid);

        openDialog({
            title: "PlayStation 3",
            message: "Choose a background gradient for the XMB waves.",
            extra: shell,
            actions: [
                {
                    label: "Cancel",
                    onClick: closeDialog
                },
                {
                    label: "Apply",
                    primary: true,
                    onClick: () => {
                        settings.ps3Gradient = selected;
                        closeDialog();
                        activateExtremeTheme("ps3");
                    }
                }
            ]
        });
    }

    if (!warnFirst) {
        showPicker();
        return;
    }

    pendingExtremeTheme = "ps3";

    const check = element("label", "dialog-check");
    const input = element("input");

    input.type = "checkbox";
    input.id = "hide-extreme-warning";

    check.appendChild(input);
    check.appendChild(document.createTextNode("Don't show this message again"));

    openDialog({
        title: "Extreme theme",
        message:
            "Extreme themes override all other theme choices, including basic colors and oscilloscope settings.",
        extra: check,
        actions: [
            {
                label: "Cancel",
                onClick: closeDialog
            },
            {
                label: "Continue",
                primary: true,
                onClick: () => {
                    if (document.getElementById("hide-extreme-warning")?.checked) {
                        settings.hideExtremeWarning = true;
                        saveSettings();
                    }

                    closeDialog();
                    showPicker();
                }
            }
        ]
    });
}

function setOscilloscopeColor(hex) {
    settings.oscilloscopeColor = hex;

    // Leaving an extreme theme via the color wheel always lands on default dark.
    if (settings.mode === "extreme") {
        settings.mode = "basic";
        settings.basicTheme = "default-dark";
        settings.extremeTheme = null;
    }

    saveSettings();
    applyTheme();
}

function setWin7Oscilloscope(kind) {
    if (!WIN7_OSCOPE[kind]) {
        return;
    }

    settings.win7Oscilloscope = kind;
    saveSettings();
    applyOscilloscopeCssVars();
    renderOscilloscopeColorPage();
}

function setVisualizerType(type) {
    if (!VISUALIZER_TYPES.has(type)) {
        return;
    }

    settings.visualizerType = type;
    saveSettings();
    renderVisualizersPage();
}

function buildThemePreviewCard(options) {
    const card = element("button", "theme-preview-card");

    card.type = "button";

    if (options.selected) {
        card.classList.add("selected");
    }

    const frame = element("div", "theme-preview-frame");

    frame.style.background = options.background;

    frame.appendChild(element("div", "theme-preview-mini-bar"));

    const shelves = element("div", "theme-preview-shelves");

    for (let i = 0; i < 2; i++) {
        shelves.appendChild(element("div", "theme-preview-shelf-label"));

        const tiles = element("div", "theme-preview-tiles");

        for (let j = 0; j < 4; j++) {
            const tile = element("div", "theme-preview-tile");

            tile.style.background = options.tile || "rgba(255,255,255,0.18)";
            tiles.appendChild(tile);
        }

        shelves.appendChild(tiles);
    }

    frame.appendChild(shelves);
    card.appendChild(frame);
    card.appendChild(element("div", "theme-preview-name", options.name));

    card.addEventListener("click", options.onClick);

    return card;
}

function renderThemePickers() {
    const basicGrid = document.getElementById("basic-theme-grid");
    const extremeGrid = document.getElementById("extreme-theme-grid");

    if (basicGrid) {
        replaceChildren(
            basicGrid,
            BASIC_THEMES.map(theme => buildThemePreviewCard({
                name: theme.name,
                background: theme.background,
                tile: theme.raised,
                selected:
                    settings.mode === "basic" &&
                    settings.basicTheme === theme.id,
                onClick: () => chooseBasicTheme(theme.id)
            }))
        );
    }

    if (extremeGrid) {
        replaceChildren(
            extremeGrid,
            EXTREME_THEMES.map(theme => buildThemePreviewCard({
                name: theme.name,
                background: theme.preview,
                selected:
                    settings.mode === "extreme" &&
                    settings.extremeTheme === theme.id,
                onClick: () => requestExtremeTheme(theme.id)
            }))
        );
    }
}

function renderOscilloscopeColorPage() {
    const input = document.getElementById("oscilloscope-color-input");
    const win7Options = document.getElementById("win7-oscilloscope-options");
    const win7Toggle = document.getElementById("win7-oscope-toggle");
    const onWin7 =
        settings.mode === "extreme" && settings.extremeTheme === "windows7";

    if (input) {
        input.value = settings.oscilloscopeColor || "#ffffff";
    }

    if (win7Options) {
        win7Options.classList.toggle("hidden", !onWin7);

        win7Options.querySelectorAll("[data-win7-oscope]").forEach(button => {
            button.classList.toggle(
                "active",
                button.dataset.win7Oscope === settings.win7Oscilloscope
            );
        });
    }

    if (win7Toggle) {
        win7Toggle.classList.toggle("hidden", !onWin7);

        win7Toggle.querySelectorAll("[data-win7-oscope]").forEach(button => {
            button.classList.toggle(
                "active",
                button.dataset.win7Oscope === settings.win7Oscilloscope
            );
        });
    }
}

function renderVisualizersPage() {
    document.querySelectorAll("[data-visualizer-type]").forEach(button => {
        button.classList.toggle(
            "selected",
            button.dataset.visualizerType === currentVisualizerType()
        );
    });
}

function setProfilePicture(dataUrl) {
    settings.profilePicture = dataUrl;
    saveSettings();
    updateProfileAvatar();
}

function removeProfilePicture() {
    settings.profilePicture = null;
    saveSettings();
    updateProfileAvatar();
}

function readImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function showProfile() {
    showPage("profile-page");
    updateProfileAvatar();

    const name = document.getElementById("profile-username");

    if (name) {
        name.textContent = currentUser ? currentUser.username : "";
    }
}

function showPersonalization() {
    showPage("personalization-page");
}

function showThemes() {
    showPage("themes-page");
}

function showVisualizers() {
    showPage("visualizers-page");
    renderVisualizersPage();
}

function showBasicThemes() {
    showPage("basic-themes-page");
    renderThemePickers();
}

function showExtremeThemes() {
    showPage("extreme-themes-page");
    renderThemePickers();
}

function showOscilloscopeColor() {
    showPage("oscilloscope-color-page");
    renderOscilloscopeColorPage();
}

function wirePersonalizationUi() {
    const userButton = document.getElementById("user-button");
    const dropdown = document.getElementById("user-dropdown");
    const profileFile = document.getElementById("profile-file");

    userButton?.addEventListener("click", event => {
        event.stopPropagation();
        toggleUserDropdown();
    });

    dropdown?.addEventListener("click", event => {
        const item = event.target.closest("[data-action]");

        if (!item) {
            return;
        }

        closeUserDropdown();

        if (item.dataset.action === "login") {
            openView(showLogin);
        } else if (item.dataset.action === "profile") {
            openView(showProfile);
        } else if (item.dataset.action === "personalization") {
            openView(showPersonalization);
        }
    });

    document.addEventListener("click", event => {
        if (!event.target.closest("#user-menu-wrap")) {
            closeUserDropdown();
        }
    });

    document.getElementById("open-themes")?.addEventListener("click", () => {
        openView(showThemes);
    });

    document.getElementById("open-visualizers")?.addEventListener("click", () => {
        openView(showVisualizers);
    });

    document.getElementById("open-oscilloscope-color")?.addEventListener("click", () => {
        openView(showOscilloscopeColor);
    });

    document.getElementById("visualizer-options")?.addEventListener("click", event => {
        const option = event.target.closest("[data-visualizer-type]");

        if (option) {
            setVisualizerType(option.dataset.visualizerType);
        }
    });

    document.getElementById("open-basic-themes")?.addEventListener("click", () => {
        openView(showBasicThemes);
    });

    document.getElementById("open-extreme-themes")?.addEventListener("click", () => {
        openView(showExtremeThemes);
    });

    document.getElementById("change-profile-picture")?.addEventListener("click", () => {
        profileFile.value = "";
        profileFile.click();
    });

    document.getElementById("remove-profile-picture")?.addEventListener("click", () => {
        removeProfilePicture();
    });

    profileFile?.addEventListener("change", () => {
        const file = profileFile.files[0];

        if (!file) {
            return;
        }

        readImageFile(file)
            .then(setProfilePicture)
            .catch(() => {});
    });

    document.getElementById("oscilloscope-color-input")?.addEventListener("input", event => {
        setOscilloscopeColor(event.target.value);
    });

    document.getElementById("win7-oscilloscope-options")?.addEventListener("click", event => {
        const chip = event.target.closest("[data-win7-oscope]");

        if (chip) {
            event.preventDefault();
            event.stopPropagation();
            setWin7Oscilloscope(chip.dataset.win7Oscope);
        }
    });

    document.getElementById("win7-oscope-toggle")?.addEventListener("click", event => {
        const chip = event.target.closest("[data-win7-oscope]");

        if (chip) {
            event.preventDefault();
            event.stopPropagation();
            setWin7Oscilloscope(chip.dataset.win7Oscope);
        }
    });

    document.getElementById("dialog-overlay")?.addEventListener("click", event => {
        if (event.target.id === "dialog-overlay") {
            closeDialog();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeUserDropdown();

            if (!document.getElementById("dialog-overlay")?.classList.contains("hidden")) {
                closeDialog();
            }
        }
    });

    window.addEventListener("resize", () => {
        if (
            settings.mode === "extreme" &&
            settings.extremeTheme === "ps3" &&
            window.Ps3XmbRuntime
        ) {
            window.Ps3XmbRuntime.resize();
        }
    });
}
