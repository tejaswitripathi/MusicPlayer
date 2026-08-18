from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from jellyfin_apiclient_python.exceptions import HTTPException as JellyfinError
from client import (
    AppClient,
    ServerUnreachable,
    JELLYFIN_TIMEOUT
)
from pathlib import Path
from pydantic import BaseModel
import requests
import time


# How long a cached copy of the library stays good for. Searching reads from
# it, so this is the longest a track added on the server stays invisible.
LIBRARY_CACHE_SECONDS = 300

# Enough to fill the results page; a two-letter query can otherwise match
# most of the library.
MAX_SEARCH_RESULTS = 60


class NewPlaylist(BaseModel):
    name: str


class PlaylistItems(BaseModel):
    track_ids: list[str]


def unreachable(error):
    if isinstance(error, ServerUnreachable):
        tried = ", ".join(error.candidates) or "no addresses configured"

        detail = (
            f"Could not reach the Jellyfin server. Tried: {tried}. Check "
            f"that the desktop is awake, and that SERVER_URLS in .env "
            f"lists an address reachable from this network."
        )
    else:
        detail = (
            f"Could not reach the Jellyfin server at {jellyfin.server_url}. "
            f"({error})"
        )

    return HTTPException(status_code=503, detail=detail)


def auth_headers():
    return {
        "Authorization": (
            f'MediaBrowser '
            f'Client="MusicPlayer", '
            f'Device="tejaswis-macbook-pro", '
            f'DeviceId="{jellyfin.client_id}", '
            f'Version="0.0.1", '
            f'Token="{jellyfin.access_token}"'
        )
    }


def jellyfin_call(send):
    """Run a call against the Jellyfin client, turning failures into a 503."""
    try:
        return send()
    except (
        ServerUnreachable,
        JellyfinError,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)


def jellyfin_get(path, headers=None, timeout=JELLYFIN_TIMEOUT, stream=False):
    """GET a path on the Jellyfin server, reselecting its address on failure."""
    request_headers = auth_headers()
    request_headers.update(headers or {})

    def send():
        return requests.get(
            f"{jellyfin.server_url}{path}",
            headers=request_headers,
            timeout=timeout,
            stream=stream
        )

    return jellyfin.request(send)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jellyfin = AppClient()


class Library:
    """Everything searchable, kept in memory between queries.

    Fetching every song takes seconds, which is far too slow to repeat while
    someone is typing.
    """

    def __init__(self):
        self.cached = None
        self.fetched_at = 0.0

    def invalidate(self):
        self.cached = None

    def contents(self):
        fresh = time.monotonic() - self.fetched_at < LIBRARY_CACHE_SECONDS

        if self.cached is not None and fresh:
            return self.cached

        self.cached = {
            "songs": jellyfin.get_songs(),
            "albums": jellyfin.get_album_summaries(),
            "artists": jellyfin.get_artist_summaries()
        }

        self.fetched_at = time.monotonic()

        return self.cached


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


@app.get("/api/health")
def health():
    return {
        "message": "MusicPlayer backend is running"
    }


@app.get("/api/albums")
def get_albums():
    return jellyfin_call(jellyfin.get_album_summaries)


@app.get("/api/images/{item_id}")
def get_item_image(item_id: str):
    """Primary artwork for any item: album, playlist or artist."""
    response = jellyfin_call(
        lambda: jellyfin_get(f"/Items/{item_id}/Images/Primary")
    )

    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail="Could not retrieve artwork"
        )

    return Response(
        content=response.content,
        media_type=response.headers.get("Content-Type", "image/jpeg")
    )


@app.get("/api/albums/{album_id}/tracks")
def get_album_tracks(album_id: str):
    return jellyfin_call(lambda: jellyfin.get_album_tracks(album_id))


@app.get("/api/artists")
def get_artists():
    return jellyfin_call(jellyfin.get_artist_summaries)


@app.get("/api/artists/{artist_id}/albums")
def get_artist_albums(artist_id: str):
    return jellyfin_call(lambda: jellyfin.get_artist_albums(artist_id))


@app.get("/api/playlists")
def get_playlists():
    return jellyfin_call(jellyfin.get_playlist_summaries)


@app.post("/api/playlists")
def create_playlist(request: NewPlaylist):
    name = request.name.strip()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="A playlist needs a name."
        )

    return jellyfin_call(lambda: jellyfin.create_playlist(name))


@app.get("/api/playlists/{playlist_id}/tracks")
def get_playlist_tracks(playlist_id: str):
    return jellyfin_call(lambda: jellyfin.get_playlist_tracks(playlist_id))


@app.post("/api/playlists/{playlist_id}/items")
def add_playlist_items(playlist_id: str, request: PlaylistItems):
    if not request.track_ids:
        raise HTTPException(status_code=400, detail="No tracks to add.")

    jellyfin_call(
        lambda: jellyfin.add_to_playlist(playlist_id, request.track_ids)
    )

    return {"added": len(request.track_ids)}


@app.delete("/api/playlists/{playlist_id}/items/{entry_id}")
def remove_playlist_item(playlist_id: str, entry_id: str):
    jellyfin_call(
        lambda: jellyfin.remove_from_playlist(playlist_id, [entry_id])
    )

    return {"removed": entry_id}


@app.post("/api/playlists/{playlist_id}/image")
async def set_playlist_image(playlist_id: str, request: Request):
    image = await request.body()

    if not image:
        raise HTTPException(status_code=400, detail="No image was sent.")

    media_type = request.headers.get("content-type") or "image/jpeg"

    jellyfin_call(
        lambda: jellyfin.set_playlist_image(playlist_id, image, media_type)
    )

    return {"updated": playlist_id}


@app.get("/api/tracks/{track_id}/playlists")
def get_track_playlists(track_id: str):
    """Which playlists already hold a track, for the add-to-playlist list."""
    return jellyfin_call(lambda: jellyfin.playlists_holding(track_id))


@app.get("/api/search")
def search(query: str = ""):
    """Songs, albums and artists whose name contains the query.

    Matching is a case-insensitive substring test over a cached copy of the
    library, so results can narrow on every keystroke without a round trip
    to Jellyfin for each one.
    """
    query = query.strip().lower()

    if not query:
        return {"songs": [], "albums": [], "artists": []}

    contents = jellyfin_call(library.contents)

    return {
        "songs": matching(contents["songs"], "title", query),
        "albums": matching(contents["albums"], "title", query),
        "artists": matching(contents["artists"], "name", query)
    }


@app.get("/api/tracks/{track_id}/stream")
def stream_track(track_id: str, request: Request):

    headers = {}

    # Browser sends this when seeking
    range_header = request.headers.get("range")

    if range_header:
        headers["Range"] = range_header

    try:
        response = jellyfin_get(
            f"/Items/{track_id}/Download",
            headers=headers,
            timeout=(3, 60),
            stream=True
        )
    except (
        ServerUnreachable,
        requests.exceptions.RequestException
    ) as error:
        raise unreachable(error)

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