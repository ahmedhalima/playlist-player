(() => {
  'use strict';

  // ---------- State ----------

  let state = { playlists: [], settings: { quality: 'medium' } };
  let activePlaylistId = null;
  let currentVideoIndex = -1;      // index within the active playlist's videos
  let currentPlayerType = null;    // 'youtube' | 'local' | null
  let ytPlayer = null;
  let ytReady = false;
  let pendingVideoIdToLoad = null;
  let saveTimer = null;
  let editingIndex = -1;
  let editingType = null;

  const REPEAT_MODES = ['off', 'all', 'one'];
  const REPEAT_LABELS = { off: 'Repeat: Off', all: 'Repeat: All', one: 'Repeat: One' };

  const localPlayerEl = () => document.getElementById('localPlayer');

  // ---------- Helpers ----------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function extractVideoId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return null;
  }

  function baseNameWithoutExt(filePath) {
    const parts = filePath.split(/[\\/]/);
    const last = parts[parts.length - 1] || filePath;
    return last.replace(/\.[^.]+$/, '');
  }

  async function fetchTitle(url) {
    try {
      const res = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url) + '&format=json');
      if (!res.ok) throw new Error('bad response');
      const json = await res.json();
      return json.title || null;
    } catch (err) {
      return null;
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.api.saveData(state);
    }, 250);
  }

  function getActivePlaylist() {
    return state.playlists.find(p => p.id === activePlaylistId) || null;
  }

  function getPreferredQuality() {
    return (state.settings && state.settings.quality) || 'medium';
  }

  function localVideoSrc(filePath) {
    return 'local-video://stream?path=' + encodeURIComponent(filePath);
  }

  // ---------- Rendering ----------

  function renderSidebar() {
    const nav = document.getElementById('playlistNav');
    nav.innerHTML = '';
    state.playlists.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'playlist-nav-item' + (pl.id === activePlaylistId ? ' active' : '');
      item.innerHTML = `<span class="name"></span><span class="count">${pl.videos.length}</span>`;
      item.querySelector('.name').textContent = pl.name;
      item.addEventListener('click', () => selectPlaylist(pl.id));
      nav.appendChild(item);
    });
  }

  function renderPlaylistPanel() {
    const empty = document.getElementById('emptyState');
    const panel = document.getElementById('playlistPanel');
    const playlist = getActivePlaylist();

    if (!playlist) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }

    empty.hidden = true;
    panel.hidden = false;

    document.getElementById('playlistTitle').textContent = playlist.name;
    hideRenameForm();

    renderVideoList();
    updateRepeatButton();
  }

  function renderVideoList() {
    const playlist = getActivePlaylist();
    const list = document.getElementById('videoList');
    list.innerHTML = '';
    if (!playlist) return;

    playlist.videos.forEach((video, idx) => {
      const li = document.createElement('li');
      li.className = 'video-row' + (idx === currentVideoIndex ? ' playing' : '');

      const indexEl = document.createElement('div');
      indexEl.className = 'video-index';
      indexEl.textContent = String(idx + 1);

      const metaEl = document.createElement('div');
      metaEl.className = 'video-meta';
      const badge = video.type === 'local' ? '<span class="video-badge">Local</span>' : '';
      metaEl.innerHTML = `<div class="video-title">${badge}<span class="video-title-text"></span></div><div class="video-url"></div>`;
      metaEl.querySelector('.video-title-text').textContent = video.title;
      metaEl.querySelector('.video-url').textContent = video.type === 'local' ? video.filePath : video.url;
      metaEl.addEventListener('click', () => playVideoAt(idx));

      const actionsEl = document.createElement('div');
      actionsEl.className = 'video-actions';
      actionsEl.innerHTML = `
        <button class="icon-btn" data-action="up" title="Move up">↑</button>
        <button class="icon-btn" data-action="down" title="Move down">↓</button>
        <button class="icon-btn" data-action="edit" title="Edit">✎</button>
        <button class="icon-btn danger" data-action="delete" title="Delete">✕</button>
      `;
      actionsEl.querySelector('[data-action="up"]').addEventListener('click', (e) => { e.stopPropagation(); moveVideo(idx, -1); });
      actionsEl.querySelector('[data-action="down"]').addEventListener('click', (e) => { e.stopPropagation(); moveVideo(idx, 1); });
      actionsEl.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openEditModal(idx); });
      actionsEl.querySelector('[data-action="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteVideo(idx); });

      li.appendChild(indexEl);
      li.appendChild(metaEl);
      li.appendChild(actionsEl);
      list.appendChild(li);
    });
  }

  function updateRepeatButton() {
    const playlist = getActivePlaylist();
    const btn = document.getElementById('repeatBtn');
    const mode = playlist ? (playlist.repeatMode || 'off') : 'off';
    btn.textContent = REPEAT_LABELS[mode];
    btn.classList.toggle('active', mode !== 'off');
  }

  function updateNowPlaying() {
    const playlist = getActivePlaylist();
    const label = document.getElementById('nowPlayingLabel');
    if (!playlist || currentVideoIndex < 0 || !playlist.videos[currentVideoIndex]) {
      label.textContent = 'Nothing playing';
      return;
    }
    label.textContent = playlist.videos[currentVideoIndex].title;
  }

  function updatePlayPauseIcon(isPlaying) {
    document.getElementById('playPauseBtn').textContent = isPlaying ? '⏸' : '▶';
  }

  // ---------- Playlist CRUD ----------

  function createPlaylist() {
    const playlist = { id: uid(), name: 'New Playlist', repeatMode: 'off', videos: [] };
    state.playlists.push(playlist);
    activePlaylistId = playlist.id;
    currentVideoIndex = -1;
    scheduleSave();
    renderSidebar();
    renderPlaylistPanel();
    showRenameForm();
  }

  function selectPlaylist(id) {
    activePlaylistId = id;
    currentVideoIndex = -1;
    resetPlayerToPlaceholder();
    scheduleSave();
    renderSidebar();
    renderPlaylistPanel();
  }

  function showRenameForm() {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    document.getElementById('renamePlaylistInput').value = playlist.name;
    document.getElementById('renamePlaylistForm').hidden = false;
    const input = document.getElementById('renamePlaylistInput');
    input.focus();
    input.select();
  }

  function hideRenameForm() {
    document.getElementById('renamePlaylistForm').hidden = true;
  }

  function renamePlaylist(newName) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const trimmed = newName.trim();
    playlist.name = trimmed || playlist.name;
    scheduleSave();
    renderSidebar();
    document.getElementById('playlistTitle').textContent = playlist.name;
    hideRenameForm();
  }

  function deletePlaylist() {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const ok = confirm(`Delete "${playlist.name}"? This cannot be undone.`);
    if (!ok) return;
    state.playlists = state.playlists.filter(p => p.id !== playlist.id);
    activePlaylistId = null;
    currentVideoIndex = -1;
    resetPlayerToPlaceholder();
    scheduleSave();
    renderSidebar();
    renderPlaylistPanel();
  }

  // ---------- Video CRUD ----------

  async function addYoutubeVideo(url, titleOverride) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const videoId = extractVideoId(url);
    if (!videoId) {
      alert('That doesn\'t look like a valid YouTube URL. Try a link like https://www.youtube.com/watch?v=... or https://youtu.be/...');
      return;
    }

    let title = titleOverride && titleOverride.trim();
    if (!title) {
      title = await fetchTitle(url) || 'Untitled video';
    }

    playlist.videos.push({ id: uid(), type: 'youtube', url, videoId, title });
    scheduleSave();
    renderSidebar();
    renderVideoList();
  }

  function addLocalVideos(filePaths) {
    const playlist = getActivePlaylist();
    if (!playlist || !filePaths || filePaths.length === 0) return;
    filePaths.forEach(filePath => {
      playlist.videos.push({ id: uid(), type: 'local', filePath, title: baseNameWithoutExt(filePath) });
    });
    scheduleSave();
    renderSidebar();
    renderVideoList();
  }

  function deleteVideo(index) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    playlist.videos.splice(index, 1);
    if (currentVideoIndex === index) {
      currentVideoIndex = -1;
      resetPlayerToPlaceholder();
    } else if (currentVideoIndex > index) {
      currentVideoIndex -= 1;
    }
    scheduleSave();
    renderSidebar();
    renderVideoList();
    updateNowPlaying();
  }

  function moveVideo(index, delta) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= playlist.videos.length) return;
    const [item] = playlist.videos.splice(index, 1);
    playlist.videos.splice(newIndex, 0, item);
    if (currentVideoIndex === index) currentVideoIndex = newIndex;
    else if (currentVideoIndex === newIndex) currentVideoIndex = index;
    scheduleSave();
    renderVideoList();
  }

  function openEditModal(index) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    editingIndex = index;
    const video = playlist.videos[index];
    editingType = video.type;

    document.getElementById('editTitleInput').value = video.title;

    const urlLabel = document.getElementById('editUrlLabel');
    const urlInput = document.getElementById('editUrlInput');
    const browseBtn = document.getElementById('editBrowseBtn');

    if (video.type === 'local') {
      urlLabel.firstChild.textContent = 'File path';
      urlInput.value = video.filePath;
      urlInput.readOnly = true;
      browseBtn.hidden = false;
    } else {
      urlLabel.firstChild.textContent = 'URL';
      urlInput.value = video.url;
      urlInput.readOnly = false;
      browseBtn.hidden = true;
    }

    document.getElementById('editModal').hidden = false;
  }

  function closeEditModal() {
    editingIndex = -1;
    editingType = null;
    document.getElementById('editModal').hidden = true;
  }

  async function browseForReplacementFile() {
    const files = await window.api.selectLocalVideoFiles();
    if (files && files.length > 0) {
      document.getElementById('editUrlInput').value = files[0];
    }
  }

  function saveEditModal() {
    const playlist = getActivePlaylist();
    if (!playlist || editingIndex < 0) return;
    const newTitle = document.getElementById('editTitleInput').value.trim();
    const video = playlist.videos[editingIndex];

    if (editingType === 'local') {
      const newPath = document.getElementById('editUrlInput').value.trim();
      if (!newPath) {
        alert('A file path is required.');
        return;
      }
      video.filePath = newPath;
      video.title = newTitle || baseNameWithoutExt(newPath);

      if (editingIndex === currentVideoIndex && currentPlayerType === 'local') {
        const el = localPlayerEl();
        el.src = localVideoSrc(video.filePath);
        el.play().catch(() => {});
      }
    } else {
      const newUrl = document.getElementById('editUrlInput').value.trim();
      const newVideoId = extractVideoId(newUrl);
      if (!newVideoId) {
        alert('That doesn\'t look like a valid YouTube URL.');
        return;
      }
      video.title = newTitle || video.title;
      video.url = newUrl;
      video.videoId = newVideoId;

      if (editingIndex === currentVideoIndex && currentPlayerType === 'youtube' && ytPlayer && ytReady) {
        ytPlayer.loadVideoById({ videoId: newVideoId, suggestedQuality: getPreferredQuality() });
      }
    }

    scheduleSave();
    renderVideoList();
    updateNowPlaying();
    closeEditModal();
  }

  // ---------- Player ----------

  function resetPlayerToPlaceholder() {
    document.getElementById('playerPlaceholder').style.display = 'flex';
    document.getElementById('player').style.display = '';
    localPlayerEl().style.display = 'none';
    currentPlayerType = null;
    updatePlayPauseIcon(false);
    updateNowPlaying();
    if (ytPlayer && ytReady) {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    const el = localPlayerEl();
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  function playVideoAt(index) {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.videos[index]) return;
    currentVideoIndex = index;
    const video = playlist.videos[index];

    document.getElementById('playerPlaceholder').style.display = 'none';

    if (video.type === 'local') {
      // Stop any YouTube playback and switch views to the local <video> element.
      if (ytPlayer && ytReady) {
        try { ytPlayer.stopVideo(); } catch (e) {}
      }
      document.getElementById('player').style.display = 'none';
      const el = localPlayerEl();
      el.style.display = 'block';
      el.src = localVideoSrc(video.filePath);
      el.currentTime = 0;
      el.play().catch(() => {});
      currentPlayerType = 'local';
    } else {
      // Stop any local playback and switch views to the YouTube player.
      const el = localPlayerEl();
      el.pause();
      el.style.display = 'none';
      document.getElementById('player').style.display = '';
      currentPlayerType = 'youtube';

      if (ytReady && ytPlayer) {
        ytPlayer.loadVideoById({ videoId: video.videoId, suggestedQuality: getPreferredQuality() });
        ytPlayer.playVideo();
      } else {
        pendingVideoIdToLoad = video.videoId;
      }
    }

    renderVideoList();
    updateNowPlaying();
  }

  function playPauseToggle() {
    if (currentVideoIndex < 0) {
      const playlist = getActivePlaylist();
      if (playlist && playlist.videos.length > 0) playVideoAt(0);
      return;
    }

    if (currentPlayerType === 'local') {
      const el = localPlayerEl();
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      return;
    }

    if (!ytPlayer || !ytReady) return;
    const playerState = ytPlayer.getPlayerState();
    if (playerState === YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
  }

  function playNext(fromAutoAdvance) {
    const playlist = getActivePlaylist();
    if (!playlist || playlist.videos.length === 0) return;
    const mode = playlist.repeatMode || 'off';

    if (fromAutoAdvance && mode === 'one') {
      if (currentPlayerType === 'local') {
        const el = localPlayerEl();
        el.currentTime = 0;
        el.play().catch(() => {});
      } else if (ytPlayer && ytReady) {
        ytPlayer.seekTo(0);
        ytPlayer.playVideo();
      }
      return;
    }

    let nextIndex = currentVideoIndex + 1;
    if (nextIndex >= playlist.videos.length) {
      if (fromAutoAdvance && mode !== 'all') {
        updatePlayPauseIcon(false);
        return;
      }
      nextIndex = 0;
    }
    playVideoAt(nextIndex);
  }

  function playPrev() {
    const playlist = getActivePlaylist();
    if (!playlist || playlist.videos.length === 0) return;
    let prevIndex = currentVideoIndex - 1;
    if (prevIndex < 0) prevIndex = playlist.videos.length - 1;
    playVideoAt(prevIndex);
  }

  function cycleRepeatMode() {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const current = playlist.repeatMode || 'off';
    const idx = REPEAT_MODES.indexOf(current);
    playlist.repeatMode = REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
    scheduleSave();
    updateRepeatButton();
  }

  // YouTube IFrame API callback (must be a global)
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, origin: window.location.origin },
      events: {
        onReady: () => {
          ytReady = true;
          if (pendingVideoIdToLoad) {
            ytPlayer.loadVideoById({ videoId: pendingVideoIdToLoad, suggestedQuality: getPreferredQuality() });
            pendingVideoIdToLoad = null;
          }
        },
        onStateChange: (event) => {
          if (currentPlayerType !== 'youtube') return;
          if (event.data === YT.PlayerState.PLAYING) updatePlayPauseIcon(true);
          if (event.data === YT.PlayerState.PAUSED) updatePlayPauseIcon(false);
          if (event.data === YT.PlayerState.BUFFERING || event.data === YT.PlayerState.PLAYING) {
            // YouTube can silently override the requested quality once a video
            // actually starts streaming, so re-assert our preference here too.
            try { ytPlayer.setPlaybackQuality(getPreferredQuality()); } catch (e) {}
          }
          if (event.data === YT.PlayerState.ENDED) {
            updatePlayPauseIcon(false);
            playNext(true);
          }
        }
      }
    });
  };

  // ---------- Wiring ----------

  function wireEvents() {
    document.getElementById('newPlaylistBtn').addEventListener('click', createPlaylist);
    document.getElementById('deletePlaylistBtn').addEventListener('click', deletePlaylist);

    document.getElementById('renamePlaylistBtn').addEventListener('click', showRenameForm);
    document.getElementById('renameCancelBtn').addEventListener('click', hideRenameForm);
    document.getElementById('renamePlaylistForm').addEventListener('submit', (e) => {
      e.preventDefault();
      renamePlaylist(document.getElementById('renamePlaylistInput').value);
    });

    document.getElementById('addVideoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById('videoUrlInput');
      const titleInput = document.getElementById('videoTitleInput');
      const url = urlInput.value.trim();
      if (!url) return;
      await addYoutubeVideo(url, titleInput.value);
      urlInput.value = '';
      titleInput.value = '';
      urlInput.focus();
    });

    document.getElementById('addLocalBtn').addEventListener('click', async () => {
      const files = await window.api.selectLocalVideoFiles();
      addLocalVideos(files);
    });

    document.getElementById('prevBtn').addEventListener('click', playPrev);
    document.getElementById('nextBtn').addEventListener('click', () => playNext(false));
    document.getElementById('playPauseBtn').addEventListener('click', playPauseToggle);
    document.getElementById('repeatBtn').addEventListener('click', cycleRepeatMode);

    document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
    document.getElementById('editSaveBtn').addEventListener('click', saveEditModal);
    document.getElementById('editBrowseBtn').addEventListener('click', browseForReplacementFile);

    document.getElementById('qualitySelect').addEventListener('change', (e) => {
      if (!state.settings) state.settings = {};
      state.settings.quality = e.target.value;
      scheduleSave();
      if (currentPlayerType === 'youtube' && ytPlayer && ytReady) {
        try { ytPlayer.setPlaybackQuality(e.target.value); } catch (err) {}
      }
    });

    const local = localPlayerEl();
    local.addEventListener('play', () => { if (currentPlayerType === 'local') updatePlayPauseIcon(true); });
    local.addEventListener('pause', () => { if (currentPlayerType === 'local') updatePlayPauseIcon(false); });
    local.addEventListener('ended', () => { if (currentPlayerType === 'local') playNext(true); });
  }

  // ---------- Init ----------

  async function init() {
    state = await window.api.loadData();
    if (!state || !Array.isArray(state.playlists)) state = { playlists: [] };
    if (!state.settings) state.settings = {};
    if (!state.settings.quality) state.settings.quality = 'medium';
    state.playlists.forEach(p => {
      if (!p.repeatMode) p.repeatMode = 'off';
      p.videos.forEach(v => { if (!v.type) v.type = 'youtube'; });
    });

    wireEvents();
    document.getElementById('qualitySelect').value = state.settings.quality;
    renderSidebar();
    renderPlaylistPanel();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
