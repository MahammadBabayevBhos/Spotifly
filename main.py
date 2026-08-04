import os
import re
import json
import uuid
import time
import shutil
import tempfile
import urllib.parse
from datetime import datetime, date
from pathlib import Path
from typing import Optional, Dict, Any, List

import requests
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import mutagen
from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, ID3NoHeaderError
import yt_dlp

app = FastAPI(title="Spotifly - Spotify to MP3 Downloader", version="1.0.0")

# Enable CORS for local/PWA testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DOWNLOADS_DIR = BASE_DIR / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

DAILY_LIMIT = 5
# In-memory quota store: { client_ip: { "date": "YYYY-MM-DD", "count": int } }
quota_db: Dict[str, Dict[str, Any]] = {}

class ResolveRequest(BaseModel):
    query: str

class DownloadRequest(BaseModel):
    title: str
    artist: str
    album: Optional[str] = "Single"
    cover_url: Optional[str] = None
    yt_url: Optional[str] = None
    query: Optional[str] = None

def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"

def check_and_increment_quota(ip: str) -> Dict[str, Any]:
    """Quota limit is disabled (Unlimited downloads)."""
    return {"used": 0, "limit": "Limitsiz", "remaining": "Sonsuz"}

@app.get("/api/quota")
def get_quota(request: Request):
    return {
        "used": 0,
        "limit": "Limitsiz",
        "remaining": "Sonsuz ♾️"
    }

def clean_track_title(title: str) -> str:
    # Clean unwanted youtube/spotify tags like (Official Video), [LYRICS], etc.
    title = re.sub(r'[\(\[\{].*?(official|lyric|video|audio|hd|4k|visualizer).*?[\)\]\}]', '', title, flags=re.IGNORECASE)
    return title.strip()

def resolve_spotify_link(url: str) -> Dict[str, Any]:
    """Resolves Spotify Track / Album / Playlist URLs using oEmbed + iTunes HD Artwork Fallback."""
    try:
        # Strip query parameters like ?si=...
        clean_url = url.split("?")[0]
        
        # Spotify oEmbed endpoint
        oembed_url = f"https://open.spotify.com/oembed?url={urllib.parse.quote(clean_url)}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        res = requests.get(oembed_url, headers=headers, timeout=6)
        if res.status_code == 200:
            data = res.json()
            raw_title = data.get("title", "")
            thumbnail_url = data.get("thumbnail_url", "")
            
            title = clean_track_title(raw_title)
            artist = "Unknown Artist"
            album = "Spotify Release"

            if " by " in raw_title:
                parts = raw_title.rsplit(" by ", 1)
                title = clean_track_title(parts[0].strip())
                artist = parts[1].strip()

            # Try iTunes Search API with the resolved title to get exact artist & 600x600 HD cover
            try:
                search_term = f"{artist} {title}" if artist != "Unknown Artist" else title
                itunes_res = requests.get(
                    f"https://itunes.apple.com/search?term={urllib.parse.quote(search_term)}&media=music&limit=1",
                    timeout=4
                )
                if itunes_res.status_code == 200:
                    it_data = itunes_res.json()
                    if it_data.get("resultCount", 0) > 0:
                        item = it_data["results"][0]
                        artist = item.get("artistName", artist)
                        title = item.get("trackName", title)
                        album = item.get("collectionName", album)
                        artwork_hd = item.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
                        if artwork_hd:
                            thumbnail_url = artwork_hd
            except Exception as it_err:
                print(f"iTunes fallback error: {it_err}")

            return {
                "success": True,
                "title": title,
                "artist": artist,
                "album": album,
                "cover_url": thumbnail_url,
                "type": "spotify",
                "original_url": url
            }
    except Exception as e:
        print(f"Spotify resolve error: {e}")
    
    return None

def resolve_search_query(query: str) -> Dict[str, Any]:
    """Uses iTunes public API or yt-dlp search to get track info & high-res artwork."""
    # First try iTunes Search API for pristine music metadata & artwork
    try:
        itunes_url = f"https://itunes.apple.com/search?term={urllib.parse.quote(query)}&media=music&limit=1"
        res = requests.get(itunes_url, timeout=5)
        if res.status_code == 200:
            data = res.json()
            if data.get("resultCount", 0) > 0:
                item = data["results"][0]
                artwork = item.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
                return {
                    "success": True,
                    "title": item.get("trackName", query),
                    "artist": item.get("artistName", "Unknown Artist"),
                    "album": item.get("collectionName", "Single"),
                    "cover_url": artwork,
                    "type": "search",
                    "original_url": query
                }
    except Exception as e:
        print(f"iTunes API search error: {e}")

    # Fallback to yt-dlp search
    try:
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch1:{query}", download=False)
            if info and 'entries' in info and len(info['entries']) > 0:
                entry = info['entries'][0]
                title = entry.get('title', query)
                uploader = entry.get('uploader', 'Unknown Artist')
                cover = entry.get('thumbnail', '')
                return {
                    "success": True,
                    "title": clean_track_title(title),
                    "artist": uploader,
                    "album": "Single",
                    "cover_url": cover,
                    "type": "search",
                    "original_url": query
                }
    except Exception as e:
        print(f"yt-dlp search error: {e}")

    return {
        "success": True,
        "title": query.title(),
        "artist": "Unknown Artist",
        "album": "Single",
        "cover_url": "https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80",
        "type": "search",
        "original_url": query
    }

@app.post("/api/resolve")
def resolve_track(req: ResolveRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Axtarış üçün mahnı adı və ya Spotify linki daxil edin!")

    # Check if it's a Spotify URL
    if "open.spotify.com" in query or "spotify:" in query:
        result = resolve_spotify_link(query)
        if result:
            return result
        
    # Otherwise treat as search query (song title/artist)
    return resolve_search_query(query)

@app.get("/api/suggestions")
def get_suggestions(q: str):
    """Returns top 5 instant song search suggestions with artwork and artist info."""
    query = q.strip()
    if not query or len(query) < 2:
        return {"suggestions": []}
    
    try:
        url = f"https://itunes.apple.com/search?term={urllib.parse.quote(query)}&media=music&limit=5"
        res = requests.get(url, timeout=3)
        if res.status_code == 200:
            data = res.json()
            suggestions = []
            for item in data.get("results", []):
                suggestions.append({
                    "title": item.get("trackName", ""),
                    "artist": item.get("artistName", ""),
                    "album": item.get("collectionName", "Single"),
                    "cover_url": item.get("artworkUrl100", "").replace("100x100bb", "300x300bb"),
                    "query": f"{item.get('artistName', '')} - {item.get('trackName', '')}"
                })
            return {"suggestions": suggestions}
    except Exception as e:
        print(f"Suggestions error: {e}")
    
    return {"suggestions": []}

@app.get("/api/lyrics")
def get_lyrics(title: str, artist: str):
    """Fetches song lyrics from free open LrcLib API."""
    try:
        url = f"https://lrclib.net/api/get?artist_name={urllib.parse.quote(artist)}&track_name={urllib.parse.quote(title)}"
        res = requests.get(url, timeout=4)
        if res.status_code == 200:
            data = res.json()
            plain_lyrics = data.get("plainLyrics") or data.get("syncedLyrics")
            if plain_lyrics:
                return {"success": True, "lyrics": plain_lyrics}
    except Exception as e:
        print(f"Lyrics fetch error: {e}")
    
    return {"success": False, "lyrics": "Mahnı sözləri tapılmadı."}

def download_and_convert_mp3(search_term: str, output_path: str) -> str:
    """Downloads highest quality audio using yt-dlp and converts to 320kbps MP3 via FFmpeg."""
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': output_path,
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '320',
        }],
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"ytsearch1:{search_term} audio"])
    
    mp3_file = output_path + ".mp3"
    if not os.path.exists(mp3_file):
        # yt-dlp might output directly without extra .mp3 extension if outtmpl contained %
        if os.path.exists(output_path):
            mp3_file = output_path
    return mp3_file

def embed_metadata(mp3_path: str, title: str, artist: str, album: str, cover_url: Optional[str]):
    """Embeds ID3 Title, Artist, Album, and Cover Art into MP3 file using Mutagen."""
    try:
        try:
            audio = ID3(mp3_path)
        except ID3NoHeaderError:
            audio = ID3()

        audio.add(TIT2(encoding=3, text=title))
        audio.add(TPE1(encoding=3, text=artist))
        audio.add(TALB(encoding=3, text=album))

        # Download cover art if available
        if cover_url:
            try:
                img_res = requests.get(cover_url, timeout=5)
                if img_res.status_code == 200:
                    mime = img_res.headers.get('content-type', 'image/jpeg')
                    audio.add(APIC(
                        encoding=3,
                        mime=mime,
                        type=3,  # 3 is front cover
                        desc=u'Cover',
                        data=img_res.content
                    ))
            except Exception as img_err:
                print(f"Cover art embed error: {img_err}")

        audio.save(mp3_path)
    except Exception as e:
        print(f"ID3 Tagging error: {e}")

@app.post("/api/download")
def download_track(req: DownloadRequest, request: Request, background_tasks: BackgroundTasks):
    ip = get_client_ip(request)
    quota_info = check_and_increment_quota(ip)

    title = req.title.strip()
    artist = req.artist.strip()
    album = (req.album or "Single").strip()
    cover_url = req.cover_url

    search_term = f"{artist} - {title}"
    task_id = str(uuid.uuid4())[:8]
    temp_dir = tempfile.mkdtemp(prefix=f"mp3_{task_id}_")
    out_filename_base = os.path.join(temp_dir, "track")

    try:
        # Download and convert via yt-dlp + ffmpeg
        final_mp3_path = download_and_convert_mp3(search_term, out_filename_base)
        
        # Embed ID3 tags & Album Cover Art
        embed_metadata(final_mp3_path, title, artist, album, cover_url)

        # Increment quota only after successful download
        today_str = date.today().isoformat()
        if ip in quota_db and quota_db[ip]["date"] == today_str:
            quota_db[ip]["count"] += 1

        # Safe filename for Content-Disposition header
        safe_filename = re.sub(r'[^\w\s-]', '', f"{artist} - {title}").strip()
        if not safe_filename:
            safe_filename = "track"
        download_name = f"{safe_filename}.mp3"

        # Background task to clean up temp dir after sending file
        def cleanup():
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as e:
                print(f"Cleanup error: {e}")

        background_tasks.add_task(cleanup)

        return FileResponse(
            path=final_mp3_path,
            filename=download_name,
            media_type="audio/mpeg",
            headers={"Access-Control-Expose-Headers": "Content-Disposition"}
        )

    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Mahnını endirmək mümkün olmadı: {str(e)}")

# Mount static files
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
def read_root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return HTMLResponse("<h2>Spotifly Downloader Server Running</h2>")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
