"use strict";

window.GraphicsProfile = (function () {
    const STORAGE_KEY = "musicplayer.graphicsProfile";

    const profiles = {
        desktop: {
            id: "desktop",
            lowPower: false,
            disableBackdropBlur: false,
            maxRenderWidth: null,
            maxRenderHeight: null,
            ps3: {
                fps: 60,
                visualizerFps: 60,
                renderScale: 1,
                maxPixelRatio: 2,
                antialias: true,
                gridResolution: 100,
                particleCount: null,
                drawParticles: true,
                simpleDisplacement: false,
                splineTextureWidth: 256,
                splineTextureHeight: 64,
                splineTextureHz: 60
            },
            oscilloscope: {
                fps: 60,
                maxPixelRatio: 2,
                fftSize: 2048,
                minParticles: 60,
                maxParticles: 180,
                particleArea: 8500,
                waveformPoints: 256,
                smoothRadius: 3,
                maxShockwaves: 4,
                fullGlow: true
            }
        },
        pi: {
            id: "pi",
            lowPower: true,
            disableBackdropBlur: true,
            maxRenderWidth: 1280,
            maxRenderHeight: 720,
            ps3: {
                fps: 60,
                visualizerFps: 4,
                renderScale: 1,
                maxPixelRatio: 1,
                antialias: true,
                gridResolution: 100,
                particleCount: 700,
                drawParticles: true,
                simpleDisplacement: false,
                splineTextureWidth: 256,
                splineTextureHeight: 64,
                splineTextureHz: 60,
                wavePasses: 1
            },
            oscilloscope: {
                fps: 60,
                maxPixelRatio: 1,
                fftSize: 2048,
                minParticles: 0,
                maxParticles: 0,
                particleArea: 999999,
                waveformPoints: 256,
                smoothRadius: 3,
                maxShockwaves: 0,
                simpleCurve: false,
                smoothing: 0.34,
                fullGlow: false
            }
        }
    };

    function requestedProfileId() {
        const params = new URLSearchParams(window.location.search);
        const queryValue = params.get("graphics") || params.get("profile");

        if (queryValue) {
            return queryValue;
        }

        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            return null;
        }
    }

    function likelyPi() {
        const hints = [
            navigator.userAgent,
            navigator.platform,
            navigator.userAgentData?.platform
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        return hints.includes("linux") && (
            hints.includes("aarch64") ||
            hints.includes("arm64") ||
            hints.includes("armv7") ||
            hints.includes("armv8")
        );
    }

    function resolveProfile() {
        const requested = String(requestedProfileId() || "").toLowerCase();

        if (profiles[requested]) {
            return profiles[requested];
        }

        return likelyPi() ? profiles.pi : profiles.desktop;
    }

    const current = resolveProfile();

    document.body.classList.toggle("graphics-low-power", current.lowPower);
    document.body.dataset.graphicsProfile = current.id;

    return {
        current,
        profiles,
        storageKey: STORAGE_KEY
    };
})();
