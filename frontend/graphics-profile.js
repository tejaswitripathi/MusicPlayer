"use strict";

window.GraphicsProfile = (function () {
    const STORAGE_KEY = "musicplayer.graphicsProfile";

    const profiles = {
        desktop: {
            id: "desktop",
            lowPower: false,
            disableBackdropBlur: false,
            ps3: {
                fps: 60,
                visualizerFps: 60,
                renderScale: 1,
                maxPixelRatio: 2,
                antialias: true,
                gridResolution: 100,
                particleCount: null,
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
            ps3: {
                fps: 30,
                visualizerFps: 10,
                renderScale: 0.7,
                maxPixelRatio: 1,
                antialias: false,
                gridResolution: 72,
                particleCount: 550,
                splineTextureWidth: 128,
                splineTextureHeight: 32,
                splineTextureHz: 18
            },
            oscilloscope: {
                fps: 30,
                maxPixelRatio: 1,
                fftSize: 1024,
                minParticles: 40,
                maxParticles: 70,
                particleArea: 17000,
                waveformPoints: 128,
                smoothRadius: 2,
                maxShockwaves: 2,
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
