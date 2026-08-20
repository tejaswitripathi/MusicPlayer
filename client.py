from jellyfin_apiclient_python import JellyfinClient
from jellyfin_apiclient_python.exceptions import HTTPException as JellyfinError
import base64
import json
import os
import re
import requests
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# (connect, read) seconds. A short connect timeout means an unreachable
# server fails fast instead of blocking the whole request.
JELLYFIN_TIMEOUT = (3, 15)

# Probing happens once per candidate before anything can load, so it needs
# to be quicker than a normal request.
PROBE_TIMEOUT = (2, 4)

APP_NAME = "MusicPlayer"
APP_VERSION = "0.0.1"
DEVICE_NAME = "MusicPlayer"


class ServerUnreachable(Exception):
    """No configured address for the Jellyfin server responded."""

    def __init__(self, candidates):
        self.candidates = candidates

        super().__init__(
            "None of these addresses responded: " + ", ".join(candidates)
        )


class InvalidCredentials(Exception):
    """Jellyfin rejected the username or password."""


class UserAlreadyExists(Exception):
    """That Jellyfin username is already taken."""


class RegistrationUnavailable(Exception):
    """The backend is not allowed to create Jellyfin users."""


class RegistrationFailed(Exception):
    """Jellyfin rejected the new account for a reason other than a clash."""

    def __init__(self, message):
        self.message = message

        super().__init__(message)


class PlaylistNotFound(Exception):
    """This user does not own that playlist, or it does not exist."""


def read_candidates():
    """Server addresses to try, in order.

    SERVER_URLS holds a comma-separated list so the same config works on
    the home LAN and remotely; SERVER_URL remains valid for a single one.
    """
    raw = os.getenv("SERVER_URLS") or os.getenv("SERVER_URL") or ""

    return [url.strip().rstrip("/") for url in raw.split(",") if url.strip()]


def make_jellyfin_client(client_id, server_url, user_id=None, access_token=None):
    """A Jellyfin client for this app, optionally signed in as one user."""
    client = JellyfinClient()

    client.config.app(APP_NAME, APP_VERSION, DEVICE_NAME, client_id)
    client.config.data["auth.ssl"] = False

    # Without this the client retries an unreachable server 3 times
    # on top of a 30s timeout, so requests hang for minutes.
    client.config.data["http.timeout"] = JELLYFIN_TIMEOUT
    client.config.data["http.max_retries"] = 0
    client.config.data["auth.server"] = server_url

    if access_token:
        client.config.data["auth.token"] = access_token

    if user_id:
        client.config.data["auth.user_id"] = user_id

    return client


def authorization_header(client_id, access_token=None):
    header = (
        f'MediaBrowser '
        f'Client="{APP_NAME}", '
        f'Device="{DEVICE_NAME}", '
        f'DeviceId="{client_id}", '
        f'Version="{APP_VERSION}"'
    )

    if access_token:
        header += f', Token="{access_token}"'

    return header


def jellyfin_message(response):
    try:
        data = response.json()
    except ValueError:
        return ""

    if isinstance(data, str):
        return data

    if not isinstance(data, dict):
        return ""

    return str(
        data.get("Message")
        or data.get("detail")
        or data.get("title")
        or ""
    )


class AppClient:

    def __init__(self, user_id=None, access_token=None, _home=None):
        self.user_id = user_id
        self.access_token = access_token
        self._home = _home
        self._privatized_playlists = set()

        if _home is not None:
            self.client_id = _home.client_id
            self.candidates = _home.candidates
            self.server_url = _home.server_url
        else:
            self.client_id = os.getenv("CLIENT_UUID")
            self.candidates = read_candidates()

            # Assumed reachable until a request proves otherwise, so startup
            # does not pay for a probe.
            self.server_url = self.candidates[0] if self.candidates else None

            print("CANDIDATES:", self.candidates)
            print("CLIENT_UUID:", self.client_id)
            print("SERVER:", self.server_url)

        self._admin = None

        self.client = make_jellyfin_client(
            self.client_id,
            self.server_url,
            user_id,
            access_token
        )

    def for_user(self, user_id, access_token):
        """A client that talks to Jellyfin as this user, not a global identity."""
        home = self._home if self._home is not None else self

        return AppClient(user_id, access_token, _home=home)

    def get_user(self):
        return self.client.jellyfin.get_user()

    def _use(self, url):
        self.server_url = url
        self.client.config.data["auth.server"] = url

        if self._home is not None:
            self._home.server_url = url

    def _responds(self, url):
        try:
            response = requests.get(
                f"{url}/System/Info/Public",
                timeout=PROBE_TIMEOUT
            )
        except requests.exceptions.RequestException:
            return False

        return response.status_code == 200

    def reselect_server(self):
        """Switch to whichever candidate address answers.

        Called after a request fails, so moving between the home network
        and a remote one does not need a config change.
        """
        for url in self.candidates:
            if self._responds(url):
                print("SERVER:", url)
                self._use(url)

                return url

        raise ServerUnreachable(self.candidates)

    def request(self, send):
        """Run a request, reselecting the server if it cannot be reached."""
        if not self.candidates:
            raise ServerUnreachable([])

        try:
            return send()
        except (JellyfinError, requests.exceptions.RequestException):
            self.reselect_server()

            return send()

    def login(self, username, password):
        """Authenticate against Jellyfin. Does not keep the token on this client."""
        if not self.candidates:
            raise ServerUnreachable([])

        def send():
            return requests.post(
                f"{self.server_url}/Users/AuthenticateByName",
                json={"Username": username, "Pw": password},
                headers={
                    "Authorization": authorization_header(self.client_id),
                    "Content-Type": "application/json"
                },
                timeout=JELLYFIN_TIMEOUT
            )

        response = self.request(send)

        if response.status_code in (400, 401, 403):
            raise InvalidCredentials()

        if response.status_code != 200:
            raise requests.exceptions.RequestException(
                f"Login failed with status {response.status_code}"
            )

        data = response.json()
        user = data.get("User") or {}
        user_id = user.get("Id")
        access_token = data.get("AccessToken")

        if not user_id or not access_token:
            raise InvalidCredentials()

        return {
            "user_id": user_id,
            "access_token": access_token,
            "username": user.get("Name") or username
        }

    def _admin_headers(self, access_token):
        return {
            "Authorization": authorization_header(self.client_id, access_token),
            "Content-Type": "application/json"
        }

    def _admin_identity(self):
        if self._admin:
            return self._admin

        # Env values are often edited while the app is running; reload them
        # before checking the admin account so the app picks up new .env edits.
        load_dotenv(Path(__file__).resolve().parent / ".env", override=True)
        username = os.getenv("USERNAME")
        password = os.getenv("PASSWORD")

        if not username or password is None:
            raise RegistrationUnavailable()

        try:
            self._admin = self.login(username, password)
        except InvalidCredentials:
            raise RegistrationUnavailable()

        return self._admin

    def create_user(self, username, password):
        """Create a Jellyfin user, then sign in as that user."""
        admin = self._admin_identity()

        def send():
            return requests.post(
                f"{self.server_url}/Users/New",
                json={"Name": username, "Password": password},
                headers=self._admin_headers(admin["access_token"]),
                timeout=JELLYFIN_TIMEOUT
            )

        response = self.request(send)

        if response.status_code == 409:
            raise UserAlreadyExists()

        if response.status_code == 400:
            message = jellyfin_message(response)

            if "exist" in message.lower() or "already" in message.lower():
                raise UserAlreadyExists()

            raise RegistrationFailed(message or "Could not create that account.")

        if response.status_code in (401, 403):
            raise RegistrationUnavailable()

        if response.status_code not in (200, 201):
            raise requests.exceptions.RequestException(
                f"Could not create the account ({response.status_code})"
            )

        created = response.json() or {}
        self._enable_library_access(admin["access_token"], created)

        return self.login(username, password)

    def _enable_library_access(self, admin_token, user):
        """New Jellyfin users otherwise start with no library folders."""
        user_id = user.get("Id")
        policy = dict(user.get("Policy") or {})

        if not user_id or policy.get("EnableAllFolders"):
            return

        policy["EnableAllFolders"] = True

        def send():
            return requests.post(
                f"{self.server_url}/Users/{user_id}/Policy",
                json=policy,
                headers=self._admin_headers(admin_token),
                timeout=JELLYFIN_TIMEOUT
            )

        try:
            self.request(send)
        except (JellyfinError, requests.exceptions.RequestException):
            pass

    def username_taken(self, username):
        """Whether a Jellyfin user already has this name."""
        wanted = username.strip().lower()

        if not wanted:
            return False

        # Username availability checks need admin credentials; the public
        # `/Users/Public` endpoint is not a reliable source for private names.
        self._admin_identity()
        users = self._list_users()

        return any((user.get("Name") or "").lower() == wanted for user in users)

    def _list_users(self):
        try:
            admin = self._admin_identity()
        except RegistrationUnavailable:
            admin = None

        def send_admin():
            return requests.get(
                f"{self.server_url}/Users",
                headers=self._admin_headers(admin["access_token"]),
                timeout=JELLYFIN_TIMEOUT
            )

        def send_public():
            return requests.get(
                f"{self.server_url}/Users/Public",
                headers={"Authorization": authorization_header(self.client_id)},
                timeout=JELLYFIN_TIMEOUT
            )

        if admin:
            response = self.request(send_admin)

            if response.status_code in (401, 403):
                self._admin = None
                response = self.request(send_public)
        else:
            response = self.request(send_public)

        if response.status_code != 200:
            raise requests.exceptions.RequestException(
                f"Could not list users ({response.status_code})"
            )

        users = response.json()

        return users if isinstance(users, list) else []

    def _send(self, action, handler, params=None, body=None, data=None,
              headers=None):
        # The client's own convenience methods have no way to bound retries,
        # and the default of 5 (each preceded by a 1s sleep) stacks up to a
        # long wait when the server is unreachable. _http takes the override.
        def send():
            request = {
                "params": params,
                "retry": 0,
                "timeout": JELLYFIN_TIMEOUT
            }

            if body is not None:
                request["json"] = body

            if data is not None:
                request["data"] = data

            if headers is not None:
                request["headers"] = headers

            return self.client.jellyfin._http(action, handler, request)

        return self.request(send)

    def _user_items(self, params):
        return self._send("GET", "Users/{UserId}/Items", params=params)

    def get_albums(self):
        return self._user_items(
            params={
                "IncludeItemTypes": "MusicAlbum",
                "Recursive": True,
                "SortBy": "SortName",
                "SortOrder": "Ascending",
                # Path is what puts a release's disc folders in order.
                "Fields": "Path"
            }
        )

    def get_album_summaries(self):
        albums = self.get_albums()

        return merge_discs(albums["Items"])

    def album_parts(self, album_id: str):
        """Every album item belonging to the same release as this one.

        Usually just the album itself, but a multi-disc rip arrives as one
        item per disc folder, and browsing it should reach all of them.
        """
        albums = self.get_albums()["Items"]

        this = next(
            (album for album in albums if album.get("Id") == album_id),
            None
        )

        if this is None:
            return [album_id]

        return [album.get("Id") for album in sorted_parts(albums, this)]

    def get_album_tracks(self, album_id: str):
        parts = self.album_parts(album_id)

        tracks = []

        for position, part in enumerate(parts):
            response = self._user_items(
                params={
                    "ParentId": part,
                    "IncludeItemTypes": "Audio",
                    "Recursive": True,
                    "SortBy": "ParentIndexNumber,IndexNumber",
                    "SortOrder": "Ascending",
                    "Fields": TRACK_FIELDS
                }
            )

            for track in response["Items"]:
                summary = track_summary(track)

                # A disc folder whose tags never say which disc it is still
                # counts as one, in the order the folders sort.
                if not summary["disc"] and len(parts) > 1:
                    summary["disc"] = position + 1

                    if not summary["disc_label"]:
                        summary["disc_label"] = f"Disc {position + 1}"

                tracks.append(summary)

        tracks.sort(key=lambda track: (
            track["disc"] or 0,
            track["track_number"] or 0
        ))

        return tracks

    def get_songs(self):
        """Every track in the library, for searching over."""
        response = self._user_items(
            params={
                "IncludeItemTypes": "Audio",
                "Recursive": True,
                "SortBy": "SortName",
                "SortOrder": "Ascending",
                "Fields": TRACK_FIELDS
            }
        )

        return [track_summary(track) for track in response["Items"]]

    def get_artist_summaries(self):
        # AlbumArtists rather than Artists: credited album artists are what a
        # library browses by, without every featured guest becoming an entry.
        response = self._send(
            "GET",
            "Artists/AlbumArtists",
            params={
                "UserId": "{UserId}",
                "SortBy": "SortName",
                "SortOrder": "Ascending"
            }
        )

        return [
            {
                "id": artist.get("Id"),
                "name": artist.get("Name"),
                "cover_url": image_url(artist.get("Id"))
            }
            for artist in response["Items"]
        ]

    def get_artist_albums(self, artist_id: str):
        response = self._user_items(
            params={
                "AlbumArtistIds": artist_id,
                "IncludeItemTypes": "MusicAlbum",
                "Recursive": True,
                "SortBy": "ProductionYear,SortName",
                "SortOrder": "Descending",
                "Fields": "Path"
            }
        )

        return merge_discs(response["Items"])

    def get_playlist_summaries(self):
        response = self._user_items(
            params={
                "IncludeItemTypes": "Playlist",
                "Recursive": True,
                "SortBy": "SortName",
                "SortOrder": "Ascending",
                "Fields": "Path,OwnerUserId"
            }
        )

        summaries = []

        for playlist in response.get("Items") or []:
            if is_sidecar_playlist(playlist):
                continue

            if not owned_by(playlist, self.user_id):
                continue

            playlist_id = playlist.get("Id")

            self._privatize_playlist(playlist_id)

            summaries.append({
                "id": playlist_id,
                "name": playlist.get("Name"),
                "cover_url": image_url(playlist_id)
            })

        return summaries

    def get_playlist_tracks(self, playlist_id: str):
        # Playlists/{id}/Items rather than a ParentId query, so tracks come
        # back in the order the playlist puts them in, each with the entry id
        # that removing it later needs.
        self._own_playlist(playlist_id)

        response = self._send(
            "GET",
            f"Playlists/{playlist_id}/Items",
            params={
                "UserId": "{UserId}",
                "Fields": TRACK_FIELDS
            }
        )

        return [
            dict(
                track_summary(track),
                playlist_item_id=track.get("PlaylistItemId")
            )
            for track in response["Items"]
        ]

    def add_to_playlist(self, playlist_id: str, track_ids):
        self._own_playlist(playlist_id)

        return self._send(
            "POST",
            f"Playlists/{playlist_id}/Items",
            params={
                "Ids": ",".join(track_ids),
                "UserId": "{UserId}"
            }
        )

    def remove_from_playlist(self, playlist_id: str, entry_ids):
        # Entries are addressed by PlaylistItemId, not by track id: the same
        # song can sit in a playlist more than once.
        self._own_playlist(playlist_id)

        return self._send(
            "DELETE",
            f"Playlists/{playlist_id}/Items",
            params={"EntryIds": ",".join(entry_ids)}
        )

    def playlists_holding(self, track_id: str):
        """Ids of the playlists that contain a track.

        Jellyfin has no reverse lookup for this, so it means reading each
        playlist. There are only ever a handful of them.
        """
        return [
            playlist["id"]
            for playlist in self.get_playlist_summaries()
            if any(
                track["id"] == track_id
                for track in self.get_playlist_tracks(playlist["id"])
            )
        ]

    def set_playlist_image(self, playlist_id: str, image: bytes, media_type):
        # Jellyfin wants the image base64 encoded in the request body, with
        # the real image type still declared in the header.
        self._own_playlist(playlist_id)

        return self._send(
            "POST",
            f"Items/{playlist_id}/Images/Primary",
            data=base64.b64encode(image).decode(),
            headers={
                "Accept": "*/*",
                "Content-type": media_type
            }
        )

    def create_playlist(self, name: str):
        response = self._send(
            "POST",
            "Playlists",
            body={
                "Name": name,
                "UserId": "{UserId}",
                "MediaType": "Audio",
                "Users": [],
                "IsPublic": False
            }
        )

        playlist_id = response.get("Id")

        self._privatize_playlist(playlist_id)

        return {"id": playlist_id, "name": name}

    def _own_playlist(self, playlist_id: str):
        """Raise unless this playlist exists and belongs to the signed-in user."""
        try:
            item = self._send(
                "GET",
                f"Users/{{UserId}}/Items/{playlist_id}",
                params={"Fields": "Path,OwnerUserId"}
            )
        except JellyfinError as error:
            raise PlaylistNotFound() from error

        if not item or is_sidecar_playlist(item) or not owned_by(item, self.user_id):
            raise PlaylistNotFound()

        return item

    def _privatize_playlist(self, playlist_id: str):
        """Jellyfin playlists default to public; lock each owned one once."""
        if not playlist_id or playlist_id in self._privatized_playlists:
            return

        try:
            self._send(
                "POST",
                f"Playlists/{playlist_id}",
                body={"IsPublic": False, "Users": []}
            )
        except (JellyfinError, requests.exceptions.RequestException):
            return

        self._privatized_playlists.add(playlist_id)


# Playlist files that album downloads often ship alongside the audio.
SIDECAR_PLAYLIST_SUFFIXES = (".m3u", ".m3u8", ".pls", ".wpl", ".zpl")


def is_sidecar_playlist(playlist):
    """Whether a playlist is really just a file sitting in the music library.

    Jellyfin turns any .m3u it scans into a Playlist item, so an album that
    came with one shows up a second time as a playlist of itself. Playlists
    the user actually made are directories under the server's own storage.
    """
    path = (playlist.get("Path") or "").lower()

    return path.endswith(SIDECAR_PLAYLIST_SUFFIXES)


def same_id(left, right):
    if not left or not right:
        return False

    return str(left).replace("-", "").casefold() == str(right).replace("-", "").casefold()


def owned_by(item, user_id):
    """Whether a Jellyfin item belongs to this user.

    Playlists created in the app are owned by the signed-in user. Public
    playlists from other accounts still appear in Users/Items, so ownership
    is what keeps each person's list private.
    """
    owner = item.get("OwnerUserId")

    return not owner or same_id(owner, user_id)


TRACK_FIELDS = "ParentIndexNumber,RunTimeTicks,Path"

TICKS_PER_SECOND = 10_000_000


def image_url(item_id):
    return f"/api/images/{item_id}" if item_id else None


def duration_seconds(ticks):
    return round(ticks / TICKS_PER_SECOND) if ticks else None


# Disc 1, CD2, Side A, Side-B — the folder names a rip uses under an album.
DISC_FOLDER = re.compile(
    r"^(?:disc|disk|cd|dvd)\s*[-_. ]?\s*\d+$|^side\s*[-_. ]?\s*[a-d]$",
    re.I
)

DISC_SUFFIX = re.compile(
    r"\s*[\(\[]?\s*(?:disc|disk|cd|dvd|side)\s*[-_. ]?\s*(?:\d+|[a-d])\s*[\)\]]?\s*$",
    re.I
)


def path_parts(path):
    return [part for part in (path or "").replace("\\", "/").split("/") if part]


def disc_folder_name(name):
    name = (name or "").strip()

    return name if name and DISC_FOLDER.match(name) else None


def pretty_disc(name):
    match = re.match(
        r"^(disc|disk|cd|dvd|side)\s*[-_. ]?\s*(.+)$",
        name.strip(),
        re.I
    )

    if not match:
        return name

    kind, rest = match.group(1), match.group(2).strip()
    kind = {"cd": "CD", "dvd": "DVD"}.get(kind.lower(), kind.capitalize())
    rest = rest.upper() if rest.isalpha() and len(rest) == 1 else rest

    return f"{kind} {rest}"


def disc_label_from_path(path):
    """Label taken from a Disc / Side folder sitting above the file."""
    parts = path_parts(path)

    if len(parts) < 2:
        return None

    folder = disc_folder_name(parts[-2])

    return pretty_disc(folder) if folder else None


def strip_disc_suffix(name):
    stripped = DISC_SUFFIX.sub("", name or "").strip()

    return stripped or name


def album_title(album):
    name = album.get("Name") or ""
    path = album.get("Path") or ""
    parts = path_parts(path)

    # Jellyfin names some disc folders after themselves ("Disc 1"), so the
    # parent folder is the actual release title.
    if disc_folder_name(name) and len(parts) >= 2:
        return parts[-2]

    return strip_disc_suffix(name) or name


def release_of(album):
    """What makes two album items the same release.

    Disc folders under one album directory are the same release even when
    Jellyfin names each item after the folder. Otherwise a shared title and
    artist is enough, with a trailing "(Disc 2)" ignored.
    """
    path = album.get("Path") or ""
    parts = path_parts(path)
    artist = (album.get("AlbumArtist") or "").lower()

    if parts and disc_folder_name(parts[-1]) and len(parts) >= 2:
        parent = "/".join(parts[:-1]).lower()

        return ("folder", parent, artist)

    return ("title", strip_disc_suffix(album.get("Name") or "").lower(), artist)


def sorted_parts(albums, album):
    """The items sharing a release, in disc order.

    Disc folders are named so that they sort into order by path, and their
    parent albums are otherwise indistinguishable.
    """
    parts = [
        other for other in albums
        if release_of(other) == release_of(album)
    ]

    return sorted(parts, key=lambda part: part.get("Path") or "")


def merge_discs(albums):
    """One entry per release rather than one per disc folder.

    A multi-disc rip lands in the library as several MusicAlbum items that
    share a name and artist, one for each Disc folder. On a shelf they belong
    together, represented by their first disc.
    """
    releases = {}

    for album in albums:
        releases.setdefault(release_of(album), []).append(album)

    return [
        album_summary(sorted_parts(parts, parts[0])[0])
        for parts in releases.values()
    ]


def album_summary(album):
    return {
        "id": album.get("Id"),
        "title": album_title(album),
        "artist": album.get("AlbumArtist"),
        "year": album.get("ProductionYear"),
        "cover_url": image_url(album.get("Id"))
    }


def track_summary(track):
    """A track plus the album context the player needs to label it.

    Tracks reached through search or a playlist arrive without a surrounding
    album view, so each one carries its own artist, album and artwork.
    """
    artists = track.get("Artists") or []
    disc = track.get("ParentIndexNumber")
    label = disc_label_from_path(track.get("Path"))

    return {
        "id": track.get("Id"),
        "title": track.get("Name"),
        "track_number": track.get("IndexNumber"),
        "disc": disc,
        "disc_label": label or (f"Disc {disc}" if disc else None),
        "duration": duration_seconds(track.get("RunTimeTicks")),
        "album": track.get("Album"),
        "album_id": track.get("AlbumId"),
        "artist": track.get("AlbumArtist") or (artists[0] if artists else None),
        "cover_url": image_url(track.get("AlbumId") or track.get("Id"))
    }


if __name__ == "__main__":
    app = AppClient()
    username = os.getenv("USERNAME")
    password = os.getenv("PASSWORD")

    if not username:
        raise SystemExit("Set USERNAME and PASSWORD in .env to try the client.")

    identity = app.login(username, password)
    user = app.for_user(identity["user_id"], identity["access_token"])

    for album in user.get_album_summaries():
        print(album)
