(() => {
  'use strict';

  // ---------- State ----------

  let state = { playlists: [], settings: { quality: 'medium' } };
  let activePlaylistId = null;
  let currentVideoIndex = -1;      // index within the active playlist's videos
  let currentPlayerType = null;    // 'youtube' | 'local' | null
  let ytPlayer = null;
  let ytReady = false;
  let ytLoadFailed = false;
  let pendingVideoIdToLoad = null;
  let saveTimer = null;
  let editingIndex = -1;
  let editingType = null;
  let draggedVideoIndex = null;

  const REPEAT_MODES = ['off', 'all', 'one'];
  const REPEAT_LABELS = { off: 'Repeat: Off', all: 'Repeat: All', one: 'Repeat: One' };
  const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ogv'];

  const localPlayerEl = () => document.getElementById('localPlayer');

  // ---------- Helpers ----------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function extractYouTubeId(url) {
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

  function looksLikeLocalVideoPath(line) {
    const m = line.match(/\.([a-zA-Z0-9]+)$/);
    if (!m) return false;
    return VIDEO_EXTENSIONS.includes(m[1].toLowerCase());
  }

  function dragHasFiles(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  }

  // Resolves a drop event's dropped File objects down to real filesystem
  // paths, keeping only ones that look like a supported video file.
  function extractDroppedVideoPaths(dataTransfer) {
    const paths = [];
    if (!dataTransfer || !dataTransfer.files) return paths;
    for (const file of dataTransfer.files) {
      const filePath = window.api.getFilePath(file);
      if (filePath && looksLikeLocalVideoPath(filePath)) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  function baseNameWithoutExt(filePath) {
    const parts = filePath.split(/[\\/]/);
    const last = parts[parts.length - 1] || filePath;
    return last.replace(/\.[^.]+$/, '');
  }

  function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '—';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Reads a local video file's duration by loading just its metadata (the
  // local-video:// protocol supports byte ranges, so this only pulls the
  // small chunk of the file needed for that, not the whole thing).
  function probeLocalDuration(video) {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.style.cssText = 'position:absolute; width:0; height:0; opacity:0; pointer-events:none;';

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      probe.removeAttribute('src');
      probe.load();
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    };

    probe.addEventListener('loadedmetadata', () => {
      if (isFinite(probe.duration) && probe.duration > 0) {
        video.duration = probe.duration;
        scheduleSave();
        if (getActivePlaylist() && getActivePlaylist().videos.includes(video)) {
          renderVideoList();
        }
      }
      cleanup();
    });
    probe.addEventListener('error', cleanup);
    setTimeout(cleanup, 15000); // give up quietly if the file is missing/broken

    probe.src = localVideoSrc(video.filePath);
    document.body.appendChild(probe);
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

  function exitFullscreenIfActive() {
    // If a video is in HTML5 fullscreen when we swap players (e.g. auto-
    // advancing from a local file to a YouTube video or vice versa), hiding
    // the old element forces the browser to silently drop element-level
    // fullscreen — but Electron's window-level fullscreen (which mirrors it)
    // doesn't get told to exit, leaving a fullscreen window wrapped around a
    // normal-sized player. Exiting explicitly here keeps both in sync.
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) {}
    }
  }

  const DEFAULT_PLACEHOLDER_TEXT = 'Pick a video from the queue to start playing.';

  function showPlaceholder(text, showRetry) {
    document.getElementById('playerPlaceholderText').textContent = text || DEFAULT_PLACEHOLDER_TEXT;
    document.getElementById('playerRetryBtn').hidden = !showRetry;
    document.getElementById('playerPlaceholder').style.display = 'flex';
  }

  function hidePlaceholder() {
    document.getElementById('playerPlaceholder').style.display = 'none';
  }

  function hideAllPlayers() {
    document.getElementById('player').style.display = 'none';
    localPlayerEl().style.display = 'none';
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

      item.addEventListener('dragover', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-over');
        const paths = extractDroppedVideoPaths(e.dataTransfer);
        if (paths.length === 0) {
          alert('No supported video files were dropped. Supported: ' + VIDEO_EXTENSIONS.join(', '));
          return;
        }
        addLocalVideos(paths, pl.id);
      });

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
      li.draggable = true;

      li.addEventListener('dragstart', (e) => {
        if (e.target.closest('.video-actions')) { e.preventDefault(); return; }
        draggedVideoIndex = idx;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
        setTimeout(() => li.classList.add('dragging'), 0);
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        draggedVideoIndex = null;
        list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom');
        });
      });
      li.addEventListener('dragover', (e) => {
        if (draggedVideoIndex === null || draggedVideoIndex === idx) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = li.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        li.classList.toggle('drag-over-top', !isAfter);
        li.classList.toggle('drag-over-bottom', isAfter);
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      li.addEventListener('drop', (e) => {
        if (draggedVideoIndex === null) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = li.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        reorderVideo(draggedVideoIndex, idx + (isAfter ? 1 : 0));
        li.classList.remove('drag-over-top', 'drag-over-bottom');
      });

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

      const durationEl = document.createElement('span');
      durationEl.className = 'video-duration';
      durationEl.textContent = formatDuration(video.duration);

      const actionsEl = document.createElement('div');
      actionsEl.className = 'video-actions';
      actionsEl.innerHTML = `
        <button class="icon-btn" data-action="up" title="Move up">↑</button>
        <button class="icon-btn" data-action="down" title="Move down">↓</button>
        <button class="icon-btn" data-action="edit" title="Edit">✎</button>
        <button class="icon-btn danger" data-action="delete" title="Delete">✕</button>
      `;
      actionsEl.prepend(durationEl);
      actionsEl.querySelector('[data-action="up"]').addEventListener('click', (e) => { e.stopPropagation(); moveVideo(idx, -1); });
      actionsEl.querySelector('[data-action="down"]').addEventListener('click', (e) => { e.stopPropagation(); moveVideo(idx, 1); });
      actionsEl.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openEditModal(idx); });
      actionsEl.querySelector('[data-action="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteVideo(idx); });

      li.appendChild(indexEl);
      li.appendChild(metaEl);
      li.appendChild(actionsEl);
      list.appendChild(li);
    });

    renderPlaylistDurationSummary(playlist);
  }

  function renderPlaylistDurationSummary(playlist) {
    const el = document.getElementById('playlistDurationSummary');
    if (!el) return;
    if (!playlist || playlist.videos.length === 0) {
      el.textContent = '';
      return;
    }

    let totalSeconds = 0;
    let unknownCount = 0;
    playlist.videos.forEach(v => {
      if (v.duration && isFinite(v.duration) && v.duration > 0) totalSeconds += v.duration;
      else unknownCount += 1;
    });

    const count = playlist.videos.length;
    let text = `${count} video${count === 1 ? '' : 's'}`;
    if (totalSeconds > 0) {
      text += ` • ${formatDuration(totalSeconds)} total`;
      if (unknownCount > 0) {
        text += ` (+${unknownCount} unknown — play them once to measure)`;
      }
    } else {
      text += ' • duration unknown';
    }
    el.textContent = text;
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
    const videoId = extractYouTubeId(url);
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

  function addLocalVideos(filePaths, targetPlaylistId) {
    const playlist = targetPlaylistId
      ? state.playlists.find(p => p.id === targetPlaylistId)
      : getActivePlaylist();
    if (!playlist || !filePaths || filePaths.length === 0) return;
    filePaths.forEach(filePath => {
      const video = { id: uid(), type: 'local', filePath, title: baseNameWithoutExt(filePath) };
      playlist.videos.push(video);
      probeLocalDuration(video);
    });
    scheduleSave();
    renderSidebar();
    if (playlist.id === activePlaylistId) renderVideoList();
  }

  // Bulk-imports a text file's lines: each line can be a YouTube URL, or a
  // local file path (matched by its video extension).
  async function addFromTextLines(lines) {
    const playlist = getActivePlaylist();
    if (!playlist || !lines || lines.length === 0) return;

    let added = 0;
    let skipped = 0;

    for (const line of lines) {
      const videoId = extractYouTubeId(line);
      if (videoId) {
        const title = await fetchTitle(line) || 'Untitled video';
        playlist.videos.push({ id: uid(), type: 'youtube', url: line, videoId, title });
        added += 1;
      } else if (looksLikeLocalVideoPath(line)) {
        const video = { id: uid(), type: 'local', filePath: line, title: baseNameWithoutExt(line) };
        playlist.videos.push(video);
        probeLocalDuration(video);
        added += 1;
      } else {
        skipped += 1;
      }
    }

    scheduleSave();
    renderSidebar();
    renderVideoList();

    if (skipped > 0) {
      alert(`Added ${added} video(s). Skipped ${skipped} line(s) that didn't look like a YouTube URL or video file path.`);
    }
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

  // Moves the video at fromIndex to sit just before what is currently
  // toIndex (toIndex is expressed in terms of the array *before* the move,
  // so it can validly equal playlist.videos.length to mean "at the end").
  function reorderVideo(fromIndex, toIndex) {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const videos = playlist.videos;
    if (fromIndex < 0 || fromIndex >= videos.length) return;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return; // dropping back in place

    const [item] = videos.splice(fromIndex, 1);
    let insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
    insertAt = Math.max(0, Math.min(insertAt, videos.length));
    videos.splice(insertAt, 0, item);

    // Keep the "currently playing" pointer accurate after the shuffle.
    if (currentVideoIndex === fromIndex) {
      currentVideoIndex = insertAt;
    } else if (currentVideoIndex !== -1) {
      const removedBeforePlaying = fromIndex < currentVideoIndex;
      const insertedBeforeOrAtPlaying = insertAt <= currentVideoIndex;
      if (removedBeforePlaying) currentVideoIndex -= 1;
      if (insertedBeforeOrAtPlaying) currentVideoIndex += 1;
    }

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
      const pathChanged = newPath !== video.filePath;
      video.filePath = newPath;
      video.title = newTitle || baseNameWithoutExt(newPath);

      if (pathChanged) {
        video.duration = undefined;
        probeLocalDuration(video);
      }

      if (editingIndex === currentVideoIndex && currentPlayerType === 'local') {
        const el = localPlayerEl();
        el.src = localVideoSrc(video.filePath);
        el.play().catch(() => {});
      }
    } else {
      const newUrl = document.getElementById('editUrlInput').value.trim();
      const newVideoId = extractYouTubeId(newUrl);
      if (!newVideoId) {
        alert('That doesn\'t look like a valid YouTube URL.');
        return;
      }
      if (newVideoId !== video.videoId) video.duration = undefined;
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
    exitFullscreenIfActive();
    showPlaceholder(DEFAULT_PLACEHOLDER_TEXT, false);
    hideAllPlayers();
    document.getElementById('player').style.display = '';
    document.getElementById('playPauseBtn').disabled = false;
    currentPlayerType = null;
    updatePlayPauseIcon(false);
    updateNowPlaying();

    if (ytPlayer && ytReady) {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    const localEl = localPlayerEl();
    localEl.pause();
    localEl.removeAttribute('src');
    localEl.load();
  }

  function playVideoAt(index) {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.videos[index]) return;

    exitFullscreenIfActive();

    currentVideoIndex = index;
    const video = playlist.videos[index];

    // Stop whatever was previously active before switching to the new one.
    if (ytPlayer && ytReady) {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    localPlayerEl().pause();
    hideAllPlayers();
    document.getElementById('playPauseBtn').disabled = false;

    if (video.type === 'local') {
      hidePlaceholder();
      const el = localPlayerEl();
      el.style.display = 'block';
      el.src = localVideoSrc(video.filePath);
      el.currentTime = 0;
      el.play().catch(() => {});
      currentPlayerType = 'local';
    } else {
      currentPlayerType = 'youtube';
      if (ytReady && ytPlayer) {
        document.getElementById('player').style.display = '';
        hidePlaceholder();
        ytPlayer.loadVideoById({ videoId: video.videoId, suggestedQuality: getPreferredQuality() });
        ytPlayer.playVideo();
      } else {
        pendingVideoIdToLoad = video.videoId;
        if (ytLoadFailed) {
          showPlaceholder("Couldn't load the YouTube player. Check your internet connection, then retry.", true);
        } else {
          showPlaceholder('Loading the YouTube player…', false);
        }
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
      } else if (currentPlayerType === 'youtube' && ytPlayer && ytReady) {
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

  const YT_ERROR_MESSAGES = {
    2: "That video's link looks invalid.",
    5: "This video can't be played here (HTML5 player error).",
    100: 'This video was not found — it may have been removed or made private.',
    101: "This video's owner doesn't allow it to be played in embedded players.",
    150: "This video's owner doesn't allow it to be played in embedded players."
  };

  // YouTube IFrame API callback (must be a global — the API script calls this
  // once it's finished loading, however long that takes)
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, origin: window.location.origin },
      events: {
        onReady: () => {
          ytReady = true;
          ytLoadFailed = false;
          if (pendingVideoIdToLoad) {
            document.getElementById('player').style.display = '';
            hidePlaceholder();
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
          if (event.data === YT.PlayerState.CUED || event.data === YT.PlayerState.BUFFERING || event.data === YT.PlayerState.PLAYING) {
            // There's no way to learn a YouTube video's duration without
            // loading it (no API key = no Data API lookup), so we capture
            // it the first time it's actually cued/played and remember it.
            const dur = Math.round(ytPlayer.getDuration());
            if (dur && dur > 0) {
              const playlist = getActivePlaylist();
              const video = playlist && playlist.videos[currentVideoIndex];
              if (video && video.duration !== dur) {
                video.duration = dur;
                scheduleSave();
                renderVideoList();
              }
            }
          }
          if (event.data === YT.PlayerState.ENDED) {
            updatePlayPauseIcon(false);
            playNext(true);
          }
        },
        onError: (event) => {
          if (currentPlayerType !== 'youtube') return;
          const message = YT_ERROR_MESSAGES[event.data] || ('This video can\'t be played here (error ' + event.data + ').');
          document.getElementById('player').style.display = 'none';
          showPlaceholder(message, false);
          updatePlayPauseIcon(false);
        }
      }
    });
  };

  function loadYouTubeAPI() {
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      ytLoadFailed = true;
      if (currentPlayerType === 'youtube' && !ytReady) {
        showPlaceholder("Couldn't reach YouTube. Check your internet connection, then retry.", true);
      }
    };
    document.head.appendChild(script);

    // Watchdog: if the API never calls back (network issue, firewall, etc.)
    // surface that instead of leaving the player area permanently blank.
    setTimeout(() => {
      if (!ytReady) {
        ytLoadFailed = true;
        if (currentPlayerType === 'youtube') {
          showPlaceholder("Couldn't load the YouTube player. Check your internet connection, then retry.", true);
        }
      }
    }, 10000);
  }

  function retryYouTubeLoad() {
    ytLoadFailed = false;
    showPlaceholder('Loading the YouTube player…', false);
    loadYouTubeAPI();
  }

  function setSidebarCollapsed(collapsed) {
    document.getElementById('appRoot').classList.toggle('sidebar-collapsed', collapsed);
    document.getElementById('sidebarExpandBtn').hidden = !collapsed;
    try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
  }

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

    document.getElementById('addFolderBtn').addEventListener('click', async () => {
      const files = await window.api.selectVideoFolder();
      if (!files || files.length === 0) return;
      addLocalVideos(files);
    });

    document.getElementById('importTextBtn').addEventListener('click', async () => {
      const lines = await window.api.importTextFile();
      if (!lines || lines.length === 0) return;
      await addFromTextLines(lines);
    });

    document.getElementById('prevBtn').addEventListener('click', playPrev);
    document.getElementById('nextBtn').addEventListener('click', () => playNext(false));
    document.getElementById('playPauseBtn').addEventListener('click', playPauseToggle);
    document.getElementById('repeatBtn').addEventListener('click', cycleRepeatMode);

    document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
    document.getElementById('editSaveBtn').addEventListener('click', saveEditModal);
    document.getElementById('editBrowseBtn').addEventListener('click', browseForReplacementFile);
    document.getElementById('playerRetryBtn').addEventListener('click', retryYouTubeLoad);

    document.getElementById('sidebarCollapseBtn').addEventListener('click', () => setSidebarCollapsed(true));
    document.getElementById('sidebarExpandBtn').addEventListener('click', () => setSidebarCollapsed(false));

    // Without this, dropping a file anywhere in the window makes Chromium
    // navigate to/open it instead of letting our drop zones handle it.
    document.addEventListener('dragover', (e) => { if (dragHasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => { if (dragHasFiles(e)) e.preventDefault(); });

    const queueZone = document.getElementById('queueZone');
    queueZone.addEventListener('dragover', (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      queueZone.classList.add('drag-over');
    });
    queueZone.addEventListener('dragleave', (e) => {
      if (!queueZone.contains(e.relatedTarget)) queueZone.classList.remove('drag-over');
    });
    queueZone.addEventListener('drop', (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      queueZone.classList.remove('drag-over');
      const playlist = getActivePlaylist();
      if (!playlist) {
        alert('Select or create a playlist first, then drop your video files onto it.');
        return;
      }
      const paths = extractDroppedVideoPaths(e.dataTransfer);
      if (paths.length === 0) {
        alert('No supported video files were dropped. Supported: ' + VIDEO_EXTENSIONS.join(', '));
        return;
      }
      addLocalVideos(paths);
    });

    const videoList = document.getElementById('videoList');
    videoList.addEventListener('dragover', (e) => {
      if (draggedVideoIndex === null) return;
      e.preventDefault();
    });
    videoList.addEventListener('drop', (e) => {
      if (draggedVideoIndex === null || e.target !== videoList) return;
      e.preventDefault();
      const p = getActivePlaylist();
      if (p) reorderVideo(draggedVideoIndex, p.videos.length);
    });

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
      p.videos = p.videos.filter(v => v.type !== 'facebook' && v.type !== 'instagram');
      p.videos.forEach(v => { if (!v.type) v.type = 'youtube'; });
    });

    wireEvents();
    document.getElementById('qualitySelect').value = state.settings.quality;
    let savedCollapsed = false;
    try { savedCollapsed = localStorage.getItem('sidebarCollapsed') === '1'; } catch (e) {}
    setSidebarCollapsed(savedCollapsed);
    renderSidebar();
    renderPlaylistPanel();
    loadYouTubeAPI();

    state.playlists.forEach(p => {
      p.videos.forEach(v => {
        if (v.type === 'local' && !v.duration) probeLocalDuration(v);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
