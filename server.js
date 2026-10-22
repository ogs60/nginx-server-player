const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');

process.on('uncaughtException', (err) => {
  console.error('Global uncaughtException:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Global unhandledRejection:', reason);
});

const execFileAsync = promisify(require('child_process').execFile);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const CACHE_META = path.join(CACHE_DIR, 'index.json');
const VISITOR_META = path.join(CACHE_DIR, 'visitors.json');
const PORT = Number(process.env.PORT) || 80;
const YOUTUBE_PROXY = process.env.YOUTUBE_PROXY || '';
if (YOUTUBE_PROXY) {
  let proxyUrl;
  try { proxyUrl = new URL(YOUTUBE_PROXY); } catch { throw new Error('YOUTUBE_PROXY 必须是完整地址，例如 http://192.168.8.100:1088'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol) || !proxyUrl.hostname || !proxyUrl.port) {
    throw new Error('YOUTUBE_PROXY 必须包含协议、地址和端口，例如 http://192.168.8.100:1088');
  }
}
const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES || '';

function getYouTubeCookiesPath() {
  if (YOUTUBE_COOKIES && fs.existsSync(YOUTUBE_COOKIES)) {
    return YOUTUBE_COOKIES;
  }
  const inCache = path.join(CACHE_DIR, 'cookies.txt');
  if (fs.existsSync(inCache)) return inCache;
  const inApp = path.join('/app', 'cookies.txt');
  if (fs.existsSync(inApp)) return inApp;
  const inLocal = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(inLocal)) return inLocal;
  return null;
}
const DOWNLOAD_PROGRESS = new Map();
const ONLINE_VISITOR_TIMEOUT = 2 * 60 * 1000;
const ONLINE_VISITORS = new Map();
fs.mkdirSync(CACHE_DIR, { recursive: true });
const startTime = Date.now();
let visitorCount = 0;

function getShanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readVisitorData() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(VISITOR_META, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { days: {} };
    throw error;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid visitor statistics data');
  }
  if (data.days && typeof data.days === 'object' && !Array.isArray(data.days)) return data;

  const migrated = { days: {} };
  for (const [legacyId, visitor] of Object.entries(data)) {
    if (!visitor || typeof visitor !== 'object') {
      throw new Error('Invalid legacy visitor statistics data');
    }
    const firstSeen = new Date(visitor.firstSeen);
    if (Number.isNaN(firstSeen.getTime())) {
      throw new Error('Invalid legacy visitor statistics data');
    }
    const date = getShanghaiDate(firstSeen);
    migrated.days[date] ||= {};
    migrated.days[date][`legacy-${legacyId}`] = visitor;
  }
  return migrated;
}

function writeVisitorData(data) {
  const tempPath = VISITOR_META + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tempPath, VISITOR_META);
}

function getVisitorIdentity(req) {
  const deviceCookie = String(req.headers.cookie || '').split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith('bear_device='));
  const deviceId = deviceCookie ? deviceCookie.slice('bear_device='.length) : crypto.randomUUID();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return {
    deviceId,
    visitorId: crypto.createHash('sha256').update(`${ip}|${deviceId}`).digest('hex'),
    secure: req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
  };
}

function setVisitorCookie(res, deviceId, secure) {
  res.setHeader('Set-Cookie', `bear_device=${encodeURIComponent(deviceId)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function getYouTubeCacheKey(inputUrl, format) {
  const keyInput = format === 'mp4' ? `${inputUrl}\nmp4` : inputUrl;
  return crypto.createHash('sha256').update(keyInput).digest('hex');
}

function getYouTubeFormat(value) {
  return value === 'mp4' ? 'mp4' : value === 'mp3' || !value ? 'mp3' : null;
}

function getClientVisitor(req, res) {
  const { deviceId, visitorId, secure } = getVisitorIdentity(req);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const date = getShanghaiDate();
  const visitors = readVisitorData();
  visitors.days[date] ||= {};
  const dayVisitors = visitors.days[date];
  const username = String(req.headers['x-auth-request-user'] || '').trim();
  const email = String(req.headers['x-auth-request-email'] || '').trim();
  const existing = dayVisitors[visitorId];

  if (!existing) {
    dayVisitors[visitorId] = {
      firstSeen: new Date().toISOString(),
      ip,
      ...(username ? { username } : {}),
      ...(email ? { email } : {})
    };
    writeVisitorData(visitors);
  } else if ((username && existing.username !== username) || (email && existing.email !== email)) {
    if (username) existing.username = username;
    if (email) existing.email = email;
    existing.lastSeen = new Date().toISOString();
    writeVisitorData(visitors);
  }
  visitorCount = Object.keys(dayVisitors).length;
  setVisitorCookie(res, deviceId, secure);
  return visitorCount;
}

function handleOnlineVisitors(req, res) {
  const { deviceId, visitorId, secure } = getVisitorIdentity(req);
  const now = Date.now();
  for (const [id, lastSeen] of ONLINE_VISITORS) {
    if (now - lastSeen >= ONLINE_VISITOR_TIMEOUT) ONLINE_VISITORS.delete(id);
  }
  ONLINE_VISITORS.set(visitorId, now);
  setVisitorCookie(res, deviceId, secure);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ count: ONLINE_VISITORS.size }));
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname === '/') {
    let currentVisitorNumber = 1;
    try {
      currentVisitorNumber = getClientVisitor(req, res);
    } catch (error) {
      console.warn('Visitor statistics warning:', error.message);
      currentVisitorNumber = 1;
    }
    
    const startDate = new Date(startTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const htmlContent = getHTMLContent(startTime, currentVisitorNumber, startDate);
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  } else if (requestUrl.pathname === '/mc') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getManageHTMLContent());
  } else if (requestUrl.pathname === '/cache-update') {
    handleCacheUpdate(req, res);
  } else if (requestUrl.pathname === '/cache-reorder') {
    handleCacheReorder(req, res);
  } else if (requestUrl.pathname === '/cache-batch-delete') {
    handleCacheBatchDelete(req, res);
  } else if (requestUrl.pathname === '/online-visitors') {
    handleOnlineVisitors(req, res);
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
    handleCacheAudio(req, res, requestUrl);
  } else if (requestUrl.pathname === '/cache-progress') {
    handleCacheProgress(requestUrl, res);
  } else if (requestUrl.pathname === '/get-audio-url') {
    handleGetAudioUrl(req, res);
  } else if (requestUrl.pathname === '/lyrics') {
    handleLyrics(requestUrl, res);
  } else if (requestUrl.pathname === '/manifest.json') {
    const manifest = {
      name: "熊宝宝的音乐播放器",
      short_name: "熊宝宝音乐",
      description: "简单好用的音乐与视频播放器",
      start_url: "/",
      display: "standalone",
      background_color: "#667eea",
      theme_color: "#667eea",
      icons: [
        {
          src: "/logo.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable"
        }
      ]
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify(manifest, null, 2));
  } else if (requestUrl.pathname === '/logo.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 140">
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
    </svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end(svg);
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>熊宝宝的音乐播放器</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <meta name="theme-color" content="#667eea">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <style>
    *, *:before, *:after {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
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
    .lyrics-section {
      background: #fafafa;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 15px;
    }
    .lyrics-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      min-height: 26px;
    }
    .lyrics-title-wrap {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1 1 auto;
      margin-right: 8px;
    }
    .lyrics-title {
      font-size: 13.5px;
      color: #667eea;
      font-weight: bold;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .lyrics-meta {
      font-size: 11.5px;
      color: #718096;
      font-weight: normal;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1 1 auto;
      min-width: 0;
      margin-left: 6px;
    }
    .lyrics-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
    }
    .lyrics-box {
      height: 220px;
      overflow: hidden;
      position: relative;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
      transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .lyrics-box.expanded {
      height: 380px;
    }
    .lyrics-scroll {
      transition: transform 0.45s cubic-bezier(0.25, 0.46, 0.45, 0.94);
      padding: 95px 0;
      text-align: center;
    }
    .lyrics-box.expanded .lyrics-scroll {
      padding: 175px 0;
    }
    .lyric-line {
      padding: 5px 8px;
      font-size: 13.5px;
      color: #a0aec0;
      line-height: 1.7;
      cursor: pointer;
      border-radius: 4px;
      transition: color 0.3s ease, font-size 0.3s ease, font-weight 0.2s ease, background-color 0.2s ease;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .lyric-line:hover {
      color: #4a5568;
      background: rgba(102, 126, 234, 0.05);
    }
    .lyric-line.active {
      color: #667eea;
      font-size: 16.5px;
      font-weight: bold;
      text-shadow: 0 1px 2px rgba(102, 126, 234, 0.15);
    }
    .lyric-line.near {
      color: #4a5568;
    }
    .lyrics-tip {
      text-align: center;
      color: #aaa;
      font-size: 13px;
      padding: 85px 0;
    }
    .lyrics-box.expanded .lyrics-tip {
      padding: 160px 0;
    }
    .lyric-btn {
      flex: 0 0 auto !important;
      width: auto !important;
      white-space: nowrap !important;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      background: #edf2f7;
      color: #4a5568;
      border: 1px solid #cbd5e0;
      border-radius: 12px;
      padding: 0 9px;
      height: 24px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      line-height: 1;
      transition: all 0.2s;
      outline: none;
      -webkit-tap-highlight-color: transparent;
    }
    .lyric-btn:hover {
      background: #667eea;
      color: white;
      border-color: #667eea;
    }
    .lyric-btn:active, .lyric-btn.active {
      background: #667eea !important;
      color: white !important;
      border-color: #667eea !important;
    }

    /* 移动端与 App 屏幕响应式适配 */
    @media (max-width: 600px) {
      body {
        padding: 6px 4px;
      }
      .container {
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
      }
      .header {
        padding: 16px 12px 14px;
      }
      .bear-logo {
        width: 80px;
        height: 64px;
        margin-bottom: 6px;
      }
      .bear-title {
        font-size: 19px;
        margin-bottom: 6px;
      }
      .info {
        margin: 5px 0;
        font-size: 12px;
      }
      .label {
        min-width: 78px;
        margin-right: 4px;
      }
      .player-section {
        padding: 12px 8px;
      }
      .player-section h2 {
        font-size: 16px;
        margin-bottom: 12px;
      }
      .player-controls {
        padding: 10px 8px;
        border-radius: 6px;
      }
      .checkbox-label {
        flex-wrap: wrap;
        gap: 6px 12px;
        font-size: 13px;
        margin-bottom: 12px;
      }
      .now-playing {
        padding: 8px 10px;
        font-size: 13px;
        min-height: 36px;
        margin-bottom: 10px;
      }
      .lyrics-section {
        padding: 10px 8px;
        margin-bottom: 12px;
      }
      .lyrics-box {
        height: 250px;
      }
      .lyrics-box.expanded {
        height: 420px;
      }
      .lyrics-scroll {
        padding: 110px 0;
      }
      .lyrics-box.expanded .lyrics-scroll {
        padding: 195px 0;
      }
      .lyric-line {
        font-size: 13.5px;
        padding: 4px 4px;
      }
      .lyric-line.active {
        font-size: 16px;
      }
      .lyrics-meta {
        max-width: 100%;
        font-size: 11px;
      }
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
        <span class="label">今日独立访客：</span>
        <span class="value">${visitorCount}</span>
      </div>
      <div class="info">
        <span class="label">当前在线人数：</span>
        <span class="value"><span id="onlineVisitors">统计中...</span></span>
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
          <input type="radio" name="playMode" id="loopToggle" value="list" checked>
          <label for="loopToggle">列表播放</label>
          <input type="radio" name="playMode" id="randomToggle" value="random">
          <label for="randomToggle">随机播放</label>
          <input type="radio" name="playMode" id="singleRepeatToggle" value="single">
          <label for="singleRepeatToggle">单曲循环</label>
        </div>
        
        <div class="button-group" style="margin-bottom: 15px;">
          <button type="button" onclick="playPrev()" title="播放上一首">⏮ 上一曲</button>
          <button type="button" onclick="playNext()" title="播放下一首">下一曲 ⏭</button>
        </div>
        
        <div class="now-playing" id="nowPlaying">未加载媒体</div>
        <div class="lyrics-section">
          <div class="lyrics-header">
            <div class="lyrics-title-wrap">
              <span class="lyrics-title">歌词</span>
              <span class="lyrics-meta" id="lyricsMeta"></span>
            </div>
            <div class="lyrics-actions">
              <button type="button" class="lyric-btn" id="btnLyricSearch" onclick="toggleLyricSearch()" title="手动搜索歌词">🔍 搜词</button>
              <button type="button" class="lyric-btn" id="btnOffsetToggle" onclick="toggleOffsetControls()" title="调整歌词时间偏差" style="display:none;">⏱ 校准</button>
              <button type="button" class="lyric-btn" id="btnLyricExpand" onclick="toggleLyricExpand()" title="展开/收起歌词高度">⤢ 展开</button>
            </div>
          </div>
          <div id="offsetControlsRow" style="display:none;align-items:center;justify-content:center;gap:6px;padding:6px 0;margin-bottom:8px;background:#f0f4f8;border-radius:6px;font-size:11px;">
            <span style="color:#64748b;">时间微调:</span>
            <button type="button" class="lyric-btn" onclick="adjustLyricOffset(-0.5)" title="歌词慢了，提前0.5秒">-0.5s 慢了</button>
            <span id="offsetDisplay" style="color:#667eea;font-weight:bold;min-width:32px;text-align:center;">0.0s</span>
            <button type="button" class="lyric-btn" onclick="adjustLyricOffset(0.5)" title="歌词快了，延后0.5秒">+0.5s 快了</button>
            <button type="button" class="lyric-btn" onclick="resetLyricOffset()" title="重置时间偏移">重置</button>
          </div>
          <div id="lyricSearchRow" style="display:none;align-items:center;gap:6px;margin-bottom:8px;">
            <input type="text" id="manualLyricInput" class="url-input" style="margin-bottom:0;padding:4px 8px;font-size:12px;height:28px;flex:1;" placeholder="输入正确的 歌名 歌手 重新搜索" onkeydown="if(event.key==='Enter')submitManualLyrics()">
            <button type="button" class="lyric-btn" onclick="submitManualLyrics()" style="padding:0 10px;height:28px;background:#667eea;color:#fff;border-color:#667eea;">确定</button>
            <button type="button" class="lyric-btn" onclick="toggleLyricSearch()" style="padding:0 8px;height:28px;">取消</button>
          </div>
          <div class="lyrics-box" id="lyricsBox">
            <div class="lyrics-scroll" id="lyricsScroll">
              <div class="lyrics-tip">播放音乐后自动搜索歌词</div>
            </div>
          </div>
        </div>
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
        <div style="margin-bottom: 15px;">
          <label for="youtubeFormat">YouTube 下载格式：</label>
          <select id="youtubeFormat" class="url-input">
            <option value="mp3">MP3 音频</option>
            <option value="mp4">MP4 视频（优先 720p，最佳音轨）</option>
          </select>
        </div>
        
        <div class="button-group">
          <button id="loadBtn" onclick="loadFromUrl()">加载</button>
          <button type="button" onclick="document.getElementById('fileInput').click()" style="margin: 0; flex: 1;">
            📁 本地上传
          </button>
          <input type="file" id="fileInput" class="file-input" accept="audio/*,video/*" multiple onchange="loadFromFiles(event)">
        </div>
        
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
    const randomToggle = document.getElementById('randomToggle');
    const singleRepeatToggle = document.getElementById('singleRepeatToggle');
    const loadBtn = document.getElementById('loadBtn');
    const urlInput = document.getElementById('urlInput');
    const youtubeFormat = document.getElementById('youtubeFormat');
    
    let currentPlayer = null;
    let playlistItems = [];
    let currentIndex = -1;
    let loadingUrl = false;
    let playHistory = [];
    let historyIndex = -1;

    
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
      currentPlayer.loop = false;
    }
    
    function updateUptime() {
      const now = Date.now();
      const uptime = Math.floor((now - startTime) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;
      document.getElementById('uptime').textContent = hours + '小时 ' + minutes + '分钟 ' + seconds + '秒';
    }

    function updateOnlineVisitors() {
      fetch('/online-visitors')
        .then(response => {
          if (!response.ok) throw new Error('在线人数获取失败: ' + response.status);
          return response.json();
        })
        .then(data => {
          document.getElementById('onlineVisitors').textContent = data.count;
        })
        .catch(error => console.warn('在线人数更新失败:', error.message));
    }
    
    let playlistSearchKeyword = '';
    function onPlaylistSearch(val) {
      playlistSearchKeyword = (val || '').trim().toLowerCase();
      renderPlaylist();
      const input = document.getElementById('playlistSearchInput');
      if (input) {
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }

    let playlistPage = 1;
    const playlistPageSize = 80;

    function changePlaylistPage(delta) {
      playlistPage += delta;
      renderPlaylist();
    }

    function goToFirstPlaylistPage() {
      playlistPage = 1;
      renderPlaylist();
    }

    function jumpToPlaylistPageInput(val) {
      const page = parseInt(val, 10);
      if (!isNaN(page)) {
        const kw = playlistSearchKeyword;
        const filtered = playlistItems.map((item, index) => ({ item, index })).filter(entry => {
          if (!kw) return true;
          return (entry.item.name || '').toLowerCase().includes(kw);
        });
        const totalPages = Math.ceil(filtered.length / playlistPageSize) || 1;
        if (page >= 1 && page <= totalPages) {
          playlistPage = page;
          renderPlaylist();
        }
      }
    }

    function onPlaylistSearch(val) {
      playlistSearchKeyword = (val || '').trim().toLowerCase();
      playlistPage = 1;
      renderPlaylist();
      const input = document.getElementById('playlistSearchInput');
      if (input) {
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }

    function renderPlaylist() {
      playlist.style.display = playlistItems.length ? 'block' : 'none';
      if (!playlistItems.length) {
        playlist.innerHTML = '';
        return;
      }
      const kw = playlistSearchKeyword;
      const filtered = playlistItems.map((item, index) => ({ item, index })).filter(entry => {
        if (!kw) return true;
        return (entry.item.name || '').toLowerCase().includes(kw);
      });

      const totalPages = Math.ceil(filtered.length / playlistPageSize) || 1;
      if (playlistPage > totalPages) playlistPage = totalPages;
      if (playlistPage < 1) playlistPage = 1;

      const startIndex = (playlistPage - 1) * playlistPageSize;
      const endIndex = Math.min(startIndex + playlistPageSize, filtered.length);
      const pageEntries = filtered.slice(startIndex, endIndex);

      const headerHtml = '<div style="margin-bottom:10px;">' +
        '<input type="text" id="playlistSearchInput" placeholder="🔍 搜索播放列表歌曲 (歌名/歌手)..." oninput="onPlaylistSearch(this.value)" value="' + escapeHtml(playlistSearchKeyword) + '" style="width:100%;box-sizing:border-box;padding:7px 12px;font-size:12px;border:1px solid #ddd;border-radius:4px;outline:none;">' +
        '</div>';

      const itemsHtml = pageEntries.length ? pageEntries.map(entry => {
        const item = entry.item;
        const index = entry.index;
        return '<div style="display:flex;align-items:center;padding:5px 0;' + (index === currentIndex ? 'font-weight:bold;color:#667eea;' : '') + '">' +
          '<span style="flex:1;cursor:pointer" onclick="playItem(' + index + ')" title="点击播放">' + (index + 1) + '. ' + escapeHtml(item.name) + ' <small style="color:#888">[' + (item.cached ? '本地缓存' : item.local ? '本地文件' : 'URL') + ']</small></span>' +
          '</div>';
      }).join('') : '<div style="text-align:center;color:#888;padding:12px;font-size:12px;">未在播放列表中找到匹配歌曲</div>';

      let footerHtml = '';
      if (totalPages > 1) {
        let secondRowHtml = '';
        if (playlistPage === 1) {
          secondRowHtml = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span>共 ' + filtered.length + ' 首 (' + totalPages + ' 页)</span>' +
            '<button type="button" onclick="changePlaylistPage(1)" style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;">下一页 ></button>' +
            '</div>';
        } else {
          let pagesListHtml = '';
          for (let p = 1; p <= totalPages; p++) {
            if (p === playlistPage) {
              pagesListHtml += '<span style="padding:2px 6px;border:1px solid #667eea;background:#667eea;color:#fff;border-radius:4px;cursor:default;">' + p + '</span>';
            } else {
              pagesListHtml += '<button type="button" onclick="jumpToPlaylistPageInput(' + p + ')" style="padding:2px 6px;border:1px solid #ddd;background:#fff;color:#333;border-radius:4px;cursor:pointer;">' + p + '</button>';
            }
          }
          secondRowHtml = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">' +
            '<button type="button" onclick="changePlaylistPage(-1)" style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;">< 上一页</button>' +
            '<div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap;">' + pagesListHtml + '</div>' +
            '<button type="button" onclick="changePlaylistPage(1)" ' + (playlistPage === totalPages ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '') + ' style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;">下一页 ></button>' +
            '</div>';
        }

        footerHtml = '<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid #eee;font-size:12px;color:#666;">' +
          secondRowHtml +
          '</div>';
      }

      playlist.innerHTML = headerHtml + itemsHtml + footerHtml;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\\'':'&#39;','"':'&quot;'}[char]));
    }

    function addPlaylistItem(item) {
      playlistItems.push(item);
      renderPlaylist();
    }

    function playItem(index, isNav) {
      if (!playlistItems.length) return;
      if (index < 0 || index >= playlistItems.length) {
        if (loopToggle.checked && playlistItems.length) index = 0;
        else return;
      }

      const isSameSong = (currentIndex === index && currentPlayer && currentPlayer.src);

      if (isSameSong) {
        if (currentPlayer.paused) {
          currentPlayer.play().catch(e => console.warn('自动播放被浏览器阻止:', e.message));
        } else {
          currentPlayer.pause();
        }
        renderPlaylist();
        return;
      }

      currentIndex = index;
      const item = playlistItems[currentIndex];

      if (!isNav) {
        // 用户手动选歌或切歌产生新分支时，丢弃当前位置之后的前向历史
        if (historyIndex < playHistory.length - 1) {
          playHistory = playHistory.slice(0, Math.max(0, historyIndex + 1));
        }
        if (playHistory.length === 0 || playHistory[playHistory.length - 1] !== currentIndex) {
          playHistory.push(currentIndex);
          if (playHistory.length > 200) {
            playHistory.shift();
          }
        }
        historyIndex = playHistory.length - 1;
      }

      renderPlaylist();

      switchPlayer(item.type);
      currentPlayer.src = item.src;
      currentPlayer.loop = false;
      nowPlaying.textContent = '正在播放: ' + item.name;
      currentPlayer.play().catch(e => console.warn('自动播放被浏览器阻止:', e.message));
      if (item.name && item.name !== item.url) fetchLyrics(item.name);
      else clearLyrics();
    }

    function playPrev() {
      if (!playlistItems.length) return;
      // 1. 单曲循环模式：上一曲是它自己
      if (singleRepeatToggle.checked) {
        playItem(currentIndex >= 0 ? currentIndex : 0, true);
        return;
      }
      // 2. 如果存在播放历史记录，沿着历史记录往回退
      let target = historyIndex - 1;
      while (target >= 0 && (playHistory[target] >= playlistItems.length || playHistory[target] < 0 || playHistory[target] === currentIndex)) {
        target--;
      }
      if (target >= 0) {
        historyIndex = target;
        playItem(playHistory[historyIndex], true);
        return;
      }
      // 3. 历史记录已回退到尽头时的兜底处理：
      // 在历史头部插入新前驱，保证后续点击下一曲时可以原路返回
      if (randomToggle.checked && playlistItems.length > 1) {
        let prevIndex;
        do { prevIndex = Math.floor(Math.random() * playlistItems.length); } while (prevIndex === currentIndex);
        playHistory.unshift(prevIndex);
        if (playHistory.length > 200) playHistory.pop();
        historyIndex = 0;
        playItem(prevIndex, true);
        return;
      }
      let prevIndex = currentIndex - 1;
      if (prevIndex < 0) {
        prevIndex = playlistItems.length - 1;
      }
      playHistory.unshift(prevIndex);
      if (playHistory.length > 200) playHistory.pop();
      historyIndex = 0;
      playItem(prevIndex, true);
    }

    function playNext() {
      if (!playlistItems.length) return;
      // 1. 单曲循环模式：下一曲也是它自己
      if (singleRepeatToggle.checked) {
        playItem(currentIndex >= 0 ? currentIndex : 0, true);
        return;
      }
      // 2. 如果存在前向历史记录（说明之前点击过上一曲），沿着历史记录向前原路返回
      let target = historyIndex + 1;
      while (target < playHistory.length && (playHistory[target] >= playlistItems.length || playHistory[target] < 0 || playHistory[target] === currentIndex)) {
        target++;
      }
      if (target < playHistory.length) {
        historyIndex = target;
        playItem(playHistory[historyIndex], true);
        return;
      }
      // 3. 前向历史走完之后（到达历史最前端）：
      // 3.1 随机播放模式：随机选下一首
      if (randomToggle.checked && playlistItems.length > 1) {
        let nextIndex;
        do { nextIndex = Math.floor(Math.random() * playlistItems.length); } while (nextIndex === currentIndex);
        playItem(nextIndex);
        return;
      }
      // 3.2 列表播放模式：按顺序下一曲，到底回到第0首
      const nextIndex = (currentIndex + 1 < playlistItems.length) ? (currentIndex + 1) : 0;
      playItem(nextIndex);
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
        const format = youtubeFormat.value;
        const shouldPreload = currentIndex >= 0;
        const item = {
          type: format === 'mp4' ? 'video' : 'audio',
          src: '/yt-audio?url=' + encodeURIComponent(inputUrl) + '&format=' + format,
          name: inputUrl,
          url: inputUrl,
          format
        };
        addPlaylistItem(item);
        if (currentIndex < 0) playItem(0);
        else nowPlaying.textContent = '已加入播放列表: ' + inputUrl;

        startProgressPolling(item);
        if (shouldPreload) {
          fetch('/preload?url=' + encodeURIComponent(item.url) + '&format=' + format).then(response => response.arrayBuffer()).catch(() => {});
        }
        fetch('/get-audio-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: inputUrl, format })
        }).then(response => response.json()).then(data => {
          if (data.title) {
            applyUrlTitle(item.url, data.title);
            updateCacheMetadata({ url: item.url, name: data.title, format });
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
      if (!files.length) return;

      progressWrap.style.display = 'block';
      let successCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progressValue.style.width = '0%';
        progressText.textContent = '正在上传 (' + (i + 1) + '/' + files.length + '): ' + file.name + ' (0%)';
        try {
          const item = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/cache-upload', true);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressValue.style.width = percent + '%';
                progressText.textContent = '正在上传 (' + (i + 1) + '/' + files.length + '): ' + file.name + ' (' + percent + '%)';
              }
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                  reject(new Error('响应解析失败'));
                }
              } else if (xhr.status === 413) {
                reject(new Error('文件 ' + file.name + ' 超过服务器大小限制 (413 Payload Too Large)'));
              } else {
                let errMsg = '上传失败';
                try {
                  const resJson = JSON.parse(xhr.responseText);
                  if (resJson.error) errMsg = resJson.error;
                } catch (e) {
                  errMsg = xhr.responseText || xhr.statusText || errMsg;
                }
                reject(new Error(file.name + ' 上传失败 (' + xhr.status + '): ' + errMsg));
              }
            };
            xhr.onerror = () => reject(new Error('上传网络错误: ' + file.name));
            const form = new FormData();
            form.append('file', file);
            xhr.send(form);
          });

          addPlaylistItem(item);
          successCount++;
        } catch (err) {
          alert(err.message);
        }
      }

      if (successCount > 0) {
        progressText.textContent = '上传完成！已添加 ' + successCount + ' 首';
        progressValue.style.width = '100%';
        setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
        renderPlaylist();
        if (currentIndex < 0 && playlistItems.length) playItem(0);
      } else {
        progressWrap.style.display = 'none';
      }
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
      let newHistory = [];
      let newHistoryIndex = -1;
      for (let i = 0; i < playHistory.length; i++) {
        const oldIdx = playHistory[i];
        if (!selected.has(oldIdx)) {
          const shift = selectedIndexes.filter(s => s < oldIdx).length;
          const remapped = oldIdx - shift;
          if (i === historyIndex) {
            newHistoryIndex = newHistory.length;
          } else if (i < historyIndex && newHistoryIndex === -1) {
            newHistoryIndex = newHistory.length;
          }
          newHistory.push(remapped);
        }
      }
      playHistory = newHistory;
      historyIndex = newHistoryIndex >= 0 ? newHistoryIndex : (playHistory.length - 1);

      if (wasCurrentDeleted) {
        audioPlayer.pause();
        videoPlayer.pause();
        audioPlayer.src = '';
        videoPlayer.src = '';
        const targetIndex = Math.min(currentIndex, playlistItems.length - 1);
        currentIndex = -1;
        if (playlistItems.length) playItem(Math.max(0, targetIndex));
        else {
          nowPlaying.textContent = '未加载媒体';
          clearLyrics();
        }
      } else {
        currentIndex -= selectedIndexes.filter(index => index < currentIndex).length;
      }
      renderPlaylist();
    }

    function startProgressPolling(item) {
      if (!item.url || !isYouTube(item.url)) return;
      progressWrap.style.display = 'block';
      progressValue.style.width = '0%';
      progressText.textContent = item.format === 'mp4' ? '正在解析和下载视频...' : '正在解析和转换音频...';
      const timer = setInterval(() => {
        fetch('/cache-progress?url=' + encodeURIComponent(item.url) + '&format=' + (item.format || 'mp3'))
          .then(response => response.json())
          .then(data => {
            const percent = Number(data.percent || 0);
            progressValue.style.width = percent + '%';
            const taskLabel = item.format === 'mp4' ? '正在下载视频' : '正在转换音频';
            progressText.textContent = data.cached ? '已缓存，可直接播放' : (percent > 0 ? taskLabel + ' ' + percent.toFixed(1) + '%' : item.format === 'mp4' ? '正在解析和下载视频...' : '正在解析和转换音频...');
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
      if (currentMatch) {
        nowPlaying.textContent = '正在播放: ' + title;
        fetchLyrics(title);
      }
    }
    function updateCacheMetadata(item) {
      fetch('/cache-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, title: item.name, format: item.format || 'mp3' })
      }).catch(error => console.warn('缓存元数据保存失败:', error.message));
    }

    // ===== 歌词 =====
    var lyricLines = [];
    var currentLyricIdx = -1;
    var lastLyricsTitle = '';
    var userLyricOffsets = {};
    try { userLyricOffsets = JSON.parse(localStorage.getItem('bear_lyric_offsets') || '{}'); } catch (e) {}

    function getSongKey() {
      if (currentIndex >= 0 && playlistItems[currentIndex]) {
        var it = playlistItems[currentIndex];
        return it.url || it.src || it.name;
      }
      return '';
    }

    function getCurrentSongOffset() {
      var key = getSongKey();
      return key && typeof userLyricOffsets[key] === 'number' ? userLyricOffsets[key] : 0;
    }

    function adjustLyricOffset(delta) {
      var key = getSongKey();
      if (!key) return;
      var cur = getCurrentSongOffset();
      var newVal = Math.round((cur + delta) * 10) / 10;
      userLyricOffsets[key] = newVal;
      try { localStorage.setItem('bear_lyric_offsets', JSON.stringify(userLyricOffsets)); } catch (e) {}
      updateOffsetDisplay();
      if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
    }

    function resetLyricOffset() {
      var key = getSongKey();
      if (!key) return;
      delete userLyricOffsets[key];
      try { localStorage.setItem('bear_lyric_offsets', JSON.stringify(userLyricOffsets)); } catch (e) {}
      updateOffsetDisplay();
      if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
    }

    function updateOffsetDisplay() {
      var val = getCurrentSongOffset();
      var el = document.getElementById('offsetDisplay');
      if (el) el.textContent = (val > 0 ? '+' : '') + val.toFixed(1) + 's';
      var btn = document.getElementById('btnOffsetToggle');
      if (btn) {
        if (Math.abs(val) > 0.001) {
          btn.textContent = '⏱ ' + (val > 0 ? '+' : '') + val.toFixed(1) + 's';
          btn.classList.add('active');
        } else {
          btn.textContent = '⏱ 校准';
          var row = document.getElementById('offsetControlsRow');
          var isOpen = row && row.style.display === 'flex';
          btn.classList.toggle('active', !!isOpen);
        }
      }
    }

    function toggleOffsetControls() {
      var row = document.getElementById('offsetControlsRow');
      var btn = document.getElementById('btnOffsetToggle');
      if (!row) return;
      var isHidden = row.style.display === 'none' || !row.style.display;
      row.style.display = isHidden ? 'flex' : 'none';
      if (btn) btn.classList.toggle('active', isHidden);
    }

    function toggleLyricSearch() {
      var row = document.getElementById('lyricSearchRow');
      var btn = document.getElementById('btnLyricSearch');
      if (!row) return;
      var isHidden = row.style.display === 'none' || !row.style.display;
      row.style.display = isHidden ? 'flex' : 'none';
      if (btn) btn.classList.toggle('active', isHidden);
      if (isHidden) {
        var input = document.getElementById('manualLyricInput');
        if (input) {
          var curItem = playlistItems[currentIndex];
          input.value = curItem ? curItem.name : '';
          input.focus();
        }
      }
    }

    function submitManualLyrics() {
      var input = document.getElementById('manualLyricInput');
      if (!input) return;
      var query = input.value.trim();
      if (!query) return;
      var key = getSongKey();
      if (key) {
        try { localStorage.setItem('bear_manual_lyric_' + key, query); } catch (e) {}
      }
      var row = document.getElementById('lyricSearchRow');
      if (row) row.style.display = 'none';
      var btn = document.getElementById('btnLyricSearch');
      if (btn) btn.classList.remove('active');
      fetchLyrics(query, true);
    }

    function parseLrc(text) {
      var lines = text.split('\\n');
      var result = [];
      var timeRe = /\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?\\]/g;
      var offsetMatch = text.match(/\\[offset:\\s*([+-]?\\d+)\\]/i);
      var lrcOffset = offsetMatch ? parseInt(offsetMatch[1]) / 1000 : 0;
      if (Math.abs(lrcOffset) > 30) lrcOffset = 0;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^\\[[a-z]+:.*\\]$/i.test(line.trim())) continue;
        var times = [];
        var m;
        timeRe.lastIndex = 0;
        while ((m = timeRe.exec(line)) !== null) {
          var ms = 0;
          if (m[3]) {
            var msLen = m[3].length;
            ms = msLen === 1 ? parseInt(m[3]) * 100 : (msLen === 2 ? parseInt(m[3]) * 10 : parseInt(m[3]));
          }
          times.push(parseInt(m[1]) * 60 + parseInt(m[2]) + ms / 1000 - lrcOffset);
        }
        var t = line.replace(/\\[\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?\\]/g, '').trim();
        if (t && times.length) {
          for (var j = 0; j < times.length; j++) result.push({ time: times[j], text: t });
        }
      }
      return result.sort(function(a, b) { return a.time - b.time; });
    }

    function toggleLyricExpand() {
      var box = document.getElementById('lyricsBox');
      var btn = document.getElementById('btnLyricExpand');
      if (!box) return;
      var isExpanded = box.classList.toggle('expanded');
      if (btn) btn.textContent = isExpanded ? '⤡ 还原' : '⤢ 展开';
      if (currentPlayer) {
        updateLyricSync(currentPlayer.currentTime);
      }
    }

    function jumpToLyric(time) {
      if (currentPlayer && !isNaN(time)) {
        var offset = getCurrentSongOffset();
        var target = Math.max(0, time + offset);
        currentPlayer.currentTime = target;
        if (currentPlayer.paused) {
          currentPlayer.play().catch(function(e) {});
        }
        updateLyricSync(target);
      }
    }

    function renderLyricLines(lines) {
      var scroll = document.getElementById('lyricsScroll');
      if (!scroll) return;
      if (!lines || !lines.length) {
        scroll.innerHTML = '<div class="lyrics-tip">未找到同步歌词</div>';
        scroll.style.transform = '';
        return;
      }
      scroll.innerHTML = lines.map(function(l, i) {
        return '<div class="lyric-line" id="ll' + i + '" onclick="jumpToLyric(' + l.time + ')" title="点击跳转播放">' + escapeHtml(l.text) + '</div>';
      }).join('');
      scroll.style.transform = '';
    }

    function updateLyricSync(currentTime) {
      if (!lyricLines.length) return;
      var adjustedTime = currentTime - getCurrentSongOffset();
      var idx = -1;
      for (var i = 0; i < lyricLines.length; i++) {
        if (lyricLines[i].time <= adjustedTime) idx = i;
        else break;
      }
      if (idx === currentLyricIdx) return;
      currentLyricIdx = idx;
      document.querySelectorAll('.lyric-line').forEach(function(el, i) {
        el.classList.remove('active', 'near');
        if (i === idx) el.classList.add('active');
        else if (Math.abs(i - idx) <= 2) el.classList.add('near');
      });
      if (idx >= 0) {
        var activeLine = document.getElementById('ll' + idx);
        var scroll = document.getElementById('lyricsScroll');
        if (activeLine && scroll) {
          var box = scroll.parentElement;
          var boxH = box ? box.clientHeight : 220;
          var centerOffset = (boxH - activeLine.offsetHeight) / 2;
          var offset = activeLine.offsetTop - centerOffset;
          scroll.style.transform = 'translateY(-' + Math.max(0, offset) + 'px)';
        }
      }
    }

    function clearLyrics() {
      lastLyricsTitle = '';
      lyricLines = [];
      currentLyricIdx = -1;
      var scroll = document.getElementById('lyricsScroll');
      if (scroll) { scroll.innerHTML = '<div class="lyrics-tip">播放音乐后自动搜索歌词</div>'; scroll.style.transform = ''; }
      var meta = document.getElementById('lyricsMeta');
      if (meta) meta.textContent = '';
      var btnOffset = document.getElementById('btnOffsetToggle');
      if (btnOffset) { btnOffset.style.display = 'none'; btnOffset.classList.remove('active'); }
      var offsetRow = document.getElementById('offsetControlsRow');
      if (offsetRow) offsetRow.style.display = 'none';
      var searchRow = document.getElementById('lyricSearchRow');
      if (searchRow) searchRow.style.display = 'none';
      var btnSearch = document.getElementById('btnLyricSearch');
      if (btnSearch) btnSearch.classList.remove('active');
      updateOffsetDisplay();
    }

    function fetchLyrics(title, force) {
      if (!title) return;
      var key = getSongKey();
      if (!force && key) {
        var savedManual = '';
        try { savedManual = localStorage.getItem('bear_manual_lyric_' + key); } catch (e) {}
        if (savedManual) title = savedManual;
      }
      if (!force && title === lastLyricsTitle) return;
      lastLyricsTitle = title;
      lyricLines = [];
      currentLyricIdx = -1;
      updateOffsetDisplay();
      var scroll = document.getElementById('lyricsScroll');
      var meta = document.getElementById('lyricsMeta');
      var btnOffset = document.getElementById('btnOffsetToggle');
      if (btnOffset) btnOffset.style.display = 'none';
      var offsetRow = document.getElementById('offsetControlsRow');
      if (offsetRow) offsetRow.style.display = 'none';
      if (scroll) scroll.innerHTML = '<div class="lyrics-tip">搜索歌词中: ' + escapeHtml(title) + ' ...</div>';
      if (meta) meta.textContent = '';
      fetch('/lyrics?title=' + encodeURIComponent(title))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.lyrics && data.synced) {
            lyricLines = parseLrc(data.lyrics);
            renderLyricLines(lyricLines);
            if (meta) meta.textContent = (data.artistName ? data.artistName + ' · ' : '') + (data.trackName || '');
            if (btnOffset) btnOffset.style.display = 'inline-flex';
            if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
          } else if (data.lyrics) {
            if (scroll) scroll.innerHTML = '<div style="padding:10px;font-size:13px;color:#888;text-align:center;white-space:pre-line;line-height:2;max-height:240px;overflow:auto">' + escapeHtml(data.lyrics.substring(0, 1000)) + '</div>';
            if (meta) meta.textContent = '纯文本歌词';
            if (btnOffset) btnOffset.style.display = 'none';
          } else {
            if (scroll) scroll.innerHTML = '<div class="lyrics-tip">未找到歌词，可点击右上角 🔍 搜词尝试手动搜索</div>';
            if (btnOffset) btnOffset.style.display = 'none';
          }
        })
        .catch(function() {
          if (scroll) scroll.innerHTML = '<div class="lyrics-tip">歌词加载失败，请重试</div>';
        });
    }

    audioPlayer.addEventListener('timeupdate', function() { updateLyricSync(audioPlayer.currentTime); });
    videoPlayer.addEventListener('timeupdate', function() { updateLyricSync(videoPlayer.currentTime); });

    audioPlayer.addEventListener('ended', playNext);
    videoPlayer.addEventListener('ended', playNext);

    singleRepeatToggle.addEventListener('change', function() {
      if (currentPlayer) currentPlayer.loop = false;
    });

    randomToggle.addEventListener('change', function() {
      if (currentPlayer) currentPlayer.loop = false;
    });


    
    switchPlayer('audio');
    loadCachedSongs();
    updateUptime();
    setInterval(updateUptime, 1000);
    updateOnlineVisitors();
    setInterval(updateOnlineVisitors, 60 * 1000);
  </script>
</body>
</html>`;
}

function getManageHTMLContent() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>歌曲管理 - 熊宝宝的音乐播放器</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <meta name="theme-color" content="#667eea">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      padding: 24px;
      position: relative;
      margin-bottom: 90px;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid #f0f2f5;
      padding-bottom: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .title-group h1 {
      margin: 0;
      font-size: 22px;
      color: #2d3748;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title-group p {
      margin: 4px 0 0;
      font-size: 13px;
      color: #718096;
    }
    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: #667eea;
      color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .back-btn:hover {
      background: #5a67d8;
    }
    .tips-box {
      background: #ebf8ff;
      border-left: 4px solid #3182ce;
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 12px;
      color: #2b6cb0;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1;
      min-width: 220px;
      padding: 8px 12px;
      border: 1px solid #cbd5e0;
      border-radius: 6px;
      font-size: 13px;
      outline: none;
    }
    .search-input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
    }
    .btn {
      padding: 8px 14px;
      border-radius: 6px;
      border: none;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    .btn-danger {
      background: #e53e3e;
      color: #fff;
    }
    .btn-danger:hover { background: #c53030; }
    .btn-secondary {
      background: #edf2f7;
      color: #4a5568;
    }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-primary {
      background: #667eea;
      color: #fff;
    }
    .btn-primary:hover { background: #5a67d8; }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .song-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .song-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .song-card:hover {
      background: #fff;
      border-color: #cbd5e0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    .song-card.playing {
      background: #f0f4ff;
      border-color: #667eea;
    }
    .order-badge {
      font-size: 12px;
      font-weight: bold;
      color: #718096;
      min-width: 28px;
      text-align: center;
    }
    .order-btns {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .order-btn {
      background: none;
      border: 1px solid #cbd5e0;
      border-radius: 3px;
      font-size: 9px;
      padding: 1px 4px;
      cursor: pointer;
      color: #4a5568;
    }
    .order-btn:hover {
      background: #e2e8f0;
    }
    .song-info {
      flex: 1;
      min-width: 0;
    }
    .song-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .song-name-text {
      font-size: 14px;
      font-weight: 600;
      color: #2d3748;
      word-break: break-all;
    }
    .tag {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #e2e8f0;
      color: #4a5568;
    }
    .tag-video {
      background: #feebc8;
      color: #c05621;
    }
    .song-meta-text {
      font-size: 12px;
      color: #a0aec0;
      margin-top: 3px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .song-meta-text a {
      color: #667eea;
      text-decoration: none;
    }
    .song-meta-text a:hover {
      text-decoration: underline;
    }
    .song-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .act-btn {
      padding: 5px 10px;
      font-size: 12px;
      border-radius: 4px;
      border: 1px solid #cbd5e0;
      background: #fff;
      cursor: pointer;
      transition: all 0.2s;
    }
    .act-btn:hover {
      background: #f7fafc;
      border-color: #a0aec0;
    }
    .act-btn-del {
      color: #e53e3e;
      border-color: #fed7d7;
    }
    .act-btn-del:hover {
      background: #fff5f5;
      border-color: #e53e3e;
    }
    .edit-input-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
    }
    .edit-input {
      flex: 1;
      padding: 5px 8px;
      font-size: 13px;
      border: 1px solid #667eea;
      border-radius: 4px;
      outline: none;
    }
    .preview-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #2d3748;
      color: #fff;
      padding: 10px 20px;
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      flex-wrap: wrap;
    }
    .preview-bar.active {
      display: flex;
    }
    .preview-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      max-width: 320px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .preview-bar audio {
      height: 32px;
      flex: 1;
      min-width: 240px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="title-group">
        <h1>🎵 熊宝宝的音乐播放器 · 歌曲管理</h1>
        <p>管理曲库歌曲、在线重命名、上下调整排序与批量删除</p>
      </div>
      <div>
        <a href="/" class="back-btn">◀ 返回播放器</a>
      </div>
    </div>

    <div class="tips-box">
      💡 <strong>歌词匹配推荐格式</strong>：推荐将歌曲标题修改为「<strong>歌名 歌手</strong>」（例如：<code>相思 毛阿敏</code> 或 <code>情没有对错 鱼蛋</code>），播放器将自动以最高精准度全网检索匹配同步滚动歌词。点击右侧的「✏️ 编辑」按钮即可直接修改并保存到服务器。
    </div>

    <div class="toolbar">
      <input type="text" id="searchKeyword" class="search-input" placeholder="🔍 快速搜索歌名、歌手或格式..." oninput="onFilterChange()">
      <button type="button" class="btn btn-primary" onclick="document.getElementById('mcFileInput').click()">📁 本地上传</button>
      <input type="file" id="mcFileInput" style="display:none;" accept="audio/*,video/*" multiple onchange="mcUploadFiles(event)">
      <button type="button" class="btn btn-secondary" onclick="toggleSelectAll()">全选 / 反选</button>
      <button type="button" id="batchDelBtn" class="btn btn-danger" onclick="deleteBatch()" disabled>🗑️ 批量删除 (<span id="selectedCount">0</span>)</button>
      <button type="button" class="btn btn-secondary" onclick="loadSongs()">🔄 刷新列表</button>
    </div>

    <div id="mcUploadProgress" style="display:none; margin-bottom:12px; background:#edf2f7; border-radius:6px; padding:10px 14px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px;">
        <span id="mcUploadStatus" style="color:#4a5568; font-weight:600;">正在上传...</span>
        <span id="mcUploadPercent" style="color:#667eea; font-weight:bold;">0%</span>
      </div>
      <div style="background:#cbd5e0; border-radius:4px; height:8px; overflow:hidden;">
        <div id="mcProgressBar" style="width:0%; height:100%; background:linear-gradient(90deg, #667eea, #764ba2); transition: width 0.2s;"></div>
      </div>
    </div>

    <div id="statsBar" style="font-size: 12px; color: #718096; margin-bottom: 12px; display: flex; justify-content: space-between;">
      <span>共 <strong id="songCount" style="color: #667eea;">0</strong> 首歌曲</span>
      <span>总存储占用：<strong id="diskSize" style="color: #667eea;">0 MB</strong></span>
    </div>

    <div id="songList" class="song-list">
      <div style="text-align: center; color: #a0aec0; padding: 40px 0;">⏳ 加载歌曲列表中...</div>
    </div>
  </div>

  <div id="previewBar" class="preview-bar">
    <div class="preview-info">
      <span>▶ 正在试听:</span>
      <strong id="previewTitle" style="color: #90cdf4;"></strong>
    </div>
    <audio id="previewAudio" controls autoplay></audio>
    <button type="button" class="btn btn-secondary" onclick="stopPreview()" style="padding: 4px 10px; font-size: 12px;">关闭试听 ✖</button>
  </div>

  <script>
    let songsData = [];
    let selectedSet = new Set();
    let editingKey = null;
    let currentPreviewFile = '';

    function formatSize(bytes) {
      if (!bytes || isNaN(bytes)) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let val = Number(bytes);
      while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
      }
      return val.toFixed(1) + ' ' + units[i];
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\\'':'&#39;','"':'&quot;'}[char]));
    }

    function loadSongs() {
      fetch('/cache-list')
        .then(r => r.json())
        .then(data => {
          songsData = Array.isArray(data) ? data : [];
          selectedSet.clear();
          renderSongs();
        })
        .catch(err => {
          alert('获取歌曲列表失败: ' + err.message);
        });
    }

    function renderSongs() {
      const container = document.getElementById('songList');
      const kw = (document.getElementById('searchKeyword').value || '').trim().toLowerCase();
      
      let filtered = songsData.filter(s => {
        if (!kw) return true;
        const name = (s.name || '').toLowerCase();
        const url = (s.url || '').toLowerCase();
        return name.includes(kw) || url.includes(kw);
      });

      document.getElementById('songCount').textContent = songsData.length;
      const totalBytes = songsData.reduce((sum, s) => sum + (Number(s.size) || 0), 0);
      document.getElementById('diskSize').textContent = formatSize(totalBytes);
      updateSelectedCount();

      if (!filtered.length) {
        container.innerHTML = '<div style="text-align: center; color: #a0aec0; padding: 40px 0;">' + (kw ? '未找到符合条件的歌曲' : '暂无缓存歌曲，请先在播放器中添加播放') + '</div>';
        return;
      }

      container.innerHTML = filtered.map((song, idx) => {
        const isEditing = (editingKey === song.key);
        const isSelected = selectedSet.has(song.file);
        const isPlaying = (currentPreviewFile === song.file);

        let titleContent = '';
        if (isEditing) {
          titleContent = '<div class="edit-input-group">' +
            '<input type="text" id="editInput_' + song.key + '" class="edit-input" value="' + escapeHtml(song.name) + '" placeholder="歌名 歌手">' +
            '<button type="button" class="btn btn-primary" onclick="saveTitle(\\'' + song.key + '\\')">保存</button>' +
            '<button type="button" class="btn btn-secondary" onclick="cancelEdit()">取消</button>' +
            '</div>';
        } else {
          titleContent = '<span class="song-name-text">' + escapeHtml(song.name) + '</span>' +
            '<span class="tag ' + (song.type === 'video' ? 'tag-video' : '') + '">' + (song.type === 'video' ? '🎬 视频' : '🎵 音频') + '</span>' +
            (song.local ? '<span class="tag">本地</span>' : '<span class="tag">网络</span>') +
            (song.size ? '<span class="tag">' + formatSize(song.size) + '</span>' : '');
        }

        return '<div class="song-card ' + (isPlaying ? 'playing' : '') + '" id="card_' + song.key + '">' +
          '<input type="checkbox" onchange="toggleSelect(\\'' + song.file + '\\', this.checked)" ' + (isSelected ? 'checked' : '') + ' style="width: 16px; height: 16px; cursor: pointer;">' +
          '<div class="order-badge">' + (idx + 1) + '</div>' +
          '<div class="order-btns">' +
            '<button type="button" class="order-btn" title="上移" onclick="moveSong(' + idx + ', -1)" ' + (idx === 0 ? 'disabled' : '') + '>▲</button>' +
            '<button type="button" class="order-btn" title="下移" onclick="moveSong(' + idx + ', 1)" ' + (idx === filtered.length - 1 ? 'disabled' : '') + '>▼</button>' +
          '</div>' +
          '<div class="song-info">' +
            '<div class="song-title-row">' + titleContent + '</div>' +
            (!isEditing ? '<div class="song-meta-text">' +
              (song.url ? '<span>源地址: <a href="' + escapeHtml(song.url) + '" target="_blank" rel="noopener">打开原链接</a></span>' : '') +
              '<span>文件: ' + escapeHtml(song.file || song.key) + '</span>' +
            '</div>' : '') +
          '</div>' +
          '<div class="song-actions">' +
            (!isEditing ? '<button type="button" class="act-btn" onclick="togglePreview(\\'' + escapeHtml(song.file) + '\\', \\'' + escapeHtml(song.name) + '\\')">' + (isPlaying ? '⏸ 暂停' : '▶ 试听') + '</button>' : '') +
            (!isEditing ? '<button type="button" class="act-btn" onclick="startEdit(\\'' + song.key + '\\')">✏️ 编辑</button>' : '') +
            '<button type="button" class="act-btn act-btn-del" onclick="deleteSingle(\\'' + song.file + '\\', \\'' + escapeHtml(song.name) + '\\')">🗑️ 删除</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function onFilterChange() {
      renderSongs();
    }

    function toggleSelect(file, checked) {
      if (checked) selectedSet.add(file);
      else selectedSet.delete(file);
      updateSelectedCount();
    }

    function toggleSelectAll() {
      const allFiles = songsData.map(s => s.file);
      if (selectedSet.size === allFiles.length) {
        selectedSet.clear();
      } else {
        allFiles.forEach(f => selectedSet.add(f));
      }
      renderSongs();
    }

    function updateSelectedCount() {
      const count = selectedSet.size;
      document.getElementById('selectedCount').textContent = count;
      document.getElementById('batchDelBtn').disabled = (count === 0);
    }

    function startEdit(key) {
      editingKey = key;
      renderSongs();
      const input = document.getElementById('editInput_' + key);
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') saveTitle(key);
          if (e.key === 'Escape') cancelEdit();
        });
      }
    }

    function cancelEdit() {
      editingKey = null;
      renderSongs();
    }

    function saveTitle(key) {
      const input = document.getElementById('editInput_' + key);
      if (!input) return;
      const newTitle = input.value.trim();
      if (!newTitle) {
        alert('歌曲标题不能为空');
        return;
      }
      fetch('/cache-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, title: newTitle })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const item = songsData.find(s => s.key === key);
          if (item) item.name = newTitle;
          editingKey = null;
          renderSongs();
        } else {
          alert('修改失败: ' + (data.error || '未知错误'));
        }
      })
      .catch(err => alert('请求失败: ' + err.message));
    }

    function moveSong(index, delta) {
      const newIndex = index + delta;
      if (newIndex < 0 || newIndex >= songsData.length) return;
      const item = songsData.splice(index, 1)[0];
      songsData.splice(newIndex, 0, item);
      renderSongs();

      const orderedKeys = songsData.map(s => s.key);
      fetch('/cache-reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: orderedKeys })
      })
      .then(r => r.json())
      .then(data => {
        if (!data.success) {
          console.warn('排序同步失败:', data.error);
        }
      })
      .catch(err => console.warn('排序网络错误:', err.message));
    }

    function deleteSingle(file, name) {
      if (!confirm('确定要删除歌曲【' + name + '】吗？此操作将彻底删除缓存文件。')) return;
      fetch('/cache-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          if (currentPreviewFile === file) stopPreview();
          selectedSet.delete(file);
          songsData = songsData.filter(s => s.file !== file);
          renderSongs();
        } else {
          alert('删除失败: ' + (data.error || '未知错误'));
        }
      })
      .catch(err => alert('网络错误: ' + err.message));
    }

    function deleteBatch() {
      const files = Array.from(selectedSet);
      if (!files.length) return;
      if (!confirm('确定要批量删除选中的 ' + files.length + ' 首歌曲吗？此操作不可撤销。')) return;
      fetch('/cache-batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          if (files.includes(currentPreviewFile)) stopPreview();
          songsData = songsData.filter(s => !selectedSet.has(s.file));
          selectedSet.clear();
          renderSongs();
        } else {
          alert('批量删除失败: ' + (data.error || '未知错误'));
        }
      })
      .catch(err => alert('网络错误: ' + err.message));
    }

    function togglePreview(file, title) {
      const bar = document.getElementById('previewBar');
      const audio = document.getElementById('previewAudio');
      if (currentPreviewFile === file) {
        if (audio.paused) {
          audio.play();
        } else {
          audio.pause();
        }
        renderSongs();
        return;
      }
      currentPreviewFile = file;
      document.getElementById('previewTitle').textContent = title;
      audio.src = '/cache-audio?file=' + encodeURIComponent(file);
      bar.classList.add('active');
      audio.play().catch(e => console.warn(e));
      audio.onended = () => {
        currentPreviewFile = '';
        renderSongs();
      };
      renderSongs();
    }

    function stopPreview() {
      const bar = document.getElementById('previewBar');
      const audio = document.getElementById('previewAudio');
      audio.pause();
      audio.src = '';
      currentPreviewFile = '';
      bar.classList.remove('active');
      renderSongs();
    }

    async function mcUploadFiles(event) {
      const files = Array.from(event.target.files || []);
      if (!files.length) return;
      const progressBox = document.getElementById('mcUploadProgress');
      const statusText = document.getElementById('mcUploadStatus');
      const percentText = document.getElementById('mcUploadPercent');
      const bar = document.getElementById('mcProgressBar');
      progressBox.style.display = 'block';

      let successCount = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        statusText.textContent = '正在上传 (' + (i + 1) + '/' + files.length + '): ' + file.name;
        percentText.textContent = '0%';
        bar.style.width = '0%';

        try {
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/cache-upload', true);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                bar.style.width = percent + '%';
                percentText.textContent = percent + '%';
              }
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText));
              } else if (xhr.status === 413) {
                reject(new Error('文件 ' + file.name + ' 超过服务器大小限制 (413 Payload Too Large)'));
              } else {
                let errMsg = '上传失败';
                try {
                  const resJson = JSON.parse(xhr.responseText);
                  if (resJson.error) errMsg = resJson.error;
                } catch (e) {
                  errMsg = xhr.responseText || xhr.statusText || errMsg;
                }
                reject(new Error(file.name + ' 上传失败 (' + xhr.status + '): ' + errMsg));
              }
            };
            xhr.onerror = () => reject(new Error('上传网络错误: ' + file.name));
            const form = new FormData();
            form.append('file', file);
            xhr.send(form);
          });
          successCount++;
        } catch (err) {
          alert('上传出错: ' + err.message);
        }
      }

      if (successCount > 0) {
        statusText.textContent = '上传完成！成功添加 ' + successCount + ' 首歌曲';
        bar.style.width = '100%';
        percentText.textContent = '100%';
        setTimeout(() => { progressBox.style.display = 'none'; }, 1500);
        loadSongs();
      } else {
        progressBox.style.display = 'none';
      }
      event.target.value = '';
    }

    loadSongs();
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

function normalizeMetadataOrder(metadata) {
  const entries = Object.entries(metadata).sort(([, a], [, b]) => {
    const ao = Number(a.order) || Number.MAX_SAFE_INTEGER;
    const bo = Number(b.order) || Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  entries.forEach(([, item], index) => { item.order = index + 1; });
  return metadata;
}

function writeCacheMetadataEntry(key, value) {
  metadataWriteQueue = metadataWriteQueue.then(() => {
    const metadata = normalizeMetadataOrder(readCacheMetadata());
    const existing = metadata[key] || {};
    if (!existing.order) existing.order = Object.keys(metadata).length + 1;
    metadata[key] = { ...existing, ...value, order: existing.order };
    const normalized = normalizeMetadataOrder(metadata);
    const temp = CACHE_META + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
    fs.renameSync(temp, CACHE_META);
  });
  return metadataWriteQueue;
}

function deleteCacheMetadataEntry(key) {
  metadataWriteQueue = metadataWriteQueue.then(() => {
    const metadata = readCacheMetadata();
    delete metadata[key];
    const normalized = normalizeMetadataOrder(metadata);
    const temp = CACHE_META + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
    fs.renameSync(temp, CACHE_META);
  });
  return metadataWriteQueue;
}

function handleCacheList(res) {
  const metadata = readCacheMetadata();
  const files = fs.readdirSync(CACHE_DIR).filter(file => /\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(file));
  const activeKeys = new Set(files.map(file => file.replace(/\.[^.]+$/, '')));
  const reconciled = Object.fromEntries(Object.entries(metadata).filter(([key]) => activeKeys.has(key)));
  const normalized = normalizeMetadataOrder(reconciled);
  if (JSON.stringify(normalized) !== JSON.stringify(metadata)) {
    metadataWriteQueue = metadataWriteQueue.then(() => {
      const temp = CACHE_META + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
      fs.renameSync(temp, CACHE_META);
    });
  }
  const items = files.map(file => {
    const key = file.replace(/\.[^.]+$/, '');
    const item = normalized[file] || normalized[key] || {};
    const isVideo = /\.(mp4|webm|mov)$/i.test(file);
    const filePath = path.join(CACHE_DIR, file);
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (e) {}
    return {
      key: key,
      file: file,
      size: size,
      order: Number(item.order) || 999999,
      type: isVideo ? 'video' : 'audio',
      src: '/cache-audio?file=' + encodeURIComponent(file),
      name: item.title || '缓存歌曲 ' + key.slice(0, 8),
      url: item.url || '',
      cached: true,
      local: Boolean(item.local)
    };
  }).sort((a, b) => a.order - b.order);
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
      const format = getYouTubeFormat(data.format);
      if (!format) throw new Error('invalid format');
      const key = getYouTubeCacheKey(data.url, format);
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
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid multipart upload' }));
    return;
  }
  const boundary = Buffer.from('--' + (boundaryMatch[1] || boundaryMatch[2]));
  const chunks = [];

  req.on('data', chunk => chunks.push(chunk));
  req.on('error', err => {
    console.error('上传请求出错:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });

  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const start = body.indexOf(boundary);
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
      const end = body.indexOf(boundary, headerEnd + 4);
      if (start < 0 || headerEnd < 0 || end < 0) {
        throw new Error('无效的上传数据格式');
      }

      const headers = body.slice(start, headerEnd).toString('utf8');
      let rawName = '';
      const utf8NameMatch = headers.match(/filename\*=(?:UTF-8'')?([^;\r\n]+)/i);
      if (utf8NameMatch) {
        try {
          rawName = decodeURIComponent(utf8NameMatch[1].replace(/^["']|["']$/g, ''));
        } catch (e) {
          rawName = utf8NameMatch[1];
        }
      }
      if (!rawName) {
        const nameMatch = headers.match(/filename="?([^"\r\n;]+)"?/i);
        if (nameMatch) {
          rawName = nameMatch[1];
        }
      }
      if (!rawName) throw new Error('未获取到文件名');
      const originalName = path.basename(rawName.replace(/\\/g, '/'));
      const ext = path.extname(originalName).toLowerCase();
      if (!/\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(ext)) {
        throw new Error('不支持的文件格式: ' + ext);
      }

      let fileEnd = end;
      if (fileEnd >= 2 && body[fileEnd - 2] === 0x0D && body[fileEnd - 1] === 0x0A) {
        fileEnd -= 2;
      } else if (fileEnd >= 1 && (body[fileEnd - 1] === 0x0A || body[fileEnd - 1] === 0x0D)) {
        fileEnd -= 1;
      }
      const fileData = body.slice(headerEnd + 4, fileEnd);

      const key = crypto.createHash('sha256').update(fileData).digest('hex');
      const fileName = key + ext;
      const cleanTitle = originalName.replace(/\.[^.]+$/, '');

      fs.writeFileSync(path.join(CACHE_DIR, fileName), fileData);

      writeCacheMetadataEntry(key, { title: cleanTitle, local: true }).then(() => {
        const item = {
          key: key,
          file: fileName,
          size: fileData.length,
          type: ext === '.mp4' || ext === '.webm' || ext === '.mov' ? 'video' : 'audio',
          src: '/cache-audio?file=' + encodeURIComponent(fileName),
          name: cleanTitle,
          cached: true,
          local: true
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '写入元数据失败: ' + err.message }));
      });
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
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

function handleCacheUpdate(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const key = String(data.key || '').trim();
      if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error('无效的歌曲标识');
      metadataWriteQueue = metadataWriteQueue.then(() => {
        const metadata = readCacheMetadata();
        if (!metadata[key]) {
          metadata[key] = {};
        }
        if (data.title !== undefined) {
          metadata[key].title = String(data.title).trim();
        }
        if (data.order !== undefined) {
          const ord = parseInt(data.order, 10);
          if (!isNaN(ord)) metadata[key].order = ord;
        }
        const normalized = normalizeMetadataOrder(metadata);
        const temp = CACHE_META + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
        fs.renameSync(temp, CACHE_META);
      }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

function handleCacheReorder(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const keys = Array.isArray(data.keys) ? data.keys : [];
      if (!keys.length) throw new Error('缺少序号列表');
      metadataWriteQueue = metadataWriteQueue.then(() => {
        const metadata = readCacheMetadata();
        keys.forEach((k, idx) => {
          if (metadata[k]) metadata[k].order = idx + 1;
        });
        const normalized = normalizeMetadataOrder(metadata);
        const temp = CACHE_META + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
        fs.renameSync(temp, CACHE_META);
      }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

function handleCacheBatchDelete(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) throw new Error('请选择要删除的文件');
      metadataWriteQueue = metadataWriteQueue.then(() => {
        const metadata = readCacheMetadata();
        files.forEach(f => {
          const file = path.basename(String(f));
          if (/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file)) {
            const target = path.join(CACHE_DIR, file);
            if (fs.existsSync(target)) {
              try { fs.unlinkSync(target); } catch (e) {}
            }
            const key = file.replace(/\.[^.]+$/, '');
            delete metadata[key];
          }
        });
        const normalized = normalizeMetadataOrder(metadata);
        const temp = CACHE_META + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
        fs.renameSync(temp, CACHE_META);
      }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}
function streamAudioFile(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File stat error');
    return;
  }

  const total = stat.size;
  const range = req && req.headers ? req.headers.range : null;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const partialstart = parts[0];
    const partialend = parts[1];

    const start = parseInt(partialstart, 10);
    const end = partialend ? parseInt(partialend, 10) : total - 1;

    if (isNaN(start) || start >= total || (end && end >= total) || start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }

    const chunksize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000'
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => {
      console.warn('Audio stream error (range):', err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    if (req) {
      req.on('close', () => { stream.destroy(); });
    }
    res.on('close', () => { stream.destroy(); });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000'
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.warn('Audio stream error:', err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    if (req) {
      req.on('close', () => { stream.destroy(); });
    }
    res.on('close', () => { stream.destroy(); });
    stream.pipe(res);
  }
}

function handleCacheAudio(req, res, url) {
  const file = path.basename(url.searchParams.get('file') || '');
  const target = path.join(CACHE_DIR, file);
  if (!/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file) || !fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Cache file not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = /\.(mp4|webm|mov)$/i.test(ext) ? 'video/mp4' : (ext === '.flac' ? 'audio/flac' : (ext === '.wav' ? 'audio/wav' : 'audio/mpeg'));
  streamAudioFile(req, res, target, contentType);
}

function handleCacheProgress(url, res) {
  const inputUrl = url.searchParams.get('url') || '';
  const format = getYouTubeFormat(url.searchParams.get('format'));
  if (!format) { res.writeHead(400); res.end('Invalid format'); return; }
  const key = getYouTubeCacheKey(inputUrl, format);
  const cachePath = path.join(CACHE_DIR, `${key}.${format}`);
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
      const format = getYouTubeFormat(data.format);
      if (!validateYouTubeUrl(inputUrl) || !format) throw new Error('Invalid YouTube URL or format');
      let title = '';
      try {
        const ytArgs = [
          '--socket-timeout', '30',
          '--no-warnings',
          '--no-playlist',
          '--print', '%(title)s',
          '--skip-download'
        ];
        const cookiesPath = getYouTubeCookiesPath();
        if (cookiesPath) ytArgs.unshift('--cookies', cookiesPath);
        if (YOUTUBE_PROXY) ytArgs.unshift('--proxy', YOUTUBE_PROXY);
        ytArgs.push(inputUrl);
        const { stdout } = await execFileAsync('yt-dlp', ytArgs, { timeout: 70000 });
        title = stdout.trim().split('\n').filter(Boolean).pop() || '';
      } catch (e) {
        console.warn('Title lookup failed; metadata will be saved after a successful title lookup:', e.message);
      }
      const finalTitle = title.substring(0, 200);
      if (finalTitle) {
        const key = getYouTubeCacheKey(inputUrl, format);
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

function startDownload(inputUrl, key, cachePath, format) {
  if (DOWNLOAD_TASKS.has(key)) return DOWNLOAD_TASKS.get(key);
  const task = new Promise((resolve, reject) => {
    const tempPath = format === 'mp4' ? cachePath + '.download.mp4' : cachePath + '.part';
    try { fs.unlinkSync(tempPath); } catch {}
    const { spawn } = require('child_process');
    const ytArgs = ['--socket-timeout', '30', '--no-warnings', '--no-playlist', '--newline'];
    if (format === 'mp4') {
      ytArgs.push('--concurrent-fragments', '4', '-f', 'bv[height<=720]+ba/bv+ba', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', tempPath, inputUrl);
    } else {
      ytArgs.push('-f', 'bestaudio', '-o', '-', inputUrl);
    }
    const cookiesPath = getYouTubeCookiesPath();
    if (cookiesPath) ytArgs.unshift('--cookies', cookiesPath);
    if (YOUTUBE_PROXY) ytArgs.unshift('--proxy', YOUTUBE_PROXY);
    let attempts = 0;
    const run = () => {
      attempts++;
      DOWNLOAD_PROGRESS.set(key, { status: 'loading', percent: 0, attempt: attempts });
      console.log(`[cache] ${format.toUpperCase()} download started (key=${key.slice(0, 12)}, attempt=${attempts}/3${cookiesPath ? ', cookies=yes' : ''})`);
      const yt = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpeg = format === 'mp3'
        ? spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'mp3', '-q:a', '5', tempPath], { stdio: ['pipe', 'ignore', 'pipe'] })
        : null;
      const progressPattern = /\[download\]\s+(\d+(?:\.\d+)?)%/;
      const logYtOutput = (stream, data) => {
        const text = data.toString();
        const match = text.match(progressPattern);
        if (match) DOWNLOAD_PROGRESS.set(key, { status: 'loading', percent: Number(match[1]), attempt: attempts });
        console.log(`yt-dlp ${stream}:`, text.trim().slice(0, 300));
      };
      if (ffmpeg) yt.stdout.pipe(ffmpeg.stdin);
      else yt.stdout.on('data', data => logYtOutput('stdout', data));
      yt.stderr.on('data', data => logYtOutput('stderr', data));
      if (ffmpeg) ffmpeg.stderr.on('data', data => console.log('FFmpeg:', data.toString().trim().slice(0, 300)));
      yt.on('error', error => console.error('yt-dlp error:', error.message));
      if (ffmpeg) ffmpeg.on('error', error => console.error('FFmpeg error:', error.message));
      const finish = (ytCode, ffmpegCode = 0) => {
        let outputSize = 0;
        try { outputSize = fs.statSync(tempPath).size; } catch (error) {
          if (error.code !== 'ENOENT') return reject(error);
        }
        const downloaded = ytCode === 0 && ffmpegCode === 0 && outputSize > 0;
        if (downloaded) {
          fs.rename(tempPath, cachePath, error => {
            if (error) return reject(error);
            writeCacheMetadataEntry(key, { url: inputUrl }).then(() => {
              DOWNLOAD_PROGRESS.set(key, { status: 'complete', percent: 100 });
              console.log(`[cache] ${format.toUpperCase()} download completed (key=${key.slice(0, 12)}, size=${fs.statSync(cachePath).size} bytes)`);
              resolve(cachePath);
            }).catch(reject);
          });
        } else if (attempts < 3) {
          console.warn(`[cache] ${format.toUpperCase()} download attempt ${attempts}/3 failed (key=${key.slice(0, 12)}, yt-dlp exit=${ytCode}, ffmpeg exit=${ffmpegCode}, output=${outputSize} bytes); retrying`);
          try { fs.unlinkSync(tempPath); } catch {}
          setTimeout(run, attempts * 1000);
        } else {
          try { fs.unlinkSync(tempPath); } catch {}
          DOWNLOAD_PROGRESS.set(key, { status: 'error', percent: 0, attempt: attempts });
          console.error(`[cache] ${format.toUpperCase()} download failed (key=${key.slice(0, 12)}, yt-dlp exit=${ytCode}, ffmpeg exit=${ffmpegCode}, output=${outputSize} bytes)`);
          reject(new Error(`YouTube ${format.toUpperCase()} 下载失败，已重试 3 次`));
        }
      };
      if (ffmpeg) {
        Promise.all([
          new Promise(resolve => yt.once('close', resolve)),
          new Promise(resolve => ffmpeg.once('close', resolve))
        ]).then(([ytCode, ffmpegCode]) => finish(ytCode, ffmpegCode));
      } else {
        yt.once('close', code => finish(code));
      }
    };
    run();
  }).finally(() => setTimeout(() => DOWNLOAD_TASKS.delete(key), 60000));
  DOWNLOAD_TASKS.set(key, task);
  return task;
}

function sendCachedAudio(req, res, cachePath) {
  const ext = path.extname(cachePath).toLowerCase();
  const contentType = ext === '.mp4' ? 'video/mp4' : 'audio/mpeg';
  streamAudioFile(req, res, cachePath, contentType);
}

async function handlePreload(url, req, res) {
  const inputUrl = url.searchParams.get('url') || '';
  if (!validateYouTubeUrl(inputUrl)) { res.writeHead(400); res.end('Invalid YouTube URL'); return; }
  const format = getYouTubeFormat(url.searchParams.get('format'));
  if (!format) { res.writeHead(400); res.end('Invalid format'); return; }
  const key = getYouTubeCacheKey(inputUrl, format);
  const cachePath = path.join(CACHE_DIR, `${key}.${format}`);
  if (!fs.existsSync(cachePath)) startDownload(inputUrl, key, cachePath, format).catch(error => console.error('Preload failed:', error.message));
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ accepted: true, key }));
}

async function handleYouTubeAudio(url, req, res) {
  const inputUrl = url.searchParams.get('url') || '';
  if (!validateYouTubeUrl(inputUrl)) { res.writeHead(400); res.end('Invalid YouTube URL'); return; }
  const format = getYouTubeFormat(url.searchParams.get('format'));
  if (!format) { res.writeHead(400); res.end('Invalid format'); return; }
  const key = getYouTubeCacheKey(inputUrl, format);
  const cachePath = path.join(CACHE_DIR, `${key}.${format}`);
  try {
    if (!fs.existsSync(cachePath)) await startDownload(inputUrl, key, cachePath, format);
    sendCachedAudio(req, res, cachePath);
  } catch (error) {
    if (!res.headersSent) { res.writeHead(502); res.end(error.message); }
  }
}

function fetchJson(targetUrl, options, timeoutMs) {
  if (typeof options === 'number') { timeoutMs = options; options = {}; }
  timeoutMs = timeoutMs || 8000;
  options = options || {};
  return new Promise(function(resolve, reject) {
    let url;
    try { url = new URL(targetUrl); } catch (e) { return reject(e); }
    const client = url.protocol === 'https:' ? https : http;
    let timer;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }, options.headers || {});
    const req = client.get(url, { headers }, function(proxyRes) {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        clearTimeout(timer);
        return fetchJson(proxyRes.headers.location, options, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      proxyRes.on('data', function(chunk) { data += chunk; });
      proxyRes.on('end', function() {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', function(err) { clearTimeout(timer); reject(err); });
    timer = setTimeout(function() { req.destroy(); reject(new Error('lyrics fetch timeout')); }, timeoutMs);
  });
}

function cleanSongTitle(title) {
  if (!title) return '';
  let s = title;

  // 1. 去除常见的视频噪音标记（中英文）
  const junkPatterns = [
    /[(\[【（\s]*(?:official\s*(?:music\s*)?(?:video|mv|audio)|official|mv|hd|4k|1080p|720p|live|现场版?|完整版|高清|动态歌词|歌词版|无损|超清|高画质|官方(?:完整版|高画质|mv)?|music\s*video|lyric[s]?\s*(?:video)?|audio)[)\]】）\s]*/gi,
    /\s*[|｜].*$/g, // 去除管道符后面的附属栏目信息
    /\s*-\s*$/g
  ];

  for (const pat of junkPatterns) {
    s = s.replace(pat, ' ');
  }

  // 2. 智能提取书名号中的歌名及周围的歌手名（支持 歌手《歌名》 和 《歌名》歌手）
  const bookMatch = s.match(/^(.*?)[《〈](.*?)[》〉](.*)$/);
  if (bookMatch) {
    const before = bookMatch[1].replace(/[(\[【（].*?[)\]】）]/g, '').trim();
    const song = bookMatch[2].trim();
    const after = bookMatch[3].replace(/[(\[【（].*?[)\]】）]/g, '').trim();
    const artist = before || after || '';
    if (song) return (song + (artist ? ' ' + artist : '')).trim();
  }

  // 3. 去掉普通括号符号，保留里面的有效歌名/歌手文字
  s = s.replace(/[【】\[\]()（）]/g, ' ');

  // 4. 清理连续空格
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 酷狗音乐：国内曲库最全、支持云服务器 IP 请求且免鉴权
async function searchKugouLyrics(cleanTitle, rawTitle) {
  const tryQueries = [];
  if (cleanTitle) tryQueries.push(cleanTitle);

  // 针对用户在 index.json 中整理的「歌名 歌手」格式或含分隔符的情况生成拆分检索词
  const parts = cleanTitle.split(/\s*[-_—/|｜]\s*|\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const qComb = parts[0] + ' ' + parts.slice(1).join(' ');
    if (!tryQueries.includes(qComb)) tryQueries.push(qComb);
    if (!tryQueries.includes(parts[0])) tryQueries.push(parts[0]);
  }
  if (rawTitle && !tryQueries.includes(rawTitle)) {
    tryQueries.push(rawTitle);
  }

  for (const q of tryQueries) {
    if (!q || !q.trim()) continue;
    try {
      const searchUrl = 'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(q.trim()) + '&page=1&pagesize=5&showtype=1';
      const data = await fetchJson(searchUrl, 5000);
      const songs = data && data.data && data.data.info ? data.data.info : [];
      for (const song of songs) {
        if (!song.hash) continue;
        if (song.songname && /伴奏|Instrumental|Karaoke/i.test(song.songname) && !/伴奏/i.test(q)) continue;
        const lrcSearchUrl = 'http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=' + song.hash;
        const lrcSearchData = await fetchJson(lrcSearchUrl, 5000);
        if (lrcSearchData && lrcSearchData.candidates && lrcSearchData.candidates.length) {
          const cand = lrcSearchData.candidates[0];
          const dlUrl = 'http://krcs.kugou.com/download?ver=1&client=mobi&id=' + cand.id + '&accesskey=' + cand.accesskey + '&fmt=lrc&charset=utf8';
          const dlData = await fetchJson(dlUrl, 5000);
          if (dlData && dlData.content) {
            const lrcText = Buffer.from(dlData.content, 'base64').toString('utf8');
            if (lrcText && lrcText.length > 20 && /\[\d{1,3}:\d{2}/.test(lrcText)) {
              return {
                lyrics: lrcText,
                synced: true,
                trackName: cand.song || song.songname || '',
                artistName: cand.singer || song.singername || '',
                source: 'kugou'
              };
            }
          }
        }
      }
    } catch (e) {
      console.warn('Kugou lyrics fetch error for query:', q, e.message);
    }
  }
  return null;
}

// 网易云音乐备用
async function searchNeteaseLyrics(cleanTitle) {
  const neteaseHeaders = {
    'Referer': 'https://music.163.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  try {
    const searchRes = await fetchJson(
      'https://music.163.com/api/search/get/web?csrf_token=&s=' + encodeURIComponent(cleanTitle) + '&type=1&offset=0&total=false&limit=5',
      { headers: neteaseHeaders },
      6000
    );
    const songs = searchRes && searchRes.result && searchRes.result.songs;
    if (songs && songs.length) {
      for (let i = 0; i < Math.min(songs.length, 5); i++) {
        const song = songs[i];
        if (song.name && /伴奏|Instrumental|Karaoke/i.test(song.name) && !/伴奏/i.test(cleanTitle)) continue;
        const lyricsRes = await fetchJson(
          'https://music.163.com/api/song/lyric?id=' + song.id + '&lv=1&kv=1&tv=-1',
          { headers: neteaseHeaders },
          5000
        );
        const lrc = lyricsRes && lyricsRes.lrc && lyricsRes.lrc.lyric;
        if (lrc && lrc.trim() && lrc.trim() !== '[00:00.000]\n' && lrc.length > 20) {
          const artistName = (song.artists || []).map(function(a) { return a.name; }).join(' / ');
          return {
            lyrics: lrc,
            synced: true,
            trackName: song.name || '',
            artistName: artistName,
            source: 'netease'
          };
        }
      }
    }
  } catch (e) {
    console.warn('Netease lyrics failed:', e.message);
  }
  return null;
}

// lrclib.net 备用（外文歌曲）
async function searchLrclibLyrics(cleanTitle) {
  try {
    const results = await fetchJson('https://lrclib.net/api/search?q=' + encodeURIComponent(cleanTitle), 6000);
    if (Array.isArray(results) && results.length) {
      const best = results.find(function(r) { return r.syncedLyrics; }) || results.find(function(r) { return r.plainLyrics; }) || null;
      if (best) {
        return {
          lyrics: best.syncedLyrics || best.plainLyrics,
          synced: !!best.syncedLyrics,
          trackName: best.trackName || '',
          artistName: best.artistName || '',
          source: 'lrclib'
        };
      }
    }
  } catch (e) {
    console.warn('lrclib lyrics failed:', e.message);
  }
  return null;
}

async function handleLyrics(url, res) {
  const rawTitle = (url.searchParams.get('title') || '').trim().substring(0, 200);
  if (!rawTitle) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'title required' }));
    return;
  }
  const cleanTitle = cleanSongTitle(rawTitle) || rawTitle;

  // 1. 优先使用酷狗音乐（国内曲库全、云服务器绝不封禁、免鉴权）
  let result = await searchKugouLyrics(cleanTitle, rawTitle);

  // 2. 备用：网易云音乐
  if (!result) {
    result = await searchNeteaseLyrics(cleanTitle);
  }

  // 3. 备用：lrclib.net（外文/欧美歌曲）
  if (!result) {
    result = await searchLrclibLyrics(cleanTitle);
  }

  if (result) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lyrics: null }));
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
