const SEARCH_DEBOUNCE_MS = 140;
const LIBRARY_REFRESH_FLOOR_MS = 8000;

const player = document.getElementById("audio-player");
const playerBar = document.getElementById("player-bar");
const playPauseButton = document.getElementById("play-pause-button");
const previousButton = document.getElementById("previous-button");
const nextButton = document.getElementById("next-button");
const progressBar = document.getElementById("progress-bar");
const currentTimeElement = document.getElementById("current-time");
const durationElement = document.getElementById("duration");
const visualizerToggle = document.getElementById("visualizer-toggle");

const libraryTab = document.getElementById("library-tab");
const searchTab = document.getElementById("search-tab");
const searchInput = document.getElementById("search-input");
const searchResultsElement = document.getElementById("search-results");
const playlistsRow = document.getElementById("playlists");
const albumsRow = document.getElementById("albums");
const artistsRow = document.getElementById("artists");
const detailTracksElement = document.getElementById("detail-tracks");
const detailAlbumsElement = document.getElementById("detail-albums");
const playlistActions = document.getElementById("playlist-actions");
const changeCoverButton = document.getElementById("change-cover");
const coverFileInput = document.getElementById("cover-file");
const queueListElement = document.getElementById("queue-list");
const discFilters = document.getElementById("disc-filters");
const menuOverlay = document.getElementById("menu-overlay");
const menuElement = document.getElementById("menu");

let playlists = [];

// Queue entries wrap a track because the same song can sit in the queue more
// than once; an id per entry is what tells those copies apart.
let queue = [];
let currentEntryId = null;
let nextEntryId = 1;

let currentTrack = null;

// The playlist whose page is open, so its own tracks can offer to leave it.
let openPlaylist = null;

// The track list on show, split into discs, and which of them is selected.
let listOptions = {};
let listGroups = [];
let activeGroup = 0;

let searchResults = emptyResults();
let activeFilter = "songs";
let searchTimer = null;
let libraryLoadedAt = 0;

// Responses can come back out of order while typing; only the newest counts.
let searchSequence = 0;

let audioContext = null;
let audioSource = null;
let analyser = null;

let oscilloscopeAnimationId = null;
let oscilloscopeParticles = [];
let oscilloscopeShockwaves = [];
let oscilloscopeEnergySlow = 0;
let oscilloscopeEnergyFast = 0;
let oscilloscopePulse = 0;
let oscilloscopeWidth = 0;
let oscilloscopeHeight = 0;

if (navigator.userAgent.includes("Electron")) {
    document.body.classList.add("desktop");
}


/* Building blocks */

function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined && text !== null) {
        node.textContent = text;
    }

    return node;
}

function artwork(url, className) {
    const art = element("div", className ? `art ${className}` : "art");

    const image = element("img");

    image.alt = "";
    image.loading = "lazy";

    // Not every album, playlist or artist has a picture on the server. The
    // placeholder behind the image shows through when one is missing.
    image.addEventListener("error", () => {
        image.classList.add("missing");
    });

    if (url) {
        image.src = versioned(url);
    } else {
        image.classList.add("missing");
    }

    art.appendChild(image);

    return art;
}

function tile(coverUrl, title, subtitle, artClassName) {
    const node = element("div", "tile");

    node.appendChild(artwork(coverUrl, artClassName));
    node.appendChild(element("div", "tile-title", title || "Unknown"));

    if (subtitle) {
        node.appendChild(element("div", "tile-subtitle", subtitle));
    }

    return node;
}

function resultRow(coverUrl, title, subtitle, artClassName) {
    const row = element("div", "result");

    row.appendChild(artwork(coverUrl, artClassName));

    const text = element("div", "result-text");

    text.appendChild(element("div", "result-title", title || "Unknown"));

    if (subtitle) {
        text.appendChild(element("div", "result-subtitle", subtitle));
    }

    row.appendChild(text);

    return row;
}

function replaceChildren(container, nodes) {
    container.textContent = "";

    nodes.forEach(node => container.appendChild(node));
}

function message(container, className, text) {
    replaceChildren(container, [element("p", className, text)]);
}

/* Row menus

   One popup, moved to whichever row was clicked. The actions offered depend
   on where the song is being seen from: a playlist can drop it, the queue can
   drop it, anywhere can add it. */

function openMenu(anchor, items) {
    replaceChildren(
        menuElement,
        items.map(item => {
            const button = element("button", "menu-item", item.label);

            button.addEventListener("click", () => {
                closeMenu();

                item.action();
            });

            return button;
        })
    );

    menuOverlay.classList.remove("hidden");

    // Measured after being shown, so it can be flipped above the row or
    // pulled back from the edge when there is no space below.
    const anchorBox = anchor.getBoundingClientRect();
    const menuBox = menuElement.getBoundingClientRect();

    let left = anchorBox.right - menuBox.width;
    let top = anchorBox.bottom + 6;

    if (top + menuBox.height > window.innerHeight - 8) {
        top = anchorBox.top - menuBox.height - 6;
    }

    menuElement.style.left = `${Math.max(8, left)}px`;
    menuElement.style.top = `${Math.max(8, top)}px`;
}

function closeMenu() {
    menuOverlay.classList.add("hidden");
}

menuOverlay.addEventListener("click", closeMenu);

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeMenu();
    }
});

function menuButton(buildItems) {
    const button = element("button", "row-menu", "⋮");

    button.type = "button";
    button.setAttribute("aria-label", "More actions");

    button.addEventListener("click", event => {
        // The row underneath would otherwise start playing the song.
        event.stopPropagation();

        openMenu(button, buildItems());
    });

    return button;
}

function trackMenuItems(track, context) {
    const items = [
        {
            label: "Add to playlist",
            action: () => {
                // The panel would otherwise cover the page being opened.
                closePanel();

                openView(() => showAddToPlaylist(track));
            }
        },
        {
            label: "Add to queue",
            action: () => addToQueue(track)
        }
    ];

    if (context.playlistId) {
        items.push({
            label: "Remove from playlist",
            action: () => removeFromPlaylist(context)
        });
    }

    if (context.entryId) {
        items.push({
            label: "Remove from queue",
            action: () => removeFromQueue(context.entryId)
        });
    }

    return items;
}

function trackRow(track, number, context) {
    const row = element("div", "track");

    row.dataset.trackId = track.id;

    if (context.entryId) {
        row.dataset.entryId = context.entryId;
    }

    row.appendChild(element("span", "track-number", number));
    row.appendChild(element("span", "track-title", track.title));

    if (context.showArtist) {
        row.appendChild(element("span", "track-artist", track.artist));
    }

    row.appendChild(
        element("span", "track-duration", formatDuration(track.duration))
    );

    row.appendChild(menuButton(() => trackMenuItems(track, context)));

    row.addEventListener("click", context.onPlay);

    return row;
}


function formatDuration(seconds) {
    return typeof seconds === "number" ? formatTime(seconds) : "";
}


function readJson(response) {
    if (response.status === 401) {
        const path = new URL(response.url, window.location.origin).pathname;

        if (path !== "/api/login") {
            forgetSession();
        }
    }

    if (response.ok) {
        return response.json();
    }

    return response
        .json()
        .catch(() => {
            throw new Error(response.statusText);
        })
        .then(body => {
            const detail = body.detail;
            const message = typeof detail === "string"
                ? detail
                : response.statusText;

            throw new Error(message);
        });
}


/* Navigation

   Each screen is a function that redraws itself, so going back can replay the
   previous one rather than having to remember what was on it. */

let currentView = null;
const viewHistory = [];

function showPage(id) {
    document.querySelectorAll(".page").forEach(page => {
        page.classList.toggle("hidden", page.id !== id);
    });

    window.scrollTo(0, 0);

    if (typeof updateThemeBackdropBlur === "function") {
        updateThemeBackdropBlur();
    }
}

function openView(view) {
    if (currentView) {
        viewHistory.push(currentView);
    }

    currentView = view;

    if (typeof playPs3Sound === "function") {
        playPs3Sound("page");
    }

    view();
}

function openTab(view) {
    viewHistory.length = 0;

    currentView = view;

    view();
}

function goBack() {
    if (typeof playPs3Sound === "function") {
        playPs3Sound("back");
    }

    const previous = viewHistory.pop();

    if (!previous) {
        openTab(showLibrary);

        return;
    }

    currentView = previous;

    previous();
}

document.addEventListener("click", event => {
    if (event.target.classList.contains("back-button")) {
        goBack();
    }
});


/* Tabs */

function setActiveTab(tab) {
    libraryTab.classList.toggle("active", tab === libraryTab);
    searchTab.classList.toggle("active", tab === searchTab);
}

libraryTab.addEventListener("click", () => {
    searchInput.classList.add("hidden");
    searchInput.value = "";

    searchResults = emptyResults();

    openTab(showLibrary);
});

searchTab.addEventListener("click", () => {
    searchInput.classList.remove("hidden");
    searchInput.focus();

    openTab(showSearch);
});


/* Library */

function showLibrary() {
    setActiveTab(libraryTab);
    showPage("library-page");

    loadLibrary();
}

function loadLibrary() {
    // Opening the tab and regaining focus both land here, and alt-tabbing
    // can do that in bursts, so repeats within a few seconds are dropped.
    if (!currentUser) {
        return;
    }

    if (Date.now() - libraryLoadedAt < LIBRARY_REFRESH_FLOOR_MS) {
        return;
    }

    libraryLoadedAt = Date.now();

    loadPlaylists();
    loadAlbums();
    loadArtists();
}

// Music added to the Jellyfin folder while the window sat in the background
// should be there on the way back in.
window.addEventListener("focus", loadLibrary);

function loadPlaylists() {
    fetch("/api/playlists")
        .then(readJson)
        .then(loaded => {
            playlists = loaded;

            renderPlaylists();
        })
        .catch(error => {
            renderPlaylists();

            playlistsRow.appendChild(
                element(
                    "p",
                    "error",
                    `Could not load playlists. ${error.message}`
                )
            );
        });
}

function renderPlaylists() {
    const tiles = [newPlaylistTile()];

    playlists.forEach(playlist => {
        const node = tile(playlist.cover_url, playlist.name);

        node.addEventListener("click", () => {
            openView(() => showPlaylist(playlist));
        });

        tiles.push(node);
    });

    replaceChildren(playlistsRow, tiles);

    refreshShelves();
}

function newPlaylistTile() {
    const node = tile(null, "New");

    node.classList.add("new-playlist");

    node.addEventListener("click", () => {
        if (!node.querySelector("input")) {
            startNewPlaylist(node);
        }
    });

    return node;
}

function startNewPlaylist(node) {
    const input = element("input", "new-playlist-input");

    input.type = "text";
    input.placeholder = "Name";

    node.querySelector(".tile-title").replaceWith(input);

    input.focus();

    let settled = false;

    function cancel() {
        if (settled) {
            return;
        }

        settled = true;

        renderPlaylists();
    }

    input.addEventListener("click", event => event.stopPropagation());

    input.addEventListener("blur", cancel);

    input.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            cancel();

            return;
        }

        if (event.key !== "Enter") {
            return;
        }

        const name = input.value.trim();

        if (!name) {
            cancel();

            return;
        }

        settled = true;

        input.disabled = true;

        createPlaylist(name);
    });
}

function createPlaylist(name) {
    fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name })
    })
        .then(readJson)
        .then(loadPlaylists)
        .catch(error => {
            renderPlaylists();

            playlistsRow.appendChild(
                element(
                    "p",
                    "error",
                    `Could not create the playlist. ${error.message}`
                )
            );
        });
}

function loadAlbums() {
    fetch("/api/albums")
        .then(readJson)
        .then(albums => {
            replaceChildren(
                albumsRow,
                albums.map(album => {
                    const node = tile(
                        album.cover_url,
                        album.title,
                        album.artist
                    );

                    node.addEventListener("click", () => {
                        openView(() => showAlbum(album));
                    });

                    return node;
                })
            );

            refreshShelves();
        })
        .catch(error => {
            message(
                albumsRow,
                "error",
                `Could not load albums. ${error.message}`
            );
        });
}

function loadArtists() {
    fetch("/api/artists")
        .then(readJson)
        .then(artists => {
            replaceChildren(
                artistsRow,
                artists.map(artist => {
                    const node = tile(
                        artist.cover_url,
                        artist.name,
                        null,
                        "round"
                    );

                    node.addEventListener("click", () => {
                        openView(() => showArtist(artist));
                    });

                    return node;
                })
            );

            refreshShelves();
        })
        .catch(error => {
            message(
                artistsRow,
                "error",
                `Could not load artists. ${error.message}`
            );
        });
}


/* Horizontal shelves */

const shelfRefreshers = [];

function setupShelf(scroller) {
    const row = scroller.querySelector(".row");
    const left = scroller.querySelector(".scroll-left");
    const right = scroller.querySelector(".scroll-right");

    function refresh() {
        const furthest = row.scrollWidth - row.clientWidth;

        left.disabled = row.scrollLeft <= 1;
        right.disabled = row.scrollLeft >= furthest - 1;
    }

    function step(direction) {
        row.scrollBy({
            left: direction * row.clientWidth * 0.8,
            behavior: "smooth"
        });
    }

    left.addEventListener("click", () => step(-1));
    right.addEventListener("click", () => step(1));

    row.addEventListener("scroll", refresh);
    window.addEventListener("resize", refresh);

    shelfRefreshers.push(refresh);

    refresh();
}

function refreshShelves() {
    shelfRefreshers.forEach(refresh => refresh());
}

document
    .querySelectorAll(".shelf-scroller")
    .forEach(setupShelf);


/* Detail pages */

function setDetailHeader(kind, title, subtitle, coverUrl, round) {
    document.getElementById("detail-kind").textContent = kind;
    document.getElementById("detail-title").textContent = title || "Unknown";
    document.getElementById("detail-subtitle").textContent = subtitle || "";

    const art = document.getElementById("detail-art");
    const cover = document.getElementById("detail-cover");

    art.classList.toggle("round", Boolean(round));

    cover.classList.remove("missing");

    if (coverUrl) {
        cover.src = versioned(coverUrl);
    } else {
        cover.classList.add("missing");
        cover.removeAttribute("src");
    }
}

function showTrackListPage(url, options) {
    detailAlbumsElement.classList.add("hidden");
    detailTracksElement.classList.remove("hidden");
    discFilters.classList.add("hidden");

    message(detailTracksElement, "empty", "Loading…");

    listOptions = options;
    listGroups = [];
    activeGroup = 0;

    fetch(url)
        .then(readJson)
        .then(tracks => {
            if (!tracks.length) {
                message(detailTracksElement, "empty", "Nothing here yet.");

                return;
            }

            listGroups = options.splitDiscs ? discsOf(tracks) : [{
                label: null,
                tracks: tracks
            }];

            if (options.splitDiscs && listGroups.length > 1) {
                renderDiscFilters();
            }

            renderTrackList();
        })
        .catch(error => {
            message(
                detailTracksElement,
                "error",
                `Could not load tracks. ${error.message}`
            );
        });
}

/* A track list split by disc, in disc order. */

function discsOf(tracks) {
    const groups = new Map();

    tracks.forEach(track => {
        // Single-disc albums report disc 0 or nothing at all, and both mean
        // the same thing: these songs are not on a numbered disc.
        const disc = track.disc || null;

        if (!groups.has(disc)) {
            groups.set(disc, []);
        }

        groups.get(disc).push(track);
    });

    const numbered = [...groups.keys()]
        .filter(disc => disc !== null)
        .sort((a, b) => a - b);

    const ordered = numbered.map(disc => {
        const group = groups.get(disc);
        const labelled = group.find(track => track.disc_label);

        return {
            label: labelled ? labelled.disc_label : `Disc ${disc}`,
            tracks: group
        };
    });

    // Anything untagged trails the numbered discs rather than vanishing from
    // a filter that has no pill for it.
    if (groups.has(null)) {
        ordered.push({ label: "Other", tracks: groups.get(null) });
    }

    return ordered;
}

function renderDiscFilters() {
    replaceChildren(
        discFilters,
        listGroups.map((group, index) => {
            const button = element("button", "filter", group.label);

            button.classList.toggle("active", index === activeGroup);

            button.addEventListener("click", () => {
                activeGroup = index;

                renderDiscFilters();
                renderTrackList();
            });

            return button;
        })
    );

    discFilters.classList.remove("hidden");
}

function renderTrackList() {
    const shown = listGroups.length > 1
        ? listGroups[activeGroup].tracks
        : listGroups[0].tracks;

    replaceChildren(
        detailTracksElement,
        shown.map((track, index) => trackRow(
            track,
            // An album lists its own track numbers. Anywhere else a song's
            // place on its album means nothing, so rows count from where
            // they actually sit.
            listOptions.playlistId
                ? index + 1
                : track.track_number || index + 1,
            {
                showArtist: listOptions.showArtist,
                playlistId: listOptions.playlistId,
                playlistItemId: track.playlist_item_id,
                onPlay: () => playFrom(shown, index)
            }
        ))
    );

    highlightPlayingTrack();
}

function showAlbum(album) {
    showPage("detail-page");

    openPlaylist = null;

    playlistActions.classList.add("hidden");
    changeCoverButton.classList.add("hidden");

    const subtitle = [album.artist, album.year]
        .filter(Boolean)
        .join(" • ");

    setDetailHeader("Album", album.title, subtitle, album.cover_url, false);

    showTrackListPage(`/api/albums/${album.id}/tracks`, {
        showArtist: false,
        splitDiscs: true
    });
}

function showPlaylist(playlist) {
    showPage("detail-page");

    openPlaylist = playlist;

    playlistActions.classList.remove("hidden");
    changeCoverButton.classList.remove("hidden");

    setDetailHeader("Playlist", playlist.name, "", playlist.cover_url, false);

    showTrackListPage(`/api/playlists/${playlist.id}/tracks`, {
        showArtist: true,
        playlistId: playlist.id
    });
}

function removeFromPlaylist(context) {
    fetch(
        `/api/playlists/${context.playlistId}/items/${context.playlistItemId}`,
        { method: "DELETE" }
    )
        .then(readJson)
        // Redrawing the page it came from is what refreshes the list.
        .then(() => currentView())
        .catch(error => {
            message(
                detailTracksElement,
                "error",
                `Could not remove the song. ${error.message}`
            );
        });
}

function showArtist(artist) {
    showPage("detail-page");

    openPlaylist = null;

    playlistActions.classList.add("hidden");
    changeCoverButton.classList.add("hidden");

    setDetailHeader("Artist", artist.name, "", artist.cover_url, true);

    discFilters.classList.add("hidden");
    detailTracksElement.classList.add("hidden");
    detailAlbumsElement.classList.remove("hidden");

    message(detailAlbumsElement, "empty", "Loading…");

    fetch(`/api/artists/${artist.id}/albums`)
        .then(readJson)
        .then(albums => {
            if (!albums.length) {
                message(detailAlbumsElement, "empty", "No albums found.");

                return;
            }

            replaceChildren(
                detailAlbumsElement,
                albums.map(album => {
                    const node = tile(
                        album.cover_url,
                        album.title,
                        album.year ? String(album.year) : null
                    );

                    node.addEventListener("click", () => {
                        openView(() => showAlbum(album));
                    });

                    return node;
                })
            );
        })
        .catch(error => {
            message(
                detailAlbumsElement,
                "error",
                `Could not load albums. ${error.message}`
            );
        });
}


/* Search */

function emptyResults() {
    return { songs: [], albums: [], artists: [] };
}

function showSearch() {
    setActiveTab(searchTab);
    showPage("search-page");

    renderSearchResults();
}

searchInput.addEventListener("input", () => {
    // Typing anywhere is enough to bring up the results.
    if (currentView !== showSearch) {
        openTab(showSearch);
    }

    clearTimeout(searchTimer);

    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
});

function runSearch() {
    const query = searchInput.value.trim();

    if (!query) {
        searchResults = emptyResults();

        renderSearchResults();

        return;
    }

    // Results already on screen stay put until they can be replaced, so
    // narrowing a query does not flicker. An empty pane says something is
    // happening, which the first search needs: the server has to read the
    // whole library before it can answer.
    if (!searchResultsElement.querySelector(".results, .grid")) {
        message(searchResultsElement, "empty", "Searching…");
    }

    const sequence = ++searchSequence;

    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(readJson)
        .then(results => {
            if (sequence !== searchSequence) {
                return;
            }

            searchResults = results;

            renderSearchResults();
        })
        .catch(error => {
            if (sequence !== searchSequence) {
                return;
            }

            message(
                searchResultsElement,
                "error",
                `Could not search. ${error.message}`
            );
        });
}

document.querySelectorAll(".filter").forEach(button => {
    button.addEventListener("click", () => {
        activeFilter = button.dataset.filter;

        document.querySelectorAll(".filter").forEach(other => {
            other.classList.toggle("active", other === button);
        });

        renderSearchResults();
    });
});

function renderSearchResults() {
    if (!searchInput.value.trim()) {
        message(
            searchResultsElement,
            "empty",
            "Start typing to search your library."
        );

        return;
    }

    if (activeFilter === "songs") {
        renderSongResults();
    } else if (activeFilter === "albums") {
        renderAlbumResults();
    } else {
        renderArtistResults();
    }
}

function renderSongResults() {
    const songs = searchResults.songs;

    if (!songs.length) {
        message(searchResultsElement, "empty", "No songs match.");

        return;
    }

    const list = element("div", "results");

    songs.forEach((song, index) => {
        const row = resultRow(
            song.cover_url,
            song.title,
            [song.artist, song.album].filter(Boolean).join(" • ")
        );

        row.dataset.trackId = song.id;

        row.appendChild(
            element("span", "track-duration", formatDuration(song.duration))
        );

        row.appendChild(menuButton(() => trackMenuItems(song, {})));

        row.addEventListener("click", () => {
            playFrom(songs, index);
        });

        list.appendChild(row);
    });

    replaceChildren(searchResultsElement, [list]);
}

function renderAlbumResults() {
    const albums = searchResults.albums;

    if (!albums.length) {
        message(searchResultsElement, "empty", "No albums match.");

        return;
    }

    const grid = element("div", "grid");

    albums.forEach(album => {
        const node = tile(album.cover_url, album.title, album.artist);

        node.addEventListener("click", () => {
            openView(() => showAlbum(album));
        });

        grid.appendChild(node);
    });

    replaceChildren(searchResultsElement, [grid]);
}

function renderArtistResults() {
    const artists = searchResults.artists;

    if (!artists.length) {
        message(searchResultsElement, "empty", "No artists match.");

        return;
    }

    const grid = element("div", "grid");

    artists.forEach(artist => {
        const node = tile(artist.cover_url, artist.name, null, "round");

        node.addEventListener("click", () => {
            openView(() => showArtist(artist));
        });

        grid.appendChild(node);
    });

    replaceChildren(searchResultsElement, [grid]);
}


/* Player panels

   The queue and the visualizer both grow up out of the player bar, and only
   one of them can hold that space, so opening one waits for the other to
   finish collapsing. */

const PANEL_ANIMATION_MS = 280;

const queuePanel = document.getElementById("queue-panel");
const visualizerPanel = document.getElementById("visualizer-panel");
const queueToggle = document.getElementById("queue-toggle");

let openPanel = null;
let panelTimer = null;

function togglePanel(name) {
    clearTimeout(panelTimer);

    if (openPanel === name) {
        closePanel();

        return;
    }

    if (openPanel) {
        closePanel();

        panelTimer = setTimeout(() => showPanel(name), PANEL_ANIMATION_MS);

        return;
    }

    showPanel(name);
}

function showPanel(name) {
    openPanel = name;

    if (name === "queue") {
        renderQueue();

        queuePanel.classList.add("open");
    } else {
        visualizerPanel.classList.add("open");

        startOscilloscope();
    }

    markToggles();

    if (typeof updateThemeBackdropBlur === "function") {
        updateThemeBackdropBlur();
    }
}

function closePanel() {
    if (openPanel === "visualizer") {
        stopOscilloscope();
    }

    openPanel = null;

    queuePanel.classList.remove("open");
    visualizerPanel.classList.remove("open");

    markToggles();

    if (typeof updateThemeBackdropBlur === "function") {
        updateThemeBackdropBlur();
    }
}

function markToggles() {
    queueToggle.classList.toggle("active", openPanel === "queue");

    visualizerToggle.classList.toggle("active", openPanel === "visualizer");
    visualizerToggle.textContent = openPanel === "visualizer" ? "▼" : "▲";
}

queueToggle.addEventListener("click", () => togglePanel("queue"));

visualizerToggle.addEventListener("click", () => togglePanel("visualizer"));


/* Queue */

function renderQueue() {
    if (!queue.length) {
        message(queueListElement, "empty", "The queue is empty.");

        return;
    }

    replaceChildren(
        queueListElement,
        queue.map((entry, index) => trackRow(entry.track, index + 1, {
            showArtist: true,
            entryId: entry.id,
            onPlay: () => {
                currentEntryId = entry.id;

                playTrack(entry.track);
            }
        }))
    );

    highlightPlayingTrack();
}


/* Add to playlist */

function showAddToPlaylist(track) {
    showPage("add-to-playlist-page");

    document.getElementById("add-to-playlist-title").textContent = track.title;

    const container = document.getElementById("playlist-choices");

    message(container, "empty", "Loading…");

    Promise.all([
        fetch("/api/playlists").then(readJson),
        fetch(`/api/tracks/${track.id}/playlists`).then(readJson)
    ])
        .then(([all, holding]) => {
            playlists = all;

            renderPlaylistChoices(track, all, new Set(holding));
        })
        .catch(error => {
            message(
                container,
                "error",
                `Could not load playlists. ${error.message}`
            );
        });
}

function renderPlaylistChoices(track, all, holding) {
    const container = document.getElementById("playlist-choices");

    const rows = [newPlaylistChoice(track)];

    all.forEach(playlist => {
        // A label means the whole row toggles, not just the box itself.
        const row = element("label", "choice");

        const box = element("input");

        box.type = "checkbox";
        box.checked = holding.has(playlist.id);

        box.addEventListener("change", () => {
            box.disabled = true;

            const wanted = box.checked;

            const change = wanted
                ? addSongToPlaylist(playlist.id, track.id)
                : removeSongFromPlaylist(playlist.id, track.id);

            change
                .then(() => {
                    box.disabled = false;
                })
                .catch(error => {
                    // Put the box back the way it was; the server disagreed.
                    box.checked = !wanted;
                    box.disabled = false;

                    container.appendChild(
                        element(
                            "p",
                            "error",
                            `Could not update ${playlist.name}. ${error.message}`
                        )
                    );
                });
        });

        row.appendChild(box);
        row.appendChild(element("span", "choice-name", playlist.name));

        rows.push(row);
    });

    replaceChildren(container, rows);
}

function newPlaylistChoice(track) {
    const row = element("div", "choice");

    row.appendChild(element("span", "choice-plus", "+"));
    row.appendChild(element("span", "choice-name", "New playlist"));

    row.addEventListener("click", () => {
        if (row.querySelector("input")) {
            return;
        }

        const input = element("input", "new-playlist-input");

        input.type = "text";
        input.placeholder = "Name";

        row.querySelector(".choice-name").replaceWith(input);

        input.focus();

        let settled = false;

        function cancel() {
            if (settled) {
                return;
            }

            settled = true;

            currentView();
        }

        input.addEventListener("click", event => event.stopPropagation());

        input.addEventListener("blur", cancel);

        input.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                cancel();

                return;
            }

            if (event.key !== "Enter") {
                return;
            }

            const name = input.value.trim();

            if (!name) {
                cancel();

                return;
            }

            settled = true;

            input.disabled = true;

            fetch("/api/playlists", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: name })
            })
                .then(readJson)
                .then(playlist => addSongToPlaylist(playlist.id, track.id))
                .then(() => {
                    loadPlaylists();

                    currentView();
                })
                .catch(error => {
                    message(
                        document.getElementById("playlist-choices"),
                        "error",
                        `Could not create the playlist. ${error.message}`
                    );
                });
        });
    });

    return row;
}

function addSongToPlaylist(playlistId, trackId) {
    return fetch(`/api/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_ids: [trackId] })
    }).then(readJson);
}

function removeSongFromPlaylist(playlistId, trackId) {
    // Removal is by entry, so the playlist has to be read to find which
    // entries hold this song. A song added twice has two of them.
    return fetch(`/api/playlists/${playlistId}/tracks`)
        .then(readJson)
        .then(tracks => Promise.all(
            tracks
                .filter(track => track.id === trackId)
                .map(track => fetch(
                    `/api/playlists/${playlistId}/items/${track.playlist_item_id}`,
                    { method: "DELETE" }
                ).then(readJson))
        ));
}


/* Add songs to a playlist */

let addSongsPlaylist = null;
let addSongsHeld = new Set();
let addSongsTimer = null;
let addSongsSequence = 0;

const addSongsInput = document.getElementById("add-songs-input");
const addSongsResults = document.getElementById("add-songs-results");

function showAddSongs(playlist) {
    showPage("add-songs-page");

    addSongsPlaylist = playlist;

    document.getElementById("add-songs-title").textContent = playlist.name;

    message(addSongsResults, "empty", "Search for songs to add.");

    addSongsInput.value = "";
    addSongsInput.focus();

    // Songs already in the playlist come back marked, so nothing gets added
    // to it twice by accident.
    fetch(`/api/playlists/${playlist.id}/tracks`)
        .then(readJson)
        .then(tracks => {
            addSongsHeld = new Set(tracks.map(track => track.id));
        })
        .catch(() => {
            addSongsHeld = new Set();
        });
}

addSongsInput.addEventListener("input", () => {
    clearTimeout(addSongsTimer);

    addSongsTimer = setTimeout(runAddSongsSearch, SEARCH_DEBOUNCE_MS);
});

function runAddSongsSearch() {
    const query = addSongsInput.value.trim();

    if (!query) {
        message(addSongsResults, "empty", "Search for songs to add.");

        return;
    }

    if (!addSongsResults.querySelector(".results")) {
        message(addSongsResults, "empty", "Searching…");
    }

    const sequence = ++addSongsSequence;

    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(readJson)
        .then(results => {
            if (sequence !== addSongsSequence) {
                return;
            }

            renderAddSongsResults(results.songs);
        })
        .catch(error => {
            if (sequence === addSongsSequence) {
                message(
                    addSongsResults,
                    "error",
                    `Could not search. ${error.message}`
                );
            }
        });
}

function renderAddSongsResults(songs) {
    if (!songs.length) {
        message(addSongsResults, "empty", "No songs match.");

        return;
    }

    const list = element("div", "results");

    songs.forEach(song => {
        const row = resultRow(
            song.cover_url,
            song.title,
            [song.artist, song.album].filter(Boolean).join(" • ")
        );

        const held = addSongsHeld.has(song.id);

        const button = element(
            "button",
            held ? "add-button added" : "add-button",
            held ? "Added" : "Add"
        );

        button.addEventListener("click", event => {
            event.stopPropagation();

            if (addSongsHeld.has(song.id)) {
                return;
            }

            button.disabled = true;

            addSongToPlaylist(addSongsPlaylist.id, song.id)
                .then(() => {
                    addSongsHeld.add(song.id);

                    button.textContent = "Added";
                    button.classList.add("added");
                    button.disabled = false;
                })
                .catch(error => {
                    button.disabled = false;

                    addSongsResults.appendChild(
                        element(
                            "p",
                            "error",
                            `Could not add the song. ${error.message}`
                        )
                    );
                });
        });

        row.appendChild(
            element("span", "track-duration", formatDuration(song.duration))
        );

        row.appendChild(button);

        row.addEventListener("click", () => button.click());

        list.appendChild(row);
    });

    replaceChildren(addSongsResults, [list]);
}

document.getElementById("add-songs-button").addEventListener("click", () => {
    if (openPlaylist) {
        const playlist = openPlaylist;

        openView(() => showAddSongs(playlist));
    }
});


/* Playlist cover */

const CROP_MAX_WIDTH = 620;
const CROP_MAX_HEIGHT = 420;
const CROP_MIN_SIZE = 40;
const CROP_OUTPUT = 800;

const cropImage = document.getElementById("crop-image");
const cropStage = document.getElementById("crop-stage");
const cropSelection = document.getElementById("crop-selection");

let cropPlaylist = null;

// The image as drawn on screen, and the square selected within it. Both are
// in display pixels; saving scales them back up to the original.
let cropWidth = 0;
let cropHeight = 0;
let selection = { x: 0, y: 0, size: 0 };

// Bumped after an upload so the browser re-fetches artwork it has cached.
let coverVersion = 0;

function versioned(url) {
    if (!url || !coverVersion) {
        return url;
    }

    return `${url}?v=${coverVersion}`;
}

changeCoverButton.addEventListener("click", () => {
    // Cleared so choosing the same file twice still counts as a change.
    coverFileInput.value = "";

    coverFileInput.click();
});

coverFileInput.addEventListener("change", () => {
    const file = coverFileInput.files[0];

    if (!file || !openPlaylist) {
        return;
    }

    const playlist = openPlaylist;
    const source = URL.createObjectURL(file);

    openView(() => showCrop(playlist, source));
});

function showCrop(playlist, source) {
    showPage("crop-page");

    cropPlaylist = playlist;

    cropImage.onload = layoutCrop;
    cropImage.src = source;
}

function layoutCrop() {
    // The whole picture is shown, shrunk to fit the work area but never
    // enlarged past its own size.
    const fit = Math.min(
        CROP_MAX_WIDTH / cropImage.naturalWidth,
        CROP_MAX_HEIGHT / cropImage.naturalHeight,
        1
    );

    cropWidth = Math.round(cropImage.naturalWidth * fit);
    cropHeight = Math.round(cropImage.naturalHeight * fit);

    cropStage.style.width = `${cropWidth}px`;
    cropStage.style.height = `${cropHeight}px`;

    // Start on the biggest square the picture allows, centred.
    const size = Math.min(cropWidth, cropHeight);

    selection = {
        x: (cropWidth - size) / 2,
        y: (cropHeight - size) / 2,
        size: size
    };

    applySelection();
}

function applySelection() {
    cropSelection.style.left = `${selection.x}px`;
    cropSelection.style.top = `${selection.y}px`;
    cropSelection.style.width = `${selection.size}px`;
    cropSelection.style.height = `${selection.size}px`;
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function moveSelection(x, y) {
    selection.x = clamp(x, 0, cropWidth - selection.size);
    selection.y = clamp(y, 0, cropHeight - selection.size);

    applySelection();
}

function resizeSelection(handle, pointerX, pointerY) {
    // Each corner drags against the one opposite it, which stays put.
    const right = selection.x + selection.size;
    const bottom = selection.y + selection.size;

    let size;

    if (handle === "se") {
        size = Math.min(pointerX - selection.x, pointerY - selection.y);
        size = clamp(size, CROP_MIN_SIZE, Math.min(
            cropWidth - selection.x,
            cropHeight - selection.y
        ));
    } else if (handle === "ne") {
        size = Math.min(pointerX - selection.x, bottom - pointerY);
        size = clamp(size, CROP_MIN_SIZE, Math.min(
            cropWidth - selection.x,
            bottom
        ));

        selection.y = bottom - size;
    } else if (handle === "sw") {
        size = Math.min(right - pointerX, pointerY - selection.y);
        size = clamp(size, CROP_MIN_SIZE, Math.min(
            right,
            cropHeight - selection.y
        ));

        selection.x = right - size;
    } else {
        size = Math.min(right - pointerX, bottom - pointerY);
        size = clamp(size, CROP_MIN_SIZE, Math.min(right, bottom));

        selection.x = right - size;
        selection.y = bottom - size;
    }

    selection.size = size;

    applySelection();
}

let cropDrag = null;

function cornerOf(handle) {
    const right = selection.x + selection.size;
    const bottom = selection.y + selection.size;

    if (handle === "nw") {
        return [selection.x, selection.y];
    }

    if (handle === "ne") {
        return [right, selection.y];
    }

    if (handle === "sw") {
        return [selection.x, bottom];
    }

    return [right, bottom];
}

cropSelection.addEventListener("pointerdown", event => {
    const stage = cropStage.getBoundingClientRect();

    const handle = event.target.dataset.handle;

    // Where the grab landed within what is being dragged, so nothing jumps
    // to sit under the cursor.
    const [anchorX, anchorY] = handle
        ? cornerOf(handle)
        : [selection.x, selection.y];

    cropDrag = {
        handle: handle,
        offsetX: event.clientX - stage.left - anchorX,
        offsetY: event.clientY - stage.top - anchorY
    };

    cropSelection.setPointerCapture(event.pointerId);

    event.preventDefault();
});

cropSelection.addEventListener("pointermove", event => {
    if (!cropDrag) {
        return;
    }

    const stage = cropStage.getBoundingClientRect();

    const x = event.clientX - stage.left - cropDrag.offsetX;
    const y = event.clientY - stage.top - cropDrag.offsetY;

    if (cropDrag.handle) {
        resizeSelection(cropDrag.handle, x, y);
    } else {
        moveSelection(x, y);
    }
});

function endCropDrag() {
    cropDrag = null;
}

cropSelection.addEventListener("pointerup", endCropDrag);
cropSelection.addEventListener("pointercancel", endCropDrag);

document.getElementById("crop-save").addEventListener("click", () => {
    // Back from display pixels to the image's own.
    const scale = cropImage.naturalWidth / cropWidth;

    const canvas = element("canvas");

    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;

    canvas.getContext("2d").drawImage(
        cropImage,
        selection.x * scale,
        selection.y * scale,
        selection.size * scale,
        selection.size * scale,
        0,
        0,
        CROP_OUTPUT,
        CROP_OUTPUT
    );

    canvas.toBlob(
        blob => {
            fetch(`/api/playlists/${cropPlaylist.id}/image`, {
                method: "POST",
                headers: { "Content-Type": "image/jpeg" },
                body: blob
            })
                .then(readJson)
                .then(() => {
                    coverVersion = Date.now();

                    loadPlaylists();

                    goBack();
                })
                .catch(error => {
                    document.getElementById("crop-hint").textContent =
                        `Could not save the cover. ${error.message}`;
                });
        },
        "image/jpeg",
        0.92
    );
});


/* Playback */

function queueEntry(track) {
    return { id: `entry-${nextEntryId++}`, track: track };
}

function playFrom(tracks, index) {
    queue = tracks.map(queueEntry);

    currentEntryId = queue[index].id;

    playTrack(queue[index].track);
}

function currentQueuePosition() {
    return queue.findIndex(entry => entry.id === currentEntryId);
}

function addToQueue(track) {
    const entry = queueEntry(track);

    queue.push(entry);

    // Adding a song with nothing playing starts it, rather than quietly
    // filling a queue that never begins.
    if (currentEntryId === null) {
        currentEntryId = entry.id;

        playTrack(entry.track);
    }

    renderQueue();
}

function removeFromQueue(entryId) {
    const position = queue.findIndex(entry => entry.id === entryId);

    if (position === -1) {
        return;
    }

    queue.splice(position, 1);

    if (entryId !== currentEntryId) {
        renderQueue();

        return;
    }

    // Dropping whatever is playing moves on to what followed it.
    if (queue.length) {
        const next = queue[Math.min(position, queue.length - 1)];

        currentEntryId = next.id;

        playTrack(next.track);
    } else {
        currentEntryId = null;

        player.pause();
    }

    renderQueue();
}

function playTrack(track) {
    setupAudioAnalyser();

    if (audioContext && audioContext.state === "suspended") {
        audioContext.resume();
    }

    currentTrack = track;

    player.src = `/api/tracks/${track.id}/stream`;

    document.getElementById("now-playing-title").textContent =
        track.title || "";

    document.getElementById("now-playing-subtitle").textContent =
        [track.artist, track.album].filter(Boolean).join(" • ");

    const cover = document.getElementById("now-playing-cover");

    if (track.cover_url) {
        cover.src = track.cover_url;
    } else {
        cover.removeAttribute("src");
    }

    playerBar.classList.remove("hidden");

    player.play();

    highlightPlayingTrack();
}

function highlightPlayingTrack() {
    const playingId = currentTrack ? currentTrack.id : null;

    detailTracksElement.querySelectorAll(".track").forEach(row => {
        row.classList.toggle("playing", row.dataset.trackId === playingId);
    });

    queueListElement.querySelectorAll(".track").forEach(row => {
        row.classList.toggle("playing", row.dataset.entryId === currentEntryId);
    });
}

function skip(offset) {
    const next = currentQueuePosition() + offset;

    if (next < 0 || next >= queue.length) {
        return;
    }

    currentEntryId = queue[next].id;

    playTrack(queue[next].track);
}

playPauseButton.addEventListener("click", () => {
    if (player.paused) {
        player.play();
    } else {
        player.pause();
    }
});

nextButton.addEventListener("click", () => skip(1));
previousButton.addEventListener("click", () => skip(-1));

player.addEventListener("ended", () => skip(1));

player.addEventListener("play", () => {
    playPauseButton.textContent = "⏸";
});

player.addEventListener("pause", () => {
    playPauseButton.textContent = "▶";
});

function formatTime(seconds) {
    if (isNaN(seconds)) {
        return "0:00";
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

player.addEventListener("timeupdate", () => {
    currentTimeElement.textContent = formatTime(player.currentTime);

    if (!isNaN(player.duration)) {
        progressBar.value = (player.currentTime / player.duration) * 100;
    }
});

player.addEventListener("loadedmetadata", () => {
    durationElement.textContent = formatTime(player.duration);
});

progressBar.addEventListener("input", () => {
    if (!isNaN(player.duration)) {
        player.currentTime = (progressBar.value / 100) * player.duration;
    }
});

document.addEventListener("keydown", event => {
    if (event.code !== "Space") {
        return;
    }

    const tag = event.target.tagName;

    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") {
        return;
    }

    event.preventDefault();

    if (player.paused) {
        player.play();
    } else {
        player.pause();
    }
});

document.addEventListener("click", event => {
    if (event.target.tagName === "BUTTON") {
        event.target.blur();
    }
});


/* Visualizer */

function setupAudioAnalyser() {
    if (audioContext !== null) {
        return;
    }

    audioContext = new AudioContext();

    audioSource = audioContext.createMediaElementSource(player);

    analyser = audioContext.createAnalyser();

    analyser.fftSize = 2048;

    audioSource.connect(analyser);

    analyser.connect(audioContext.destination);
}

function seedOscilloscopeParticles(width, height) {
    const area = width * height;
    const count = Math.min(180, Math.max(60, Math.round(area / 8500)));
    const centerX = width / 2;
    const centerY = height / 2;
    const spreadX = width * 0.42;
    const spreadY = height * 0.13;

    oscilloscopeParticles = [];

    for (let i = 0; i < count; i++) {
        const orb = Math.random() < 0.18;
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random());

        oscilloscopeParticles.push({
            x: centerX + Math.cos(angle) * radius * spreadX,
            y: centerY + Math.sin(angle) * radius * spreadY,
            radius: orb ? 2.4 + Math.random() * 3.2 : 0.7 + Math.random() * 1.5,
            alpha: orb ? 0.06 + Math.random() * 0.1 : 0.14 + Math.random() * 0.32,
            driftX: (Math.random() - 0.5) * (orb ? 0.1 : 0.22),
            driftY: (Math.random() - 0.5) * (orb ? 0.06 : 0.12),
            vx: 0,
            vy: 0,
            phase: Math.random() * Math.PI * 2,
            orb
        });
    }
}

function startOscilloscope() {
    setupAudioAnalyser();

    const canvas = document.getElementById("oscilloscope");

    const ctx = canvas.getContext("2d");

    const bufferLength = analyser.fftSize;

    const dataArray = new Uint8Array(bufferLength);

    oscilloscopeEnergySlow = 0;
    oscilloscopeEnergyFast = 0;
    oscilloscopePulse = 0;
    oscilloscopeShockwaves = [];


    function draw(now) {
        if (openPanel !== "visualizer") {
            return;
        }

        oscilloscopeAnimationId = requestAnimationFrame(draw);

        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const pixelRatio = window.devicePixelRatio || 1;

        if (width < 8 || height < 8) {
            return;
        }

        if (width !== oscilloscopeWidth || height !== oscilloscopeHeight) {
            canvas.width = width * pixelRatio;
            canvas.height = height * pixelRatio;

            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

            if (
                oscilloscopeParticles.length === 0 ||
                oscilloscopeWidth < 8 ||
                oscilloscopeHeight < 8
            ) {
                seedOscilloscopeParticles(width, height);
            } else {
                const scaleX = width / oscilloscopeWidth;
                const scaleY = height / oscilloscopeHeight;

                for (const particle of oscilloscopeParticles) {
                    particle.x *= scaleX;
                    particle.y *= scaleY;
                }
            }

            oscilloscopeWidth = width;
            oscilloscopeHeight = height;
        }

        analyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0;
        let peak = 0;

        for (let i = 0; i < bufferLength; i++) {
            const sample = (dataArray[i] - 128) / 128;
            const amplitude = Math.abs(sample);

            sumSquares += sample * sample;

            if (amplitude > peak) {
                peak = amplitude;
            }
        }

        // RMS sits well below 1 for real music; scale so typical loud
        // passages fill the range. Peak catches the sharpest transients.
        const rms = Math.sqrt(sumSquares / bufferLength);
        const energy = Math.min(1, rms * 2.6 + peak * 0.22);

        oscilloscopeEnergyFast += (energy - oscilloscopeEnergyFast) * 0.42;
        oscilloscopeEnergySlow += (energy - oscilloscopeEnergySlow) * 0.055;

        // A spike/drop is a sudden lift of the fast envelope above the
        // slower ambient level — quiet into loud, or a hard transient.
        const onset = Math.max(0, oscilloscopeEnergyFast - oscilloscopeEnergySlow - 0.035);

        if (onset > 0.07) {
            oscilloscopePulse = Math.min(1, oscilloscopePulse + onset * 2.6);

            if (onset > 0.11 && oscilloscopeShockwaves.length < 4) {
                oscilloscopeShockwaves.push({
                    radius: 18,
                    alpha: 0.13 + onset * 0.33,
                    width: 1 + onset * 1.4
                });
            }
        }

        oscilloscopePulse *= 0.9;
        oscilloscopePulse = Math.max(oscilloscopePulse, energy * 0.38);

        const pulse = oscilloscopePulse;
        const centerX = width / 2;
        const centerY = height / 2;
        const tone = typeof currentOscilloscopeRgb === "function"
            ? currentOscilloscopeRgb()
            : { r: 255, g: 255, b: 255 };

        ctx.clearRect(0, 0, width, height);

        // Elliptical bloom whose alpha hits 0 at the gradient edge, so
        // nothing is clipped to a hard oval.
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.scale(1.55, 0.62);

        const glowRadius = Math.max(width, height) * (0.28 + pulse * 0.1);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);

        glow.addColorStop(0, rgbCss(tone, 0.096 + pulse * 0.204));
        glow.addColorStop(0.45, rgbCss(tone, 0.036 + pulse * 0.084));
        glow.addColorStop(1, rgbCss(tone, 0));

        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        for (let i = oscilloscopeShockwaves.length - 1; i >= 0; i--) {
            const wave = oscilloscopeShockwaves[i];

            wave.radius += 10 + pulse * 14;
            wave.alpha *= 0.93;

            if (wave.alpha < 0.02 || wave.radius > Math.max(width, height)) {
                oscilloscopeShockwaves.splice(i, 1);
                continue;
            }

            ctx.beginPath();
            ctx.ellipse(
                centerX,
                centerY,
                wave.radius,
                wave.radius * 0.42,
                0,
                0,
                Math.PI * 2
            );
            ctx.strokeStyle = rgbCss(tone, wave.alpha);
            ctx.lineWidth = wave.width;
            ctx.stroke();
        }

        const time = now * 0.001;
        const bandX = width * 0.46;
        const bandY = height * 0.16;

        for (const particle of oscilloscopeParticles) {
            const dx = particle.x - centerX;
            const dy = particle.y - centerY;
            const distance = Math.hypot(dx, dy) || 1;
            const nx = dx / bandX;
            const ny = dy / bandY;
            const outside = nx * nx + ny * ny;

            const burst = pulse * 5.5 / (1 + distance * 0.014);

            particle.vx += (dx / distance) * burst * 0.65;
            particle.vy += (dy / distance) * burst * 0.2;

            for (const wave of oscilloscopeShockwaves) {
                const ringGap = Math.abs(distance - wave.radius);

                if (ringGap < 48) {
                    const shove = (1 - ringGap / 48) * wave.alpha * 1.6;

                    particle.vx += (dx / distance) * shove;
                    particle.vy += (dy / distance) * shove * 0.35;
                }
            }

            particle.vx -= nx * 0.12;
            particle.vy -= ny * 0.18;

            if (outside > 1) {
                particle.vx -= nx * 0.4;
                particle.vy -= ny * 0.4;
            }

            particle.vx *= 0.88;
            particle.vy *= 0.88;

            particle.x += particle.vx + particle.driftX;
            particle.y += particle.vy + particle.driftY;

            const twinkle = 0.72 + 0.28 * Math.sin(particle.phase + time * 1.7);
            const alpha = Math.min(1, particle.alpha * twinkle * (1 + pulse * 1.55));
            const radius = particle.radius * (1 + pulse * 0.45);

            ctx.beginPath();
            ctx.fillStyle = rgbCss(tone, alpha);
            ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.beginPath();

        const sliceWidth = width / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const sample = (dataArray[i] - 128) / 128;
            const position = i / (bufferLength - 1);
            const envelope = Math.pow(Math.sin(Math.PI * position), 1.5);
            const y = centerY + sample * centerY * envelope * (0.9 + pulse * 0.22);

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }

            x += sliceWidth;
        }

        ctx.lineWidth = 6 + pulse * 8;
        ctx.strokeStyle = rgbCss(tone, 0.048 + pulse * 0.12);
        ctx.stroke();

        ctx.lineWidth = 2;
        ctx.strokeStyle = rgbCss(tone, 1);
        ctx.stroke();
    }


    draw(performance.now());
}

function stopOscilloscope() {
    if (oscilloscopeAnimationId !== null) {
        cancelAnimationFrame(oscilloscopeAnimationId);

        oscilloscopeAnimationId = null;
    }

    oscilloscopeWidth = 0;
    oscilloscopeHeight = 0;
    oscilloscopeParticles = [];
    oscilloscopeShockwaves = [];
}


/* Account */

let currentUser = null;

function updateAccountMenu() {
    const loginItem = document.querySelector('[data-action="login"]');
    const profileItem = document.querySelector('[data-action="profile"]');
    const loggedIn = Boolean(currentUser);

    loginItem?.classList.toggle("hidden", loggedIn);
    profileItem?.classList.toggle("hidden", !loggedIn);
}

function forgetSession() {
    currentUser = null;
    playlists = [];
    libraryLoadedAt = 0;
    updateAccountMenu();

    if (currentView !== showLogin) {
        openTab(showLogin);
    }
}

function showLogin() {
    showPage("login-page");

    const error = document.getElementById("login-error");

    error.classList.add("hidden");
    error.textContent = "";

    document.getElementById("login-username")?.focus();
}

function submitLogin() {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const error = document.getElementById("login-error");
    const button = document.getElementById("login-submit");

    error.classList.add("hidden");
    error.textContent = "";
    button.disabled = true;

    fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    })
        .then(readJson)
        .then(session => {
            currentUser = { username: session.username };
            document.getElementById("login-password").value = "";
            updateAccountMenu();
            libraryLoadedAt = 0;
            openTab(showLibrary);
        })
        .catch(err => {
            error.textContent = err.message;
            error.classList.remove("hidden");
        })
        .finally(() => {
            button.disabled = false;
        });
}

function logout() {
    fetch("/api/logout", { method: "POST" })
        .catch(() => {})
        .finally(() => {
            forgetSession();
        });
}

function restoreSession() {
    return fetch("/api/session")
        .then(readJson)
        .then(session => {
            if (session.logged_in) {
                currentUser = { username: session.username };
                updateAccountMenu();
                currentView = showLibrary;
                showLibrary();

                return;
            }

            currentUser = null;
            updateAccountMenu();
            currentView = showLogin;
            showLogin();
        })
        .catch(() => {
            currentUser = null;
            updateAccountMenu();
            currentView = showLogin;
            showLogin();
        });
}

function wireLoginForm() {
    document.getElementById("login-form")?.addEventListener("submit", event => {
        event.preventDefault();
        submitLogin();
    });

    document.getElementById("logout-button")?.addEventListener("click", logout);
}


/* Start */

wirePersonalizationUi();
wireLoginForm();
applyTheme();
updateAccountMenu();
restoreSession();
