document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const searchBtnText = document.getElementById('searchBtnText');
  const clearBtn = document.getElementById('clearBtn');
  const quickPasteBtn = document.getElementById('quickPasteBtn');
  const quotaText = document.getElementById('quotaText');
  const pwaBanner = document.getElementById('pwaBanner');
  const suggestionsDropdown = document.getElementById('suggestionsDropdown');

  const previewCard = document.getElementById('previewCard');
  const trackCover = document.getElementById('trackCover');
  const trackTitle = document.getElementById('trackTitle');
  const trackArtist = document.getElementById('trackArtist');
  const trackAlbum = document.getElementById('trackAlbum');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadBtnText = document.getElementById('downloadBtnText');

  const lyricsToggleBtn = document.getElementById('lyricsToggleBtn');
  const lyricsContainer = document.getElementById('lyricsContainer');
  const lyricsText = document.getElementById('lyricsText');

  const progressContainer = document.getElementById('progressContainer');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressText = document.getElementById('progressText');
  const progressPercent = document.getElementById('progressPercent');

  const historyCard = document.getElementById('historyCard');
  const historyList = document.getElementById('historyList');
  const toastContainer = document.getElementById('toastContainer');

  let currentResolvedTrack = null;
  let downloadHistory = JSON.parse(localStorage.getItem('spotifly_history') || '[]');
  let suggestionDebounceTimer = null;

  // Live Autocomplete Suggestions
  searchInput.addEventListener('input', () => {
    const val = searchInput.value.trim();
    clearBtn.style.display = val.length > 0 ? 'block' : 'none';

    clearTimeout(suggestionDebounceTimer);
    if (!val || val.startsWith('http')) {
      suggestionsDropdown.style.display = 'none';
      return;
    }

    suggestionDebounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggestions?q=${encodeURIComponent(val)}`);
        if (res.ok) {
          const data = await res.json();
          renderSuggestions(data.suggestions);
        }
      } catch (err) {
        console.log('Suggestions fetch err', err);
      }
    }, 280);
  });

  function renderSuggestions(items) {
    if (!items || items.length === 0) {
      suggestionsDropdown.style.display = 'none';
      return;
    }

    suggestionsDropdown.innerHTML = items.map(item => `
      <div class="suggestion-item" data-query="${item.query.replace(/"/g, '&quot;')}">
        <img src="${item.cover_url || 'https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80'}" class="suggestion-img" alt="Cover">
        <div class="suggestion-details">
          <div class="suggestion-title">${item.title}</div>
          <div class="suggestion-artist">${item.artist} &bull; ${item.album}</div>
        </div>
      </div>
    `).join('');

    suggestionsDropdown.style.display = 'block';

    // Click suggestion listener
    suggestionsDropdown.querySelectorAll('.suggestion-item').forEach(el => {
      el.addEventListener('click', () => {
        const selectedQuery = el.getAttribute('data-query');
        searchInput.value = selectedQuery;
        suggestionsDropdown.style.display = 'none';
        handleSearch();
      });
    });
  }

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-wrapper')) {
      suggestionsDropdown.style.display = 'none';
    }
  });

  // Check iOS Safari to show PWA banner
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  // iPadOS may identify itself as macOS while still behaving like iOS Safari.
  const isIOSDevice = isIOS || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isStandalone) {
    pwaBanner.style.display = 'flex';
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js?v=1.0.9').catch(err => console.log('SW registration failed', err));
  }

  // Fetch initial quota
  updateQuota();
  renderHistory();

  // Search input events
  searchInput.addEventListener('input', () => {
    clearBtn.style.display = searchInput.value.length > 0 ? 'block' : 'none';
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    searchInput.focus();
    previewCard.style.display = 'none';
  });

  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
  });

  searchBtn.addEventListener('click', handleSearch);

  // Quick Paste Button
  quickPasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        searchInput.value = text.strip ? text.strip() : text.trim();
        clearBtn.style.display = 'block';
        handleSearch();
        showToast('Link paneldən yapışdırıldı!', 'success');
      }
    } catch (err) {
      showToast('Kopyalanmış mətni oxumaq üçün icazə verin və ya mətni özünüz yapışdırın', 'error');
    }
  });

  async function updateQuota() {
    try {
      const res = await fetch('/api/quota');
      if (res.ok) {
        const data = await res.json();
        quotaText.textContent = `${data.remaining} / ${data.limit} Pulsuz`;
      }
    } catch (e) {
      console.log('Quota fetch error', e);
    }
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    toast.innerHTML = `<span>${msg}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) {
      showToast('Zəhmət olmasa Spotify linki və ya mahnı adı daxil edin!', 'error');
      return;
    }

    setSearchLoading(true);
    previewCard.style.display = 'none';

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Mahnı məlumatları tapılmadı!');
      }

      currentResolvedTrack = data;
      renderPreview(data);
      showToast('Mahnı uğurla tapıldı! ✨', 'success');

    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSearchLoading(false);
    }
  }

  function setSearchLoading(isLoading) {
    searchBtn.disabled = isLoading;
    if (isLoading) {
      searchBtnText.textContent = 'Axtarılır...';
      searchBtn.insertAdjacentHTML('afterbegin', '<div class="spinner"></div>');
    } else {
      searchBtnText.textContent = 'Mahnını Tap';
      const spinner = searchBtn.querySelector('.spinner');
      if (spinner) spinner.remove();
    }
  }

  function renderPreview(track) {
    trackTitle.textContent = track.title;
    trackArtist.textContent = track.artist;
    trackAlbum.textContent = track.album || 'Single';
    trackCover.src = track.cover_url || 'https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80';
    
    progressContainer.style.display = 'none';
    lyricsContainer.style.display = 'none';
    lyricsText.textContent = 'Yüklənir...';
    downloadBtn.disabled = false;
    downloadBtnText.textContent = 'MP3 Kimi Endir (320kbps)';
    previewCard.style.display = 'block';

    // Scroll to preview on mobile
    previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Lyrics Toggle Handler
  lyricsToggleBtn.addEventListener('click', async () => {
    if (!currentResolvedTrack) return;
    if (lyricsContainer.style.display === 'block') {
      lyricsContainer.style.display = 'none';
      return;
    }

    lyricsContainer.style.display = 'block';
    lyricsText.textContent = 'Mahnı sözləri axtarılır... 🔍';

    try {
      const res = await fetch(`/api/lyrics?title=${encodeURIComponent(currentResolvedTrack.title)}&artist=${encodeURIComponent(currentResolvedTrack.artist)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.lyrics) {
          lyricsText.textContent = data.lyrics;
        } else {
          lyricsText.textContent = 'Açıq bazada bu mahnının sözləri tapılmadı.';
        }
      }
    } catch (e) {
      lyricsText.textContent = 'Sözləri yükləmək mümkün olmadı.';
    }
  });

  // IndexedDB for Offline Music Storage inside Web App
  let db = null;
  const DB_NAME = 'SpotiflyOfflineDB';
  const STORE_NAME = 'tracks';

  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
        renderOfflineLibrary();
      };
      request.onerror = (e) => reject(e);
    });
  }

  initDB();

  async function saveTrackOffline(trackMeta, audioBlob) {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      return new Promise((resolve, reject) => {
        if (!db) return reject('DB not ready');
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const record = {
          title: trackMeta.title,
          artist: trackMeta.artist,
          album: trackMeta.album || 'Single',
          cover_url: trackMeta.cover_url,
          audioBuffer: arrayBuffer,
          mimeType: audioBlob.type || 'audio/mpeg',
          date: new Date().toLocaleDateString()
        };

        const req = store.add(record);
        req.onsuccess = () => {
          renderOfflineLibrary();
          resolve(true);
        };
        req.onerror = (err) => {
          console.error('IndexedDB save error:', err);
          reject(err);
        };
      });
    } catch (err) {
      console.error('ArrayBuffer conversion error:', err);
    }
  }

  function getOfflineTracks() {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  function deleteOfflineTrack(id) {
    return new Promise((resolve) => {
      if (!db) return resolve(false);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => {
        renderOfflineLibrary();
        resolve(true);
      };
    });
  }

  // Audio Player UI Elements
  const playerBar = document.getElementById('playerBar');
  const audioElement = document.getElementById('audioElement');
  const playerCover = document.getElementById('playerCover');
  const playerTitle = document.getElementById('playerTitle');
  const playerArtist = document.getElementById('playerArtist');
  const playerPlayBtn = document.getElementById('playerPlayBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const playerSeek = document.getElementById('playerSeek');
  const offlineList = document.getElementById('offlineList');
  const offlineCountBadge = document.getElementById('offlineCountBadge');

  let currentPlayingUrl = null;

  async function renderOfflineLibrary() {
    const tracks = await getOfflineTracks();
    offlineCountBadge.textContent = `${tracks.length} Mahnı`;

    if (tracks.length === 0) {
      offlineList.innerHTML = `<div class="empty-offline-text">Hələ oflayn mahnı yoxdur. Mahnı endirdikdə bura avtomatik yaddaşa yazılacaq!</div>`;
      return;
    }

    offlineList.innerHTML = tracks.map(t => `
      <div class="history-item">
        <img src="${t.cover_url || 'https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80'}" class="history-img" alt="Cover">
        <div class="history-info">
          <div class="history-title">${t.title}</div>
          <div class="history-artist">${t.artist} &bull; Oflayn</div>
        </div>
        <button class="offline-play-btn" data-id="${t.id}">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="offline-del-btn" data-del-id="${t.id}">&times;</button>
      </div>
    `).join('');

    // Attach listeners
    offlineList.querySelectorAll('.offline-play-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.getAttribute('data-id'));
        const track = tracks.find(x => x.id === id);
        if (track) playOfflineAudio(track);
      });
    });

    offlineList.querySelectorAll('.offline-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-del-id'));
        await deleteOfflineTrack(id);
        showToast('Mahnı oflayn kitabxanadan silindi', 'info');
      });
    });
  }

  function playOfflineAudio(track) {
    if (currentPlayingUrl) {
      URL.revokeObjectURL(currentPlayingUrl);
    }

    const blob = track.audioBlob || new Blob([track.audioBuffer], { type: track.mimeType || 'audio/mpeg' });
    currentPlayingUrl = URL.createObjectURL(blob);
    audioElement.src = currentPlayingUrl;
    playerCover.src = track.cover_url || 'https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80';
    playerTitle.textContent = track.title;
    playerArtist.textContent = track.artist;

    playerBar.style.display = 'flex';
    audioElement.play();
    updatePlayPauseState(true);
  }

  playerPlayBtn.addEventListener('click', () => {
    if (audioElement.paused) {
      audioElement.play();
      updatePlayPauseState(true);
    } else {
      audioElement.pause();
      updatePlayPauseState(false);
    }
  });

  function updatePlayPauseState(isPlaying) {
    if (isPlaying) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
  }

  audioElement.addEventListener('timeupdate', () => {
    if (audioElement.duration) {
      const pct = (audioElement.currentTime / audioElement.duration) * 100;
      playerSeek.value = pct;
    }
  });

  playerSeek.addEventListener('input', () => {
    if (audioElement.duration) {
      audioElement.currentTime = (playerSeek.value / 100) * audioElement.duration;
    }
  });

  // Lyrics Toggle Handler
  const handleLyricsClick = async (e) => {
    if (e) e.preventDefault();
    let track = currentResolvedTrack;
    if (!track) {
      const title = trackTitle.textContent.trim();
      const artist = trackArtist.textContent.trim();
      if (title && artist && title !== 'Track Title') {
        track = { title, artist };
      }
    }

    if (!track) {
      showToast('İlk öncə mahnını tapın!', 'error');
      return;
    }

    if (lyricsContainer.style.display === 'block') {
      lyricsContainer.style.display = 'none';
      return;
    }

    lyricsContainer.style.display = 'block';
    lyricsText.textContent = 'Mahnı sözləri axtarılır... 🔍';

    try {
      const res = await fetch(`/api/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.lyrics) {
          lyricsText.textContent = data.lyrics;
        } else {
          lyricsText.textContent = 'Açıq bazada bu mahnının sözləri tapılmadı.';
        }
      }
    } catch (err) {
      lyricsText.textContent = 'Sözləri yükləmək mümkün olmadı.';
    }
  };

  // The handler above is the single lyrics click handler. Registering both
  // handlers makes the second one immediately hide the lyrics panel again.

  // Updated Download Handler (Saves to IndexedDB for offline play + triggers MP3 download)
  const handleDownloadClick = async (e) => {
    if (e) e.preventDefault();

    let trackToDownload = currentResolvedTrack;
    if (!trackToDownload) {
      const title = trackTitle.textContent.trim();
      const artist = trackArtist.textContent.trim();
      if (title && artist && title !== 'Track Title') {
        trackToDownload = {
          title: title,
          artist: artist,
          album: trackAlbum.textContent.trim() || 'Single',
          cover_url: trackCover.src
        };
      }
    }

    if (!trackToDownload) {
      showToast('Zəhmət olmasa ilk öncə mahnını tapın!', 'error');
      return;
    }

    downloadBtn.disabled = true;
    progressContainer.style.display = 'block';
    
    let progress = 10;
    updateProgress(progress, 'Spotify & Audio axını axtarılır...');

    const interval = setInterval(() => {
      if (progress < 85) {
        progress += Math.floor(Math.random() * 8) + 3;
        let statusMsg = 'Audio endirilir...';
        if (progress > 35) statusMsg = '320kbps MP3 formatına çevrilir (FFmpeg)...';
        if (progress > 65) statusMsg = 'Albom şəkli (ID3 tags) mahnıya yazılır...';
        updateProgress(progress, statusMsg);
      }
    }, 600);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trackToDownload)
      });

      clearInterval(interval);

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.detail || 'Endirmə xətası baş verdi.');
      }

      updateProgress(100, 'Tətbiq daxilinə yaddaşa yazılır...');

      const blob = await res.blob();

      // Save to App's internal IndexedDB for Offline playback inside Web App!

      // Trigger standard MP3 download for Files/Downloads
      const disposition = res.headers.get('Content-Disposition');
      let filename = `${trackToDownload.artist} - ${trackToDownload.title}.mp3`;
      if (disposition && disposition.includes('filename=')) {
        const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
        if (matches != null && matches[1]) {
          filename = matches[1].replace(/['"]/g, '');
        }
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      if (isIOSDevice) {
        // iOS Safari does not reliably honor download= for blob URLs. Keep a
        // visible user-initiated link so Safari can open the MP3 and the user
        // can choose Share -> Save to Files.
        a.className = 'btn-primary ios-save-link';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'MP3-ni aç / Files-a saxla';
        a.style.display = 'flex';
        a.style.alignItems = 'center';
        a.style.justifyContent = 'center';
        a.style.textDecoration = 'none';
        document.querySelector('.download-action')?.appendChild(a);
      } else {
        a.style.display = 'none';
        a.download = filename;
        document.body.appendChild(a);
        a.click();
      }

      // Offline storage is optional and must never block the real MP3 download.
      try {
        await saveTrackOffline(trackToDownload, blob);
      } catch (storageError) {
        console.warn('Offline storage skipped:', storageError);
      }

      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        a.remove();
      }, isIOSDevice ? 5 * 60 * 1000 : 1000);

      showToast(
        isIOSDevice
          ? 'MP3 hazırdır. Açılan düyməyə basın, sonra Paylaş -> Save to Files seçin.'
          : 'Mahnı oflayn kitabxanaya əlavə olundu və MP3 yükləndi! 🎶',
        'success'
      );

    } catch (err) {
      clearInterval(interval);
      showToast(err.message, 'error');
      progressContainer.style.display = 'none';
    } finally {
      downloadBtn.disabled = false;
    }
  };

  downloadBtn.addEventListener('click', handleDownloadClick);

  audioElement.addEventListener('ended', () => {
    updatePlayPauseState(false);
  });

  function updateProgress(percent, text) {
    progressBarFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    progressText.textContent = text;
  }

  function addToHistory(track) {
    // Avoid duplicates
    downloadHistory = downloadHistory.filter(item => item.title !== track.title);
    downloadHistory.unshift({
      title: track.title,
      artist: track.artist,
      cover_url: track.cover_url,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    if (downloadHistory.length > 5) downloadHistory.pop();
    localStorage.setItem('spotifly_history', JSON.stringify(downloadHistory));
    renderHistory();
  }

  function renderHistory() {
    // The history card is optional in the compact production layout.
    // Do not stop the rest of the app when that optional section is absent.
    if (!historyCard || !historyList) return;

    if (downloadHistory.length === 0) {
      historyCard.style.display = 'none';
      return;
    }
    historyCard.style.display = 'block';
    historyList.innerHTML = downloadHistory.map(item => `
      <div class="history-item">
        <img src="${item.cover_url || 'https://images.unsplash.com/photo-1614680376593-902f749f704b?w=600&auto=format&fit=crop&q=80'}" class="history-img" alt="Cover">
        <div class="history-info">
          <div class="history-title">${item.title}</div>
          <div class="history-artist">${item.artist} &bull; ${item.timestamp}</div>
        </div>
      </div>
    `).join('');
  }
});
