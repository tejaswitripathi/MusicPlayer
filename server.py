from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import Response as RawResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from jellyfin_apiclient_python.exceptions import HTTPException as JellyfinError
from client import (
    AppClient,
    InvalidCredentials,
    PasswordResetUnavailable,
    PlaylistNotFound,
    RegistrationFailed,
    RegistrationUnavailable,
    ServerUnreachable,
    UserAlreadyExists,
    authorization_header,
    JELLYFIN_TIMEOUT
)
from pathlib import Path
from pydantic import BaseModel
import json
import requests
import secrets
import threading
import time


# How long a cached copy of the library stays good for. Searching reads from
# it, so this is the longest a track added on the server stays invisible.
LIBRARY_CACHE_SECONDS = 300

# Enough to fill the results page; a two-letter query can otherwise match
# most of the library.
MAX_SEARCH_RESULTS = 60

SESSION_COOKIE = "musicplayer_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
PREFERENCES_DIR = Path(__file__).parent / "data" / "preferences"
PREFERENCE_KEYS = (
    "mode",
    "basicTheme",
    "extremeTheme",
    "ps3Gradient",
    "visualizerType",
    "oscilloscopeColor",
    "oscilloscopeOutlineColor",
    "win7Oscilloscope",
    "hideExtremeWarning"
)


class NewPlaylist(BaseModel):
    name: str


class PlaylistItems(BaseModel):
    track_ids: list[str]


class LoginRequest(BaseModel):
    username: str
    password: str


class PasswordResetRequest(BaseModel):
    username: str
    password: str


class Preferences(BaseModel):
    mode: str | None = None
    basicTheme: str | None = None
    extremeTheme: str | None = None
    ps3Gradient: str | None = None
    visualizerType: str | None = None
    oscilloscopeColor: str | None = None
    oscilloscopeOutlineColor: str | None = None
    win7Oscilloscope: str | None = None
    hideExtremeWarning: bool | None = None


def unreachable(error, client=None):
    if isinstance(error, ServerUnreachable):
        tried = ", ".join(error.candidates) or "no addresses configured"

        detail = (
            f"Could not reach the Jellyfin server. Tried: {tried}. Check "
            f"that the desktop is awake, and that SERVER_URLS in .env "
            f"lists an address reachable from this network."
        )
    else:
        server = client.server_url if client is not None else jellyfin.server_url

        detail = (
            f"Could not reach the Jellyfin server at {server}. "
            f"({error})"
        )

    return HTTPException(status_code=503, detail=detail)


def auth_headers(client):
    return {
        "Authorization": authorization_header(client.client_id, client.access_token)
    }


def jellyfin_call(send, client=None):
    """Run a call against the Jellyfin client, turning failures into a 503."""
    try:
        return send()
    except PlaylistNotFound:
        raise HTTPException(status_code=404, detail="Playlist not found.")
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error, client)


def jellyfin_get(client, path, headers=None, timeout=JELLYFIN_TIMEOUT, stream=False):
    """GET a path on the Jellyfin server, reselecting its address on failure."""
    request_headers = auth_headers(client)
    request_headers.update(headers or {})

    def send():
        return requests.get(
            f"{client.server_url}{path}",
            headers=request_headers,
            timeout=timeout,
            stream=stream
        )

    return client.request(send)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jellyfin = AppClient()

sessions = {}
sessions_lock = threading.Lock()


class Library:
    """Everything searchable, kept in memory between queries.

    Fetching every song takes seconds, which is far too slow to repeat while
    someone is typing. Each Jellyfin user has their own copy.
    """

    def __init__(self):
        self.caches = {}

    def invalidate(self, user_id=None):
        if user_id is None:
            self.caches.clear()
        else:
            self.caches.pop(user_id, None)

    def contents(self, client):
        entry = self.caches.get(client.user_id)
        fresh = (
            entry is not None
            and time.monotonic() - entry["fetched_at"] < LIBRARY_CACHE_SECONDS
        )

        if fresh:
            return entry["cached"]

        cached = {
            "songs": client.get_songs(),
            "albums": client.get_album_summaries(),
            "artists": client.get_artist_summaries()
        }

        self.caches[client.user_id] = {
            "cached": cached,
            "fetched_at": time.monotonic()
        }

        return cached


library = Library()


def matching(items, field, query):
    results = []

    for item in items:
        name = item.get(field)

        if name and query in name.lower():
            results.append(item)

            if len(results) == MAX_SEARCH_RESULTS:
                break

    return results


def lookup_session(request: Request):
    token = request.cookies.get(SESSION_COOKIE)

    if not token:
        return None

    with sessions_lock:
        return sessions.get(token)


def require_client(request: Request):
    session = lookup_session(request)

    if session is None:
        raise HTTPException(status_code=401, detail="Not logged in.")

    return session["client"]


def bind_session(response: Response, request: Request, identity):
    """Store Jellyfin credentials server-side; the browser only gets a cookie."""
    old = request.cookies.get(SESSION_COOKIE)
    session_id = secrets.token_urlsafe(32)
    client = jellyfin.for_user(identity["user_id"], identity["access_token"])

    with sessions_lock:
        if old:
            sessions.pop(old, None)

        sessions[session_id] = {
            "user_id": identity["user_id"],
            "access_token": identity["access_token"],
            "username": identity["username"],
            "client": client
        }

    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=request.url.scheme == "https"
    )


def drop_session(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)

    if token:
        with sessions_lock:
            sessions.pop(token, None)

    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        samesite="lax",
        secure=request.url.scheme == "https"
    )


def preferences_path(user_id):
    safe = "".join(ch for ch in user_id if ch.isalnum() or ch in "-_")

    if not safe or safe != user_id:
        raise HTTPException(status_code=400, detail="Invalid user.")

    return PREFERENCES_DIR / f"{safe}.json"


def read_preferences(user_id):
    path = preferences_path(user_id)

    if not path.is_file():
        return {}

    try:
        loaded = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(loaded, dict):
        return {}

    return {
        key: loaded[key]
        for key in PREFERENCE_KEYS
        if key in loaded
    }


def write_preferences(user_id, body: Preferences):
    saved = read_preferences(user_id)
    saved.update(body.model_dump(exclude_unset=True))

    PREFERENCES_DIR.mkdir(parents=True, exist_ok=True)
    preferences_path(user_id).write_text(json.dumps(saved, indent=2))

    return saved


@app.get("/api/health")
def health():
    return {
        "message": "MusicPlayer backend is running"
    }


@app.get("/api/session")
def get_session(request: Request):
    session = lookup_session(request)

    if session is None:
        return {"logged_in": False}

    return {
        "logged_in": True,
        "username": session["username"]
    }


@app.post("/api/login")
def login(body: LoginRequest, request: Request, response: Response):
    username = body.username.strip()

    if not username:
        raise HTTPException(status_code=400, detail="A username is required.")

    try:
        identity = jellyfin.login(username, body.password)
    except InvalidCredentials:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password."
        )
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)

    bind_session(response, request, identity)

    return {
        "logged_in": True,
        "username": identity["username"]
    }


@app.post("/api/register")
def register(body: LoginRequest, request: Request, response: Response):
    username = body.username.strip()
    password = body.password

    if not username:
        raise HTTPException(status_code=400, detail="A username is required.")

    if not password:
        raise HTTPException(status_code=400, detail="A password is required.")

    try:
        identity = jellyfin.create_user(username, password)
    except UserAlreadyExists:
        raise HTTPException(
            status_code=409,
            detail="That username is already taken."
        )
    except RegistrationFailed as error:
        raise HTTPException(status_code=400, detail=error.message)
    except RegistrationUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Account creation is not available right now."
        )
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)

    bind_session(response, request, identity)

    return {
        "logged_in": True,
        "username": identity["username"]
    }


@app.post("/api/password-reset")
def reset_password(body: PasswordResetRequest):
    username = body.username.strip()
    password = body.password

    if not username:
        raise HTTPException(status_code=400, detail="A username is required.")

    if not password:
        raise HTTPException(status_code=400, detail="A new password is required.")

    try:
        jellyfin.reset_password(username, password)
    except PasswordResetUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Password reset is not available right now."
        )
    except RegistrationUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Password reset is not available right now."
        )
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)

    return {
        "message": "If that account exists, its password has been reset."
    }


@app.get("/api/username-taken")
def username_taken(username: str = ""):
    name = username.strip()

    if not name:
        return {"taken": False}

    try:
        taken = jellyfin.username_taken(name)
    except RegistrationUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Username availability checks are unavailable until admin credentials are configured."
        )
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)

    return {"taken": taken}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    drop_session(request, response)

    return {"logged_in": False}


@app.get("/api/preferences")
def get_preferences(client: AppClient = Depends(require_client)):
    return read_preferences(client.user_id)


@app.put("/api/preferences")
def put_preferences(
    body: Preferences,
    client: AppClient = Depends(require_client)
):
    return write_preferences(client.user_id, body)


@app.get("/api/albums")
def get_albums(client: AppClient = Depends(require_client)):
    return jellyfin_call(client.get_album_summaries, client)


@app.get("/api/images/{item_id}")
def get_item_image(item_id: str, client: AppClient = Depends(require_client)):
    """Primary artwork for any item: album, playlist or artist."""
    response = jellyfin_call(
        lambda: jellyfin_get(client, f"/Items/{item_id}/Images/Primary"),
        client
    )

    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail="Could not retrieve artwork"
        )

    return RawResponse(
        content=response.content,
        media_type=response.headers.get("Content-Type", "image/jpeg")
    )


@app.get("/api/albums/{album_id}/tracks")
def get_album_tracks(album_id: str, client: AppClient = Depends(require_client)):
    return jellyfin_call(lambda: client.get_album_tracks(album_id), client)


@app.get("/api/artists")
def get_artists(client: AppClient = Depends(require_client)):
    return jellyfin_call(client.get_artist_summaries, client)


@app.get("/api/artists/{artist_id}/albums")
def get_artist_albums(artist_id: str, client: AppClient = Depends(require_client)):
    return jellyfin_call(lambda: client.get_artist_albums(artist_id), client)


@app.get("/api/playlists")
def get_playlists(client: AppClient = Depends(require_client)):
    return jellyfin_call(client.get_playlist_summaries, client)


@app.post("/api/playlists")
def create_playlist(body: NewPlaylist, client: AppClient = Depends(require_client)):
    name = body.name.strip()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="A playlist needs a name."
        )

    created = jellyfin_call(lambda: client.create_playlist(name), client)

    library.invalidate(client.user_id)

    return created


@app.get("/api/playlists/{playlist_id}/tracks")
def get_playlist_tracks(playlist_id: str, client: AppClient = Depends(require_client)):
    return jellyfin_call(lambda: client.get_playlist_tracks(playlist_id), client)


@app.post("/api/playlists/{playlist_id}/items")
def add_playlist_items(
    playlist_id: str,
    body: PlaylistItems,
    client: AppClient = Depends(require_client)
):
    if not body.track_ids:
        raise HTTPException(status_code=400, detail="No tracks to add.")

    jellyfin_call(
        lambda: client.add_to_playlist(playlist_id, body.track_ids),
        client
    )

    return {"added": len(body.track_ids)}


@app.delete("/api/playlists/{playlist_id}/items/{entry_id}")
def remove_playlist_item(
    playlist_id: str,
    entry_id: str,
    client: AppClient = Depends(require_client)
):
    jellyfin_call(
        lambda: client.remove_from_playlist(playlist_id, [entry_id]),
        client
    )

    return {"removed": entry_id}


@app.post("/api/playlists/{playlist_id}/image")
async def set_playlist_image(
    playlist_id: str,
    request: Request,
    client: AppClient = Depends(require_client)
):
    image = await request.body()

    if not image:
        raise HTTPException(status_code=400, detail="No image was sent.")

    media_type = request.headers.get("content-type") or "image/jpeg"

    jellyfin_call(
        lambda: client.set_playlist_image(playlist_id, image, media_type),
        client
    )

    return {"updated": playlist_id}


@app.get("/api/tracks/{track_id}/playlists")
def get_track_playlists(track_id: str, client: AppClient = Depends(require_client)):
    """Which playlists already hold a track, for the add-to-playlist list."""
    return jellyfin_call(lambda: client.playlists_holding(track_id), client)


@app.get("/api/search")
def search(query: str = "", client: AppClient = Depends(require_client)):
    """Songs, albums and artists whose name contains the query.

    Matching is a case-insensitive substring test over a cached copy of the
    library, so results can narrow on every keystroke without a round trip
    to Jellyfin for each one.
    """
    query = query.strip().lower()

    if not query:
        return {"songs": [], "albums": [], "artists": []}

    contents = jellyfin_call(lambda: library.contents(client), client)

    return {
        "songs": matching(contents["songs"], "title", query),
        "albums": matching(contents["albums"], "title", query),
        "artists": matching(contents["artists"], "name", query)
    }


@app.get("/api/tracks/{track_id}/stream")
def stream_track(track_id: str, request: Request, client: AppClient = Depends(require_client)):

    headers = {}

    # Browser sends this when seeking
    range_header = request.headers.get("range")

    if range_header:
        headers["Range"] = range_header

    try:
        response = jellyfin_get(
            client,
            f"/Items/{track_id}/Download",
            headers=headers,
            timeout=(3, 60),
            stream=True
        )
    except (
        ServerUnreachable,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error, client)

    print("Browser Range:", range_header)
    print("Jellyfin status:", response.status_code)
    print("Content-Range:", response.headers.get("Content-Range"))
    print("Content-Length:", response.headers.get("Content-Length"))

    if response.status_code not in (200, 206):
        raise HTTPException(
            status_code=response.status_code,
            detail="Could not retrieve audio"
        )

    def generate():
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if chunk:
                yield chunk

    response_headers = {}

    if response.headers.get("Content-Range"):
        response_headers["Content-Range"] = \
            response.headers["Content-Range"]

    if response.headers.get("Accept-Ranges"):
        response_headers["Accept-Ranges"] = \
            response.headers["Accept-Ranges"]

    if response.headers.get("Content-Length"):
        response_headers["Content-Length"] = \
            response.headers["Content-Length"]

    return StreamingResponse(
        generate(),
        status_code=response.status_code,
        media_type=response.headers.get(
            "Content-Type",
            "audio/flac"
        ),
        headers=response_headers
    )


# Mounted last so the /api routes above take precedence.
app.mount(
    "/",
    StaticFiles(
        directory=Path(__file__).parent / "frontend",
        html=True
    ),
    name="frontend"
)
