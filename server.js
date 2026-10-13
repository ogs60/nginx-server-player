const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');

const execFileAsync = promisify(require('child_process').execFile);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const CACHE_META = path.join(CACHE_DIR, 'index.json');
const YOUTUBE_PROXY = process.env.YOUTUBE_PROXY || '';
if (YOUTUBE_PROXY) {
  let proxyUrl;
  try { proxyUrl = new URL(YOUTUBE_PROXY); } catch { throw new Error('YOUTUBE_PROXY 必须是完整地址，例如 http://192.168.8.100:1088'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol) || !proxyUrl.hostname || !proxyUrl.port) {
    throw new Error('YOUTUBE_PROXY 必须包含协议、地址和端口，例如 http://192.168.8.100:1088');
  }
}
const DOWNLOAD_PROGRESS = new Map();
fs.mkdirSync(CACHE_DIR, { recursive: true });
const startTime = Date.now();
let visitorCount = 0;

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname === '/') {
    visitorCount++;
    
    const startDate = new Date(startTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const htmlContent = getHTMLContent(startTime, visitorCount, startDate);
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  } else if (requestUrl.pathname === '/preload') {
    handlePreload(requestUrl, req, res);
  } else if (requestUrl.pathname === '/yt-audio') {
    handleYouTubeAudio(requestUrl, req, res);
  } else if (requestUrl.pathname === '/media-proxy') {
    handleMediaProxy(requestUrl, req, res);
  } else if (requestUrl.pathname === '/cache-list') {
    handleCacheList(res);
  } else if (requestUrl.pathname === '/cache-metadata') {
    handleCacheMetadata(req, res);
  } else if (requestUrl.pathname === '/cache-upload') {
    handleCacheUpload(req, res);
  } else if (requestUrl.pathname === '/cache-delete') {
    handleCacheDelete(req, res);
  } else if (requestUrl.pathname === '/cache-audio') {
    handleCacheAudio(requestUrl, res);
  } else if (requestUrl.pathname === '/cache-progress') {
    handleCacheProgress(requestUrl, res);
  } else if (requestUrl.pathname === '/get-audio-url') {
    handleGetAudioUrl(req, res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function getHTMLContent(startTime, visitorCount, startDate) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>熊宝宝的音乐播放器</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .header {
      padding: 40px;
      text-align: center;
    }
    .bear-logo {
      width: 150px;
      height: 120px;
      margin: 0 auto 12px;
      display: block;
    }
    .bear-title {
      color: #6b4226;
      margin: 0 0 10px;
      font-size: 28px;
    }
    .info {
      margin: 15px 0;
      font-size: 16px;
      color: #555;
    }
    .label {
      font-weight: bold;
      color: #667eea;
      display: inline-block;
      min-width: 100px;
      text-align: right;
      margin-right: 10px;
    }
    .value {
      color: #333;
    }
    .player-section {
      background: #f5f5f5;
      padding: 30px;
      border-top: 1px solid #ddd;
    }
    .player-section h2 {
      margin: 0 0 20px 0;
      color: #333;
      font-size: 18px;
    }
    .player-controls {
      background: white;
      padding: 20px;
      border-radius: 8px;
    }
    .video-wrapper {
      position: relative;
      width: 100%;
      padding-bottom: 56.25%;
      background: #000;
      margin-bottom: 15px;
      border-radius: 4px;
      overflow: hidden;
    }
    .video-wrapper video {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    audio {
      width: 100%;
      margin-bottom: 15px;
    }
    .url-input {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      box-sizing: border-box;
      margin-bottom: 10px;
    }
    .button-group {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    button {
      flex: 1;
      padding: 10px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.3s;
    }
    button:hover {
      background: #764ba2;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .file-input {
      display: none;
    }
    .now-playing {
      background: #f0f0f0;
      padding: 10px;
      border-radius: 4px;
      font-size: 14px;
      color: #555;
      word-break: break-all;
      margin-bottom: 15px;
      min-height: 40px;
      display: flex;
      align-items: center;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .loading {
      display: none;
      text-align: center;
      color: #667eea;
      font-size: 14px;
      margin-bottom: 15px;
    }
    .progress-wrap {
      display: none;
      margin-bottom: 15px;
    }
    .progress-bar {
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-value {
      width: 0%;
      height: 100%;
      background: #667eea;
      transition: width .3s ease;
    }
    .progress-text {
      margin-top: 5px;
      color: #666;
      font-size: 12px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <svg class="bear-logo" viewBox="0 0 180 140" role="img" aria-label="可爱的小熊">
        <circle cx="42" cy="38" r="25" fill="#b97845"/>
        <circle cx="138" cy="38" r="25" fill="#b97845"/>
        <circle cx="42" cy="38" r="13" fill="#f2c29b"/>
        <circle cx="138" cy="38" r="13" fill="#f2c29b"/>
        <circle cx="90" cy="76" r="55" fill="#c88750"/>
        <circle cx="70" cy="68" r="7" fill="#342116"/>
        <circle cx="110" cy="68" r="7" fill="#342116"/>
        <ellipse cx="90" cy="91" rx="22" ry="17" fill="#f2c29b"/>
        <ellipse cx="90" cy="87" rx="8" ry="6" fill="#342116"/>
        <path d="M82 98 Q90 106 98 98" fill="none" stroke="#342116" stroke-width="4" stroke-linecap="round"/>
        <path d="M48 117 Q90 137 132 117" fill="none" stroke="#8f542f" stroke-width="8" stroke-linecap="round"/>
      </svg>
      <h1 class="bear-title">🎵 熊宝宝的音乐播放器 🎵</h1>
      <div class="info">
        <span class="label">启动时间：</span>
        <span class="value">${startDate}</span>
      </div>
      <div class="info">
        <span class="label">运行时长：</span>
        <span class="value"><span id="uptime">计算中...</span></span>
      </div>
      <div class="info">
        <span class="label">你是第几位访客：</span>
        <span class="value">${visitorCount}</span>
      </div>
    </div>
    
    <div class="player-section">
      <h2>🎵 媒体播放器</h2>
      <div class="player-controls">
        <audio id="audioPlayer" controls style="display: none;"></audio>
        <div class="video-wrapper" id="videoWrapper" style="display: none;">
          <video id="videoPlayer" controls></video>
        </div>
        
        <div class="checkbox-label">
          <input type="checkbox" id="loopToggle"> 
          <label for="loopToggle">循环播放</label>
        </div>
        
        <div class="now-playing" id="nowPlaying">未加载媒体</div>
        <div id="playlist" style="background:#fff;padding:10px;border-radius:4px;margin-bottom:15px;font-size:13px;color:#555;display:none;"></div>
        <div class="loading" id="loading">⏳ 正在获取音频链接...</div>
        <div class="progress-wrap" id="progressWrap">
          <div class="progress-bar"><div class="progress-value" id="progressValue"></div></div>
          <div class="progress-text" id="progressText">等待加载</div>
        </div>
        
        <div style="margin-bottom: 15px;">
          <label for="urlInput">URL (支持 YouTube、MP3、MP4 等)：</label>
          <input 
            type="text" 
            id="urlInput" 
            class="url-input" 
            placeholder="粘贴音乐/视频 URL"
          >
        </div>
        
        <div class="button-group">
          <button id="loadBtn" onclick="loadFromUrl()">加载</button>
          <label style="flex: 1; margin: 0;">
            <button onclick="document.querySelector('.file-input').click()" style="margin: 0; width: 100%;">
              本地文件
            </button>
            <input type="file" class="file-input" accept="audio/*,video/*" multiple onchange="loadFromFiles(event)">
          </label>
        </div>
        
        <button onclick="clearPlayer()" style="margin-bottom: 0;">清空</button>
      </div>
    </div>
  </div>
  
  <script>
    const startTime = ${startTime};
    const audioPlayer = document.getElementById('audioPlayer');
    const videoPlayer = document.getElementById('videoPlayer');
    const videoWrapper = document.getElementById('videoWrapper');
    const nowPlaying = document.getElementById('nowPlaying');
    const loading = document.getElementById('loading');
    const progressWrap = document.getElementById('progressWrap');
    const progressValue = document.getElementById('progressValue');
    const progressText = document.getElementById('progressText');
    const playlist = document.getElementById('playlist');
    const loopToggle = document.getElementById('loopToggle');
    const loadBtn = document.getElementById('loadBtn');
    const urlInput = document.getElementById('urlInput');
    
    let currentPlayer = null;
    let playlistItems = [];
    let currentIndex = -1;
    let loadingUrl = false;

    
    function isYouTube(url) {
      return url.includes('youtube.com') || url.includes('youtu.be');
    }
    
    function isVideoFile(url) {
      const videoExts = /\\.(mp4|webm|mkv|mov|avi|flv|wmv|m3u8)$/i;
      return videoExts.test(url);
    }
    
    function switchPlayer(type) {
      audioPlayer.pause();
      videoPlayer.pause();
      audioPlayer.src = '';
      videoPlayer.src = '';
      
      if (type === 'video') {
        audioPlayer.style.display = 'none';
        videoWrapper.style.display = 'block';
        currentPlayer = videoPlayer;
      } else {
        audioPlayer.style.display = 'block';
        videoWrapper.style.display = 'none';
        currentPlayer = audioPlayer;
      }
      currentPlayer.loop = loopToggle.checked;
    }
    
    function updateUptime() {
      const now = Date.now();
      const uptime = Math.floor((now - startTime) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;
      document.getElementById('uptime').textContent = hours + '小时 ' + minutes + '分钟 ' + seconds + '秒';
    }
    
    function renderPlaylist() {
      playlist.style.display = playlistItems.length ? 'block' : 'none';
      playlist.innerHTML = '<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button type="button" onclick="removeSelectedItems()" style="padding:5px 10px;font-size:12px;background:#dc3545">删除选中</button></div>' + playlistItems.map((item, index) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;' + (index === currentIndex ? 'font-weight:bold;color:#667eea;' : '') + '">' +
        '<input type="checkbox" class="playlist-select" data-index="' + index + '" onclick="event.stopPropagation()" onchange="togglePlaylistSelection(this)"' + (item.selected ? ' checked' : '') + ' style="flex:0 0 auto;width:16px;height:16px">' +
        '<span style="flex:1;cursor:pointer" onclick="playItem(' + index + ')" title="点击播放">' + (index + 1) + '. ' + escapeHtml(item.name) + ' <small style="color:#888">[' + (item.cached ? '本地缓存' : item.local ? '本地文件' : 'URL') + ']</small></span>' +
        '</div>'
      ).join('');
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\\'':'&#39;','"':'&quot;'}[char]));
    }

    function addPlaylistItem(item) {
      playlistItems.push(item);
      renderPlaylist();
    }

    function playItem(index) {
      if (index >= playlistItems.length) {
        if (loopToggle.checked && playlistItems.length) index = 0;
        else return;
      }
      currentIndex = index;
      const item = playlistItems[currentIndex];
      renderPlaylist();
      switchPlayer(item.type);
      currentPlayer.src = item.src;
      currentPlayer.loop = false;
      nowPlaying.textContent = '正在播放: ' + item.name;
      currentPlayer.play().catch(e => console.warn('自动播放被浏览器阻止:', e.message));
    }

    function playNext() {
      if (!playlistItems.length) return;
      playItem(currentIndex + 1);
    }

    function addUrlToPlaylist(inputUrl) {
      const isVideo = isVideoFile(inputUrl);
      const mediaSrc = isYouTube(inputUrl) ? '/yt-audio?url=' + encodeURIComponent(inputUrl) : '/media-proxy?url=' + encodeURIComponent(inputUrl);
      addPlaylistItem({ type: isVideo ? 'video' : 'audio', src: mediaSrc, name: inputUrl, url: inputUrl });
      if (currentIndex < 0) playItem(0);
      else nowPlaying.textContent = '已加入播放列表: ' + inputUrl;
    }

    async function loadFromUrl() {
      const inputUrl = urlInput.value.trim();
      if (!inputUrl || loadingUrl) {
        if (!inputUrl) alert('请输入有效的 URL');
        return;
      }
      urlInput.value = '';
      if (isYouTube(inputUrl)) {
        const shouldPreload = currentIndex >= 0;
        const item = { type: 'audio', src: '/yt-audio?url=' + encodeURIComponent(inputUrl), name: inputUrl, url: inputUrl };
        addPlaylistItem(item);
        if (currentIndex < 0) playItem(0);
        else nowPlaying.textContent = '已加入播放列表: ' + inputUrl;

        startProgressPolling(item);
        if (shouldPreload) {
          fetch('/preload?url=' + encodeURIComponent(item.url)).then(response => response.arrayBuffer()).catch(() => {});
        }
        fetch('/get-audio-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: inputUrl })
        }).then(response => response.json()).then(data => {
          if (data.title) {
            applyUrlTitle(item.url, data.title);
            updateCacheMetadata({ url: item.url, name: data.title });
          }
        }).catch(error => {
          console.warn('标题获取失败，继续使用 URL 播放:', error.message);
        });
      } else {
        addUrlToPlaylist(inputUrl);
      }
    }

    async function loadFromFiles(event) {
      const files = Array.from(event.target.files || []);
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/cache-upload', { method: 'POST', body: form });
        if (!response.ok) throw new Error('本地文件上传失败: ' + file.name);
        const item = await response.json();
        addPlaylistItem(item);
      }
      if (currentIndex < 0 && playlistItems.length) playItem(0);
      event.target.value = '';
    }

    function togglePlaylistSelection(checkbox) {
      const index = Number(checkbox.dataset.index);
      if (playlistItems[index]) playlistItems[index].selected = checkbox.checked;
    }

    async function removeSelectedItems() {
      const selectedIndexes = playlistItems
        .map((item, index) => item.selected ? index : -1)
        .filter(index => index >= 0);
      if (!selectedIndexes.length) return;

      const selected = new Set(selectedIndexes);
      const cachedItems = selectedIndexes
        .map(index => playlistItems[index])
        .filter(item => item && item.cached);
      await Promise.all(cachedItems.map(item =>
        fetch('/cache-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: new URL(item.src, location.origin).searchParams.get('file') })
        }).then(response => {
          if (!response.ok) throw new Error('缓存删除失败');
        })
      ));

      const wasCurrentDeleted = selected.has(currentIndex);
      playlistItems.forEach((item, index) => {
        if (selected.has(index) && item.local && item.src.startsWith('blob:')) URL.revokeObjectURL(item.src);
      });
      playlistItems = playlistItems.filter((item, index) => !selected.has(index));
      if (wasCurrentDeleted) {
        audioPlayer.pause();
        videoPlayer.pause();
        audioPlayer.src = '';
        videoPlayer.src = '';
        currentIndex = Math.min(currentIndex, playlistItems.length - 1);
        if (playlistItems.length) playItem(Math.max(0, currentIndex));
        else nowPlaying.textContent = '未加载媒体';
      } else {
        currentIndex -= selectedIndexes.filter(index => index < currentIndex).length;
      }
      renderPlaylist();
    }

    function startProgressPolling(item) {
      if (!item.url || !isYouTube(item.url)) return;
      progressWrap.style.display = 'block';
      progressValue.style.width = '0%';
      progressText.textContent = '正在解析和转换音频...';
      const timer = setInterval(() => {
        fetch('/cache-progress?url=' + encodeURIComponent(item.url))
          .then(response => response.json())
          .then(data => {
            const percent = Number(data.percent || 0);
            progressValue.style.width = percent + '%';
            progressText.textContent = data.cached ? '已缓存，可直接播放' : (percent > 0 ? '正在加载 ' + percent.toFixed(1) + '%' : '正在解析和转换音频...');
            if (data.cached || data.status === 'error') {
              clearInterval(timer);
              if (data.cached) setTimeout(() => { progressWrap.style.display = 'none'; }, 1200);
            }
          }).catch(() => {});
      }, 500);
      setTimeout(() => clearInterval(timer), 30 * 60 * 1000);
    }
    function loadCachedSongs() {
      fetch('/cache-list').then(response => response.json()).then(items => {
        items.forEach(item => addPlaylistItem(item));
        renderPlaylist();
      }).catch(error => console.warn('缓存歌曲加载失败:', error.message));
    }

    function applyUrlTitle(url, title) {
      if (!title) return;
      let currentMatch = false;
      playlistItems.forEach(entry => {
        if (entry.url === url) {
          entry.name = title;
          currentMatch = playlistItems[currentIndex] === entry;
        }
      });
      renderPlaylist();
      if (currentMatch) nowPlaying.textContent = '正在播放: ' + title;
    }
    function updateCacheMetadata(item) {
      fetch('/cache-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, title: item.name })
      }).catch(error => console.warn('缓存元数据保存失败:', error.message));
    }
    function clearPlayer() {
      audioPlayer.pause();
      videoPlayer.pause();
      playlistItems.forEach(item => { if (item.local && item.src.startsWith('blob:')) URL.revokeObjectURL(item.src); });
      playlistItems = [];
      currentIndex = -1;
      audioPlayer.src = '';
      videoPlayer.src = '';
      urlInput.value = '';
      nowPlaying.textContent = '未加载媒体';
      renderPlaylist();
    }

    
    audioPlayer.addEventListener('ended', playNext);
    videoPlayer.addEventListener('ended', playNext);

    loopToggle.addEventListener('change', function() {
      if (currentPlayer) currentPlayer.loop = false;
      renderPlaylist();
    });
    
    switchPlayer('audio');
    loadCachedSongs();
    updateUptime();
    setInterval(updateUptime, 1000);
  </script>
</body>
</html>`;
}

let metadataWriteQueue = Promise.resolve();

function readCacheMetadata() {
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_META, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeCacheMetadataEntry(key, value) {
  metadataWriteQueue = metadataWriteQueue.then(() => {
    const metadata = readCacheMetadata();
    metadata[key] = { ...metadata[key], ...value };
    const temp = CACHE_META + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(metadata, null, 2) + '\n');
    fs.renameSync(temp, CACHE_META);
  });
  return metadataWriteQueue;
}

function deleteCacheMetadataEntry(key) {
  metadataWriteQueue = metadataWriteQueue.then(() => {
    const metadata = readCacheMetadata();
    delete metadata[key];
    const temp = CACHE_META + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(metadata, null, 2) + '\n');
    fs.renameSync(temp, CACHE_META);
  });
  return metadataWriteQueue;
}

function handleCacheList(res) {
  const metadata = readCacheMetadata();
  const files = fs.readdirSync(CACHE_DIR).filter(file => /\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(file));
  const items = files.map(file => {
    const key = file.replace(/\.[^.]+$/, '');
    const item = metadata[file] || metadata[key] || {};
    return {
      type: 'audio',
      src: '/cache-audio?file=' + encodeURIComponent(file),
      name: item.title || '缓存歌曲 ' + key.slice(0, 8),
      url: item.url || '',
      cached: true
    };
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(items));
}

function handleCacheMetadata(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      if (!data.url || !data.title) throw new Error('invalid metadata');
      const key = crypto.createHash('sha256').update(data.url).digest('hex');
      writeCacheMetadataEntry(key, { url: data.url, title: data.title }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  });
}

function handleCacheUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) { res.writeHead(400); res.end('Invalid multipart upload'); return; }
  const boundary = Buffer.from('--' + (boundaryMatch[1] || boundaryMatch[2]));
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const start = body.indexOf(boundary);
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
      const end = body.indexOf(boundary, headerEnd + 4);
      if (start < 0 || headerEnd < 0 || end < 0) throw new Error('invalid upload');
      const headers = body.slice(start, headerEnd).toString();
      const nameMatch = headers.match(/filename="([^"]+)"/i);
      if (!nameMatch) throw new Error('missing filename');
      const originalName = path.basename(nameMatch[1]);
      const ext = path.extname(originalName).toLowerCase();
      if (!/\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(ext)) throw new Error('unsupported file type');
      const key = crypto.createHash('sha256').update(originalName + ':' + body.slice(headerEnd + 4, end - 2)).digest('hex');
      const fileName = key + ext;
      fs.writeFileSync(path.join(CACHE_DIR, fileName), body.slice(headerEnd + 4, end - 2));
      writeCacheMetadataEntry(key, { title: originalName, local: true }).then(() => {
        const item = { type: ext === '.mp4' || ext === '.webm' || ext === '.mov' ? 'video' : 'audio', src: '/cache-audio?file=' + encodeURIComponent(fileName), name: originalName, cached: true, local: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item));
      });
    } catch (error) { res.writeHead(400); res.end(error.message); }
  });
}
function handleCacheDelete(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const file = path.basename(data.file || '');
      if (!/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file)) throw new Error('invalid cache file');
      const target = path.join(CACHE_DIR, file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      deleteCacheMetadataEntry(file.replace(/\.[^.]+$/, '')).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  });
}
function handleCacheAudio(url, res) {
  const file = path.basename(url.searchParams.get('file') || '');
  const target = path.join(CACHE_DIR, file);
  if (!/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file) || !fs.existsSync(target)) {
    res.writeHead(404);
    res.end('Cache file not found');
    return;
  }
  const stat = fs.statSync(target);
  const type = /\.(mp4|webm|mov)$/i.test(file) ? 'video/mp4' : 'audio/mpeg';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000' });
  fs.createReadStream(target).pipe(res);
}

function handleCacheProgress(url, res) {
  const inputUrl = url.searchParams.get('url') || '';
  const key = crypto.createHash('sha256').update(inputUrl).digest('hex');
  const cachePath = path.join(CACHE_DIR, key + '.mp3');
  const progress = DOWNLOAD_PROGRESS.get(key) || {};
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cached: true, percent: 100 }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(progress));
}
async function handleGetAudioUrl(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const inputUrl = data.url;
      let title = '';
      try {
        const ytArgs = [
          '--socket-timeout', '30',
          '--no-warnings',
          '--no-playlist',
          '--print', '%(title)s',
          '--skip-download'
        ];
        if (YOUTUBE_PROXY) ytArgs.unshift('--proxy', YOUTUBE_PROXY);
        ytArgs.push(inputUrl);
        const { stdout } = await execFileAsync('yt-dlp', ytArgs, { timeout: 70000 });
        title = stdout.trim().split('\n').filter(Boolean).pop() || '';
      } catch (e) {
        console.warn('Title lookup failed; metadata will be saved after a successful title lookup:', e.message);
      }
      const finalTitle = title.substring(0, 200);
      if (finalTitle) {
        const key = crypto.createHash('sha256').update(inputUrl).digest('hex');
        writeCacheMetadataEntry(key, { url: inputUrl, title: finalTitle });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, title: finalTitle }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message.substring(0, 200) }));
    }
  });
}


async function handleMediaProxy(url, req, res) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:$/i.test(new URL(target).protocol)) {
    res.writeHead(400);
    res.end('Invalid media URL');
    return;
  }
  const targetUrl = new URL(target);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = client.get(targetUrl, {
    headers: {
      ...(req.headers.range ? { Range: req.headers.range } : {}),
      'User-Agent': req.headers['user-agent'] || 'nginx-server-player'
    }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', error => {
    console.error('Media proxy error:', error.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('Media proxy error');
  });
  req.on('close', () => proxyReq.destroy());
}

function validateYouTubeUrl(inputUrl) {
  try {
    const parsedUrl = new URL(inputUrl);
    const allowed = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'];
    if (!allowed.includes(parsedUrl.hostname.toLowerCase())) throw new Error('unsupported host');
    return true;
  } catch {
    return false;
  }
}

const DOWNLOAD_TASKS = new Map();

function startDownload(inputUrl, key, cachePath) {
  if (DOWNLOAD_TASKS.has(key)) return DOWNLOAD_TASKS.get(key);
  const task = new Promise((resolve, reject) => {
    const tempPath = cachePath + '.part';
    try { fs.unlinkSync(tempPath); } catch {}
    const { spawn } = require('child_process');
    const ytArgs = ['--socket-timeout', '30', '--no-warnings', '--no-playlist', '-f', 'bestaudio', '-o', '-', inputUrl];
    if (YOUTUBE_PROXY) ytArgs.unshift('--proxy', YOUTUBE_PROXY);
    let attempts = 0;
    const run = () => {
      attempts++;
      DOWNLOAD_PROGRESS.set(key, { status: 'loading', percent: 0, attempt: attempts });
      const yt = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'mp3', '-q:a', '5', tempPath], { stdio: ['pipe', 'ignore', 'pipe'] });
      const progressPattern = /\[download\]\s+(\d+(?:\.\d+)?)%/;
      let ytFailed = false;
      yt.stdout.pipe(ffmpeg.stdin);
      yt.stderr.on('data', data => {
        const text = data.toString();
        const match = text.match(progressPattern);
        if (match) DOWNLOAD_PROGRESS.set(key, { status: 'loading', percent: Number(match[1]), attempt: attempts });
        if (/ERROR:|HTTP Error 403|unable to download video data/i.test(text)) ytFailed = true;
        console.log('yt-dlp:', text.trim().slice(0, 300));
      });
      ffmpeg.stderr.on('data', data => console.log('FFmpeg:', data.toString().trim().slice(0, 300)));
      yt.on('error', error => { ytFailed = true; console.error('yt-dlp error:', error.message); });
      ffmpeg.on('error', error => console.error('FFmpeg error:', error.message));
      ffmpeg.on('close', code => {
        if (code === 0 && !ytFailed && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          fs.rename(tempPath, cachePath, error => {
            if (error) return reject(error);
            writeCacheMetadataEntry(key, { url: inputUrl }).then(() => {
              DOWNLOAD_PROGRESS.set(key, { status: 'complete', percent: 100 });
              resolve(cachePath);
            }).catch(reject);
          });
        } else if (attempts < 3) {
          try { fs.unlinkSync(tempPath); } catch {}
          setTimeout(run, attempts * 1000);
        } else {
          try { fs.unlinkSync(tempPath); } catch {}
          DOWNLOAD_PROGRESS.set(key, { status: 'error', percent: 0, attempt: attempts });
          reject(new Error('YouTube 音频下载失败，已重试 3 次'));
        }
      });
    };
    run();
  }).finally(() => setTimeout(() => DOWNLOAD_TASKS.delete(key), 60000));
  DOWNLOAD_TASKS.set(key, task);
  return task;
}

function sendCachedAudio(cachePath, res) {
  const stat = fs.statSync(cachePath);
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000' });
  fs.createReadStream(cachePath).pipe(res);
}

async function handlePreload(url, req, res) {
  const inputUrl = url.searchParams.get('url') || '';
  if (!validateYouTubeUrl(inputUrl)) { res.writeHead(400); res.end('Invalid YouTube URL'); return; }
  const key = crypto.createHash('sha256').update(inputUrl).digest('hex');
  const cachePath = path.join(CACHE_DIR, key + '.mp3');
  if (!fs.existsSync(cachePath)) startDownload(inputUrl, key, cachePath).catch(error => console.error('Preload failed:', error.message));
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ accepted: true, key }));
}

async function handleYouTubeAudio(url, req, res) {
  const inputUrl = url.searchParams.get('url') || '';
  if (!validateYouTubeUrl(inputUrl)) { res.writeHead(400); res.end('Invalid YouTube URL'); return; }
  const key = crypto.createHash('sha256').update(inputUrl).digest('hex');
  const cachePath = path.join(CACHE_DIR, key + '.mp3');
  try {
    if (!fs.existsSync(cachePath)) await startDownload(inputUrl, key, cachePath);
    sendCachedAudio(cachePath, res);
  } catch (error) {
    if (!res.headersSent) { res.writeHead(502); res.end(error.message); }
  }
}

server.listen(80, () => {
  console.log('Server running on port 80');
});
