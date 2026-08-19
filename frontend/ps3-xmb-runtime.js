/* Thin host for linkev/PlayStation-3-XMB (MIT) — see frontend/vendor/ps3xmbwave/. */

window.Ps3XmbRuntime = (function () {
    let canvas = null;
    let gl = null;
    let splineLayer = null;
    let particlesLayer = null;
    let animationId = null;
    let running = false;
    let ready = false;
    let prevFrameMs = 0;
    let splineTimeSec = 0;
    let particlesTimeSec = 0;
    let resizeBound = false;
    let visualizerActive = false;

    function profile() {
        return window.GraphicsProfile?.current?.ps3 || {};
    }

    function targetFps() {
        const ps3Profile = profile();
        const fps = visualizerActive ? ps3Profile.visualizerFps : ps3Profile.fps;

        return Math.max(1, fps || 60);
    }

    function resize() {
        if (!canvas || !gl) {
            return;
        }

        const ps3Profile = profile();
        const maxPixelRatio = ps3Profile.maxPixelRatio || 2;
        const renderScale = ps3Profile.renderScale || 1;
        const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio) * renderScale;
        const width = Math.max(1, window.innerWidth);
        const height = Math.max(1, window.innerHeight);

        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function ensure() {
        if (ready) {
            return true;
        }

        canvas = document.getElementById("ps3-waves");

        if (!canvas) {
            return false;
        }

        if (
            !window.SPLINE_SETTINGS ||
            !window.PARTICLE_SETTINGS ||
            !window.createSplineLayer ||
            !window.createParticlesLayer ||
            !window.PS3SplineReverse
        ) {
            console.error("PS3 XMB vendor scripts are not loaded.");
            return false;
        }

        gl = canvas.getContext("webgl2", {
            antialias: profile().antialias !== false,
            alpha: false,
            powerPreference: "high-performance"
        });

        if (!gl) {
            console.error("WebGL2 is required for the PS3 theme.");
            return false;
        }

        gl.getExtension("OES_texture_float_linear");
        gl.getExtension("EXT_color_buffer_float");

        splineLayer = window.createSplineLayer(gl, canvas);
        particlesLayer = window.createParticlesLayer(gl, canvas);

        particlesTimeSec = Math.random() * 1000;
        ready = true;

        if (!resizeBound) {
            window.addEventListener("resize", () => {
                if (ready) {
                    resize();
                }
            });

            resizeBound = true;
        }

        return true;
    }

    function frame(nowMs) {
        if (!running) {
            animationId = null;
            return;
        }

        animationId = requestAnimationFrame(frame);

        const elapsedMs = nowMs - prevFrameMs;

        if (elapsedMs < (1000 / targetFps()) * 0.9) {
            return;
        }

        prevFrameMs = nowMs;
        const dtSec = Math.max(0, elapsedMs / 1000);
        splineTimeSec += dtSec;
        particlesTimeSec += dtSec;

        splineLayer.render(splineTimeSec);
        particlesLayer.render(particlesTimeSec);
    }

    function setGradientPreset(key) {
        if (window.SPLINE_SETTINGS) {
            window.SPLINE_SETTINGS.gradientPreset = key || "08_day";
        }
    }

    function start(gradientPreset) {
        if (!ensure()) {
            return;
        }

        setGradientPreset(gradientPreset);
        resize();

        if (running) {
            return;
        }

        running = true;
        prevFrameMs = performance.now();
        animationId = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;

        if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    return {
        start: start,
        stop: stop,
        setGradientPreset: setGradientPreset,
        resize: resize,
        setVisualizerActive: value => {
            visualizerActive = Boolean(value);
        }
    };
})();
