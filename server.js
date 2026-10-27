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
const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES || '';

function getYouTubeProxy() {
  const envCandidates = [
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(CACHE_DIR, '.env'),
    '/app/.env'
  ];
  for (const envFile of envCandidates) {
    if (fs.existsSync(envFile)) {
      try {
        const content = fs.readFileSync(envFile, 'utf8');
        const match = content.match(/^\s*YOUTUBE_PROXY\s*=\s*(.+)$/m);
        if (match) {
          const proxyVal = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (proxyVal) return proxyVal;
        }
      } catch (e) {}
    }
  }
  return process.env.YOUTUBE_PROXY || '';
}

const initialProxy = getYouTubeProxy();
if (initialProxy) {
  try {
    const proxyUrl = new URL(initialProxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol) || !proxyUrl.hostname || !proxyUrl.port) {
      console.warn('[proxy] YOUTUBE_PROXY 格式可能不完整，建议如 http://192.168.8.100:1088');
    }
  } catch (e) {
    console.warn('[proxy] YOUTUBE_PROXY 解析提示:', e.message);
  }
}

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
const startDateStr = new Date(startTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
let visitorCount = 0;

// P1: metadata 内存缓存，避免每次请求都读磁盘
let _metadataCache = null;
let _metadataCacheTime = 0;
const METADATA_CACHE_TTL = 5000; // 5秒 TTL，写入后立即失效

// P2: 定时清理过期在线访客，结算并持久化本次会话在线时长，避免每次请求遍历
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of ONLINE_VISITORS) {
    const lastSeen = (typeof session === 'object' && session) ? session.lastSeen : session;
    if (now - lastSeen >= ONLINE_VISITOR_TIMEOUT) {
      try {
        const date = getShanghaiDate();
        const visitors = readVisitorData();
        const existing = visitors.days && visitors.days[date] && visitors.days[date][id];
        if (existing && typeof session === 'object' && session && session.sessionStart) {
          const duration = Math.round((lastSeen - session.sessionStart) / 1000);
          if (duration > 0) existing.sessionDuration = duration;
          writeVisitorData(visitors);
        }
      } catch (e) {
        console.warn('Session end record warning:', e.message);
      }
      ONLINE_VISITORS.delete(id);
    }
  }
}, 30000);

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

function getClientIp(req) {
  let ip = '';
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    ip = String(xForwardedFor).split(',')[0].trim();
  } else if (req.headers['x-real-ip']) {
    ip = String(req.headers['x-real-ip']).trim();
  } else if (req.headers['cf-connecting-ip']) {
    ip = String(req.headers['cf-connecting-ip']).trim();
  } else if (req.socket && req.socket.remoteAddress) {
    ip = String(req.socket.remoteAddress).trim();
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip || '127.0.0.1';
}

function parseClientInfo(userAgent = '') {
  const ua = String(userAgent || '').trim();
  if (!ua) {
    return {
      client: '未知客户端',
      platform: '未知系统',
      browser: '未知浏览器',
      device: '未知设备',
      isApp: false
    };
  }

  const isBearApp = /BearMusicApp(?:\/([0-9.]+))?/i.test(ua);
  const isWebIntoApp = /WebIntoApp/i.test(ua);
  const isApp = isBearApp || isWebIntoApp;

  let platform = '未知系统';
  let device = '电脑 (Desktop)';
  if (/Android/i.test(ua)) {
    const match = ua.match(/Android\s+([0-9.]+)/i);
    platform = match ? `Android ${match[1]}` : 'Android';
    device = '手机 (Mobile)';
  } else if (/iPhone/i.test(ua)) {
    const match = ua.match(/OS\s+([0-9_]+)/i);
    platform = match ? `iOS ${match[1].replace(/_/g, '.')}` : 'iOS';
    device = '手机 (iPhone)';
  } else if (/iPad/i.test(ua)) {
    const match = ua.match(/OS\s+([0-9_]+)/i);
    platform = match ? `iPadOS ${match[1].replace(/_/g, '.')}` : 'iPadOS';
    device = '平板 (iPad)';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    const match = ua.match(/Mac OS X\s+([0-9_]+)/i);
    platform = match ? `macOS ${match[1].replace(/_/g, '.')}` : 'macOS';
    device = '电脑 (Mac)';
  } else if (/Windows NT/i.test(ua)) {
    device = '电脑 (Windows)';
    if (/Windows NT 10\.0/i.test(ua)) platform = 'Windows 10/11';
    else if (/Windows NT 6\.3/i.test(ua)) platform = 'Windows 8.1';
    else if (/Windows NT 6\.1/i.test(ua)) platform = 'Windows 7';
    else platform = 'Windows';
  } else if (/Linux/i.test(ua)) {
    platform = 'Linux';
    device = '电脑 (Linux)';
  }

  let browser = 'Web 浏览器';
  if (isBearApp) {
    const match = ua.match(/BearMusicApp\/([0-9.]+)/i);
    const ver = match ? match[1] : '1.0';
    browser = `BearMusicApp v${ver}`;
  } else if (isWebIntoApp) {
    browser = 'WebIntoApp';
  } else if (/MicroMessenger/i.test(ua)) {
    browser = '微信内置浏览器';
  } else if (/QQ\//i.test(ua)) {
    browser = '手机QQ';
  } else if (/Edg(?:e|A|iOS)?\/([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Edg(?:e|A|iOS)?\/([0-9.]+)/i);
    browser = `Edge ${match ? match[1].split('.')[0] : ''}`.trim();
  } else if (/Chrome\/([0-9.]+)/i.test(ua) && !/Chromium|Edg/i.test(ua)) {
    const match = ua.match(/Chrome\/([0-9.]+)/i);
    browser = `Chrome ${match ? match[1].split('.')[0] : ''}`.trim();
  } else if (/Safari/i.test(ua) && !/Chrome|Android/i.test(ua)) {
    browser = 'Safari';
  } else if (/Firefox\/([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Firefox\/([0-9.]+)/i);
    browser = `Firefox ${match ? match[1].split('.')[0] : ''}`.trim();
  } else if (/curl/i.test(ua)) {
    browser = 'curl';
    device = '终端命令行';
    platform = 'CLI';
  } else if (/wget/i.test(ua)) {
    browser = 'wget';
    device = '终端命令行';
    platform = 'CLI';
  }

  let client = '';
  if (isBearApp) {
    client = `🐻 熊宝宝App (${platform})`;
  } else if (isWebIntoApp) {
    client = `📱 WebIntoApp (${platform})`;
  } else {
    client = `${browser} (${platform})`;
  }

  return { client, platform, browser, device, isApp };
}

function getVisitorIdentity(req) {
  const deviceCookie = String(req.headers.cookie || '').split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith('bear_device='));
  const deviceId = deviceCookie ? deviceCookie.slice('bear_device='.length) : crypto.randomUUID();
  const ip = getClientIp(req);
  return {
    deviceId,
    ip,
    visitorId: crypto.createHash('sha256').update(`${ip}|${deviceId}`).digest('hex'),
    secure: req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
  };
}

function setVisitorCookie(res, deviceId, secure) {
  res.setHeader('Set-Cookie', `bear_device=${encodeURIComponent(deviceId)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function cleanYouTubeUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return inputUrl || '';
  try {
    const raw = inputUrl.trim();
    const parsedUrl = new URL(raw);
    const host = parsedUrl.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const vid = parsedUrl.pathname.replace(/^\/+/, '').split('/')[0];
      if (vid) return `https://www.youtube.com/watch?v=${vid}`;
    }
    if (host.includes('youtube.com')) {
      const vid = parsedUrl.searchParams.get('v');
      if (vid) return `https://www.youtube.com/watch?v=${vid}`;
    }
  } catch {}
  return String(inputUrl).trim();
}

function getYouTubeCacheKey(inputUrl, format) {
  const cleanUrl = cleanYouTubeUrl(inputUrl);
  const keyInput = format === 'mp4' ? `${cleanUrl}\nmp4` : cleanUrl;
  return crypto.createHash('sha256').update(keyInput).digest('hex');
}

function getYouTubeFormat(value) {
  return value === 'mp4' ? 'mp4' : value === 'mp3' || !value ? 'mp3' : null;
}

function getClientVisitor(req, res) {
  const { deviceId, visitorId, ip, secure } = getVisitorIdentity(req);
  const date = getShanghaiDate();
  const visitors = readVisitorData();
  visitors.days[date] ||= {};
  const dayVisitors = visitors.days[date];
  const username = String(req.headers['x-auth-request-user'] || '').trim();
  const email = String(req.headers['x-auth-request-email'] || '').trim();
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const clientInfo = parseClientInfo(userAgent);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  let session = ONLINE_VISITORS.get(visitorId);
  const lastSeenMs = (typeof session === 'object' && session) ? session.lastSeen : (session || 0);
  if (!session || (nowMs - lastSeenMs >= ONLINE_VISITOR_TIMEOUT)) {
    session = { sessionStart: nowMs, lastSeen: nowMs };
  } else {
    session.lastSeen = nowMs;
    if (!session.sessionStart) session.sessionStart = nowMs;
  }
  ONLINE_VISITORS.set(visitorId, session);

  const existing = dayVisitors[visitorId];

  if (!existing) {
    dayVisitors[visitorId] = {
      firstSeen: nowIso,
      lastSeen: nowIso,
      sessionStart: new Date(session.sessionStart).toISOString(),
      sessionDuration: Math.max(1, Math.round((nowMs - session.sessionStart) / 1000)),
      visitCount: 1,
      ip,
      client: clientInfo.client,
      platform: clientInfo.platform,
      browser: clientInfo.browser,
      device: clientInfo.device,
      isApp: clientInfo.isApp,
      userAgent,
      ...(username ? { username } : {}),
      ...(email ? { email } : {})
    };
    writeVisitorData(visitors);
  } else {
    let dirty = false;
    existing.visitCount = (existing.visitCount || 1) + 1;
    existing.lastSeen = nowIso;
    existing.sessionStart = new Date(session.sessionStart).toISOString();
    existing.sessionDuration = Math.max(1, Math.round((nowMs - session.sessionStart) / 1000));
    dirty = true;

    if (ip && existing.ip !== ip) {
      existing.ip = ip;
      dirty = true;
    }
    if (userAgent && (!existing.userAgent || existing.userAgent !== userAgent)) {
      existing.userAgent = userAgent;
      existing.client = clientInfo.client;
      existing.platform = clientInfo.platform;
      existing.browser = clientInfo.browser;
      existing.device = clientInfo.device;
      existing.isApp = clientInfo.isApp;
      dirty = true;
    } else if (!existing.client) {
      existing.client = clientInfo.client;
      existing.platform = clientInfo.platform;
      existing.browser = clientInfo.browser;
      existing.device = clientInfo.device;
      existing.isApp = clientInfo.isApp;
      dirty = true;
    }
    if (username && existing.username !== username) {
      existing.username = username;
      dirty = true;
    }
    if (email && existing.email !== email) {
      existing.email = email;
      dirty = true;
    }
    if (dirty) {
      writeVisitorData(visitors);
    }
  }

  visitorCount = Object.keys(dayVisitors).length;
  if (res) {
    setVisitorCookie(res, deviceId, secure);
  }
  return visitorCount;
}

function handleOnlineVisitors(req, res) {
  // P2: 过期清理已由定时器负责，接口更新当前访客并维护本次在线会话时长
  const { deviceId, visitorId, secure } = getVisitorIdentity(req);
  const now = Date.now();
  let session = ONLINE_VISITORS.get(visitorId);
  const lastSeenMs = (typeof session === 'object' && session) ? session.lastSeen : (session || 0);

  if (!session || (now - lastSeenMs >= ONLINE_VISITOR_TIMEOUT)) {
    session = { sessionStart: now, lastSeen: now };
  } else {
    session.lastSeen = now;
    if (!session.sessionStart) session.sessionStart = now;
  }
  ONLINE_VISITORS.set(visitorId, session);
  setVisitorCookie(res, deviceId, secure);

  // 保证在线访客完成今日登记（兜底根路径可能被离线/客户端强缓存跳过登记的情况）
  try {
    const date = getShanghaiDate();
    const visitors = readVisitorData();
    visitors.days[date] ||= {};
    const dayVisitors = visitors.days[date];
    if (!dayVisitors[visitorId]) {
      getClientVisitor(req, null);
    } else {
      const existing = dayVisitors[visitorId];
      const last = new Date(existing.lastSeen || existing.firstSeen || 0).getTime();
      // 心跳超过 3 分钟或者初次记录时更新持久化活跃时间与本次时长
      if (now - last > 3 * 60 * 1000 || !existing.sessionStart) {
        existing.lastSeen = new Date().toISOString();
        existing.sessionStart = new Date(session.sessionStart).toISOString();
        existing.sessionDuration = Math.max(1, Math.round((now - session.sessionStart) / 1000));
        writeVisitorData(visitors);
      }
    }
  } catch (err) {
    console.warn('Online visitor sync warning:', err.message);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ count: ONLINE_VISITORS.size }));
}

function handleVisitorsList(req, res, url) {
  try {
    const queryDate = url.searchParams.get('date') || getShanghaiDate();
    const visitors = readVisitorData();
    const dayVisitors = (visitors.days && visitors.days[queryDate]) || {};
    const now = Date.now();

    const list = Object.entries(dayVisitors).map(([id, rawItem]) => {
      const item = rawItem || {};
      const userAgent = item.userAgent || '';
      const fallbackInfo = parseClientInfo(userAgent);

      const session = ONLINE_VISITORS.get(id);
      const sessionLastSeen = (typeof session === 'object' && session) ? session.lastSeen : (session || 0);
      const isOnline = ONLINE_VISITORS.has(id) && (now - sessionLastSeen < ONLINE_VISITOR_TIMEOUT);

      let sessionStartMs = 0;
      let onlineDurationSeconds = 0;

      if (isOnline) {
        if (session && session.sessionStart) {
          sessionStartMs = session.sessionStart;
        } else if (item.sessionStart) {
          sessionStartMs = new Date(item.sessionStart).getTime();
        } else {
          sessionStartMs = new Date(item.lastSeen || item.firstSeen || now).getTime();
        }
        onlineDurationSeconds = Math.max(1, Math.round((now - sessionStartMs) / 1000));
      } else {
        if (item.sessionDuration) {
          onlineDurationSeconds = Math.max(1, Number(item.sessionDuration));
        } else if (item.firstSeen && item.lastSeen) {
          const diff = Math.round((new Date(item.lastSeen) - new Date(item.firstSeen)) / 1000);
          onlineDurationSeconds = Math.max(1, diff);
        }
      }

      return {
        id: id.substring(0, 16),
        ip: item.ip || '未知',
        client: item.client || fallbackInfo.client,
        platform: item.platform || fallbackInfo.platform,
        browser: item.browser || fallbackInfo.browser,
        device: item.device || fallbackInfo.device,
        isApp: typeof item.isApp === 'boolean' ? item.isApp : fallbackInfo.isApp,
        firstSeen: item.firstSeen || '',
        lastSeen: item.lastSeen || item.firstSeen || '',
        sessionStart: sessionStartMs ? new Date(sessionStartMs).toISOString() : (item.sessionStart || ''),
        onlineDurationSeconds,
        visitCount: item.visitCount || 1,
        username: item.username || '',
        email: item.email || '',
        userAgent: userAgent,
        isOnline
      };
    });

    list.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return b.isOnline ? 1 : -1;
      return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    });

    const availableDates = Object.keys(visitors.days || {}).sort().reverse();
    if (!availableDates.includes(queryDate)) {
      availableDates.unshift(queryDate);
    }

    const appCount = list.filter(v => v.isApp).length;
    const webCount = list.length - appCount;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      date: queryDate,
      availableDates,
      totalUniqueVisitors: list.length,
      onlineCount: ONLINE_VISITORS.size,
      appCount,
      webCount,
      visitors: list
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
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
    
    const ua = req.headers['user-agent'] || '';
    const isApp = /BearMusicApp|WebIntoApp/i.test(ua);
    const htmlContent = getHTMLContent(startTime, currentVisitorNumber, startDateStr, isApp);
    
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(htmlContent);
  } else if (requestUrl.pathname === '/mc') {
    try {
      getClientVisitor(req, res);
    } catch (error) {
      console.warn('Visitor registration warning on /mc:', error.message);
    }
    const manageHTML = getManageHTMLContent();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(manageHTML);
  } else if (requestUrl.pathname === '/share-link') {
    handleShareLink(req, res, requestUrl);
  } else if (requestUrl.pathname === '/s' || requestUrl.pathname.startsWith('/s/')) {
    handleShareRoute(req, res, requestUrl);
  } else if (requestUrl.pathname === '/cache-update') {
    handleCacheUpdate(req, res);
  } else if (requestUrl.pathname === '/cache-reorder') {
    handleCacheReorder(req, res);
  } else if (requestUrl.pathname === '/cache-batch-delete') {
    handleCacheBatchDelete(req, res);
  } else if (requestUrl.pathname === '/online-visitors') {
    handleOnlineVisitors(req, res);
  } else if (requestUrl.pathname === '/visitors-list') {
    handleVisitorsList(req, res, requestUrl);
  } else if (requestUrl.pathname === '/preload') {
    handlePreload(requestUrl, req, res);
  } else if (requestUrl.pathname === '/yt-audio') {
    handleYouTubeAudio(requestUrl, req, res);
  } else if (requestUrl.pathname === '/media-proxy') {
    handleMediaProxy(requestUrl, req, res);
  } else if (requestUrl.pathname === '/cache-list') {
    handleCacheList(req, res);
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
  } else if (requestUrl.pathname === '/lyrics-delete') {
    handleLyricsDelete(req, res);
  } else if (requestUrl.pathname === '/lyrics-prefer') {
    handleLyricsPrefer(req, res);
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

function getHTMLContent(startTime, visitorCount, startDate, isApp = false) {
  return `<!DOCTYPE html>
<html lang="zh-CN"${isApp ? ' class="is-app"' : ''}>
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
  <script>
    (function() {
      var ua = navigator.userAgent || '';
      var isAppClient = /BearMusicApp|WebIntoApp/i.test(ua) || !!window.AndroidBridge || !!window.Android;
      if (isAppClient) {
        document.documentElement.classList.add('is-app');
      }
    })();
  </script>
  <style>
    /* App 客户端专用纯净播放模式：隐藏 URL 粘贴与本地上传控件，保留纯粹听歌体验 */
    html.is-app #uploadSection,
    body.is-app #uploadSection {
      display: none !important;
    }
    html.is-app #playlist {
      margin-bottom: 0 !important;
    }
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
    .share-btn {
      flex: 0 0 auto !important;
      width: auto !important;
      margin-left: 8px !important;
      padding: 2px 7px !important;
      font-size: 11px !important;
      line-height: 16px !important;
      height: 22px !important;
      color: #667eea !important;
      background: #f0f4ff !important;
      border: 1px solid #c7d2fe !important;
      border-radius: 4px !important;
      cursor: pointer !important;
      white-space: nowrap !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 3px !important;
      transition: all 0.2s ease !important;
    }
    .share-btn:hover {
      background: #667eea !important;
      color: #fff !important;
      border-color: #667eea !important;
      transform: translateY(-1px);
    }
    .share-btn:active {
      transform: translateY(0);
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
    .lyric-btn.is-preferred {
      background: #fef3c7 !important;
      color: #b45309 !important;
      border-color: #f59e0b !important;
      font-weight: 600 !important;
    }
    .lyric-btn.is-preferred:hover {
      background: #fde68a !important;
      color: #92400e !important;
      border-color: #d97706 !important;
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
        <span class="value"><a href="/mc?open=visitors" style="color:inherit; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,0.4);" title="点击前往后台查看详细访客记录">${visitorCount}</a></span>
      </div>
      <div class="info">
        <span class="label">当前在线人数：</span>
        <span class="value"><a href="/mc?open=visitors" style="color:inherit; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,0.4);" title="点击前往后台查看详细访客记录"><span id="onlineVisitors">统计中...</span></a></span>
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
              <button type="button" class="lyric-btn" id="btnLyricPin" onclick="togglePinCurrentLyrics()" title="将当前显示的歌词设为优选歌词（下次优先使用，优先级高于YouTube字幕）" style="display:none;color:#d97706;border-color:#fde68a;">⭐ 优选</button>
              <button type="button" class="lyric-btn" id="btnLyricSearch" onclick="toggleLyricSearch()" title="手动搜索歌词">🔍 搜词</button>
              <button type="button" class="lyric-btn" id="btnOffsetToggle" onclick="toggleOffsetControls()" title="调整歌词时间偏差" style="display:none;">⏱ 校准</button>
              <button type="button" class="lyric-btn" id="btnLyricExpand" onclick="toggleLyricExpand()" title="展开/收起歌词高度">⤢ 展开</button>
              <button type="button" class="lyric-btn" id="btnClearLyrics" onclick="clearCurrentLyrics()" title="清除当前歌曲已缓存的错误歌词" style="display:none;color:#e53e3e;border-color:#fed7d7;">🗑️ 清词</button>
            </div>
          </div>
          <div id="offsetControlsRow" style="display:none;align-items:center;justify-content:center;gap:6px;padding:6px 0;margin-bottom:8px;background:#f0f4f8;border-radius:6px;font-size:11px;flex-wrap:wrap;">
            <span style="color:#64748b;">时间微调:</span>
            <button type="button" class="lyric-btn" onclick="adjustLyricOffset(-0.5)" title="歌词慢了，提前0.5秒">-0.5s 慢了</button>
            <span id="offsetDisplay" style="color:#667eea;font-weight:bold;min-width:32px;text-align:center;">0.0s</span>
            <button type="button" class="lyric-btn" onclick="adjustLyricOffset(0.5)" title="歌词快了，延后0.5秒">+0.5s 快了</button>
            <button type="button" class="lyric-btn" onclick="resetLyricOffset()" title="重置时间偏移">重置</button>
            <button type="button" class="lyric-btn" onclick="manualAppendRepeatLyrics()" title="音频唱了2遍但歌词只有1遍？点击自动复制追加第2遍歌词" style="color:#d97706;border-color:#fde68a;">🔁 追加第2遍</button>
            <button type="button" class="lyric-btn" id="btnSaveOffset" onclick="saveLyricOffsetPermanent()" title="将校准时间永久保存到服务器，下次播放无需重新校准" style="color:#15803d;border-color:#86efac;font-weight:bold;background:#f0fdf4;opacity:0.6;">💾 保存</button>
          </div>
          <div id="lyricSearchRow" style="display:none;align-items:center;gap:6px;margin-bottom:8px;">
            <input type="text" id="manualLyricInput" class="url-input" style="margin-bottom:0;padding:4px 8px;font-size:12px;height:28px;flex:1;" placeholder="输入正确的 歌名 歌手 重新搜索" onkeydown="if(event.key==='Enter' && !event.isComposing)submitManualLyrics()">
            <button type="button" class="lyric-btn" onclick="submitManualLyrics()" style="padding:0 10px;height:28px;background:#667eea;color:#fff;border-color:#667eea;">确定</button>
            <button type="button" class="lyric-btn" onclick="toggleLyricSearch()" style="padding:0 8px;height:28px;">取消</button>
          </div>
          <div class="lyrics-box" id="lyricsBox">
            <div class="lyrics-scroll" id="lyricsScroll">
              <div class="lyrics-tip">播放音乐后自动搜索歌词</div>
            </div>
          </div>
        </div>
        <div id="playlist" style="background:#fff;padding:10px;border-radius:4px;margin-bottom:15px;font-size:13px;color:#555;display:none;">
          <div id="playlistSearchWrap" style="margin-bottom:10px;position:relative;display:flex;align-items:center;">
            <input type="text" id="playlistSearchInput" placeholder="🔍 搜索播放列表歌曲 (歌名/歌手)..." style="width:100%;box-sizing:border-box;padding:7px 28px 7px 12px;font-size:12px;border:1px solid #ddd;border-radius:4px;outline:none;">
            <span id="playlistSearchClear" onclick="clearPlaylistSearch()" style="position:absolute;right:8px;cursor:pointer;color:#999;font-size:14px;display:none;user-select:none;padding:2px 4px;" title="清空搜索">✕</span>
          </div>
          <div id="playlistItems"></div>
          <div id="playlistFooter"></div>
        </div>
        <div id="uploadSection" class="upload-section"${isApp ? ' style="display:none;"' : ''}>
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
    
    function syncAppMode() {
      const ua = navigator.userAgent || '';
      const isAppClient = /BearMusicApp|WebIntoApp/i.test(ua) || !!window.AndroidBridge || !!window.Android;
      if (isAppClient) {
        document.documentElement.classList.add('is-app');
        if (document.body) document.body.classList.add('is-app');
        const uploadSec = document.getElementById('uploadSection');
        if (uploadSec) uploadSec.style.display = 'none';
      }
    }
    syncAppMode();
    window.addEventListener('DOMContentLoaded', syncAppMode);
    
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

    function getFilteredPlaylist() {
      const kw = playlistSearchKeyword;
      return playlistItems.map((item, index) => ({ item, index })).filter(entry => {
        if (!kw) return true;
        const name = (entry.item.name || '').toLowerCase();
        const parts = kw.split(/\s+/).filter(Boolean);
        return parts.every(p => name.includes(p));
      });
    }

    function jumpToPlaylistPageInput(val) {
      const page = parseInt(val, 10);
      if (!isNaN(page)) {
        const filtered = getFilteredPlaylist();
        const totalPages = Math.ceil(filtered.length / playlistPageSize) || 1;
        if (page >= 1 && page <= totalPages) {
          playlistPage = page;
          renderPlaylist();
        }
      }
    }

    let isPlaylistSearchComposing = false;

    function initPlaylistSearchEvents() {
      const input = document.getElementById('playlistSearchInput');
      if (!input || input.__boundEvents) return;
      input.__boundEvents = true;

      input.addEventListener('compositionstart', function() {
        isPlaylistSearchComposing = true;
      });

      input.addEventListener('compositionend', function(e) {
        isPlaylistSearchComposing = false;
        onPlaylistSearch(e.target.value);
      });

      input.addEventListener('input', function(e) {
        if (!isPlaylistSearchComposing) {
          onPlaylistSearch(e.target.value);
        }
      });
    }

    function onPlaylistSearch(val) {
      const kw = (val || '').trim().toLowerCase();
      const clearBtn = document.getElementById('playlistSearchClear');
      if (clearBtn) {
        clearBtn.style.display = (val || '').trim() ? 'inline-block' : 'none';
      }
      if (kw === playlistSearchKeyword) return;
      playlistSearchKeyword = kw;
      playlistPage = 1;
      renderPlaylist();
    }

    function clearPlaylistSearch() {
      const input = document.getElementById('playlistSearchInput');
      if (input) input.value = '';
      const clearBtn = document.getElementById('playlistSearchClear');
      if (clearBtn) clearBtn.style.display = 'none';
      playlistSearchKeyword = '';
      playlistPage = 1;
      renderPlaylist();
      if (input) input.focus();
    }

    function renderPlaylist() {
      playlist.style.display = playlistItems.length ? 'block' : 'none';
      if (!playlistItems.length) {
        const itemsContainer = document.getElementById('playlistItems');
        if (itemsContainer) itemsContainer.innerHTML = '';
        const footerContainer = document.getElementById('playlistFooter');
        if (footerContainer) footerContainer.innerHTML = '';
        return;
      }

      let itemsContainer = document.getElementById('playlistItems');
      let footerContainer = document.getElementById('playlistFooter');
      if (!itemsContainer || !footerContainer) {
        playlist.innerHTML = '<div id="playlistSearchWrap" style="margin-bottom:10px;position:relative;display:flex;align-items:center;">' +
          '<input type="text" id="playlistSearchInput" placeholder="🔍 搜索播放列表歌曲 (歌名/歌手)..." style="width:100%;box-sizing:border-box;padding:7px 28px 7px 12px;font-size:12px;border:1px solid #ddd;border-radius:4px;outline:none;">' +
          '<span id="playlistSearchClear" onclick="clearPlaylistSearch()" style="position:absolute;right:8px;cursor:pointer;color:#999;font-size:14px;display:none;user-select:none;padding:2px 4px;" title="清空搜索">✕</span>' +
          '</div>' +
          '<div id="playlistItems"></div>' +
          '<div id="playlistFooter"></div>';
        itemsContainer = document.getElementById('playlistItems');
        footerContainer = document.getElementById('playlistFooter');
      }

      initPlaylistSearchEvents();

      const filtered = getFilteredPlaylist();

      const totalPages = Math.ceil(filtered.length / playlistPageSize) || 1;
      if (playlistPage > totalPages) playlistPage = totalPages;
      if (playlistPage < 1) playlistPage = 1;

      const startIndex = (playlistPage - 1) * playlistPageSize;
      const endIndex = Math.min(startIndex + playlistPageSize, filtered.length);
      const pageEntries = filtered.slice(startIndex, endIndex);

      const itemsHtml = pageEntries.length ? pageEntries.map(entry => {
        const item = entry.item;
        const index = entry.index;
        const shareBtn = item.key ? '<button type="button" class="share-btn" onclick="shareSong(' + index + ', event)" title="生成24小时免登分享链接">🔗 分享</button>' : '';
        return '<div style="display:flex;align-items:center;padding:5px 0;' + (index === currentIndex ? 'font-weight:bold;color:#667eea;' : '') + '">' +
          '<span style="flex:1;min-width:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" onclick="playItem(' + index + ')" title="点击播放">' + (index + 1) + '. ' + escapeHtml(item.name) + ' <small style="color:#888">[' + (item.cached ? '本地缓存' : item.local ? '本地文件' : 'URL') + ']</small></span>' +
          shareBtn +
          '</div>';
      }).join('') : '<div style="text-align:center;color:#888;padding:12px;font-size:12px;">未在播放列表中找到匹配歌曲</div>';

      let footerHtml = '';
      if (totalPages > 1) {
        let firstRowHtml = '';
        let secondRowHtml = '';
        if (playlistPage === 1) {
          let firstRowHtml = '<div style="display:flex;justify-content:center;align-items:center;">' +
            '<span>共 ' + filtered.length + ' 首 (' + totalPages + ' 页)</span>' +
            '</div>';
          let secondRowHtml = '<div style="display:flex;justify-content:flex-end;align-items:center;">' +
            '<button type="button" onclick="changePlaylistPage(1)" style="padding:3px 10px;border:1px solid #667eea;border-radius:4px;background:#667eea;color:#fff;cursor:pointer;">下一页</button>' +
            '</div>';
          footerHtml = '<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid #eee;font-size:12px;color:#666;">' +
            firstRowHtml +
            secondRowHtml +
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
          let firstRowHtml = '<div style="display:flex;justify-content:center;align-items:center;margin-bottom:2px;">' +
            '<span>共 ' + filtered.length + ' 首 (' + totalPages + ' 页)</span>' +
            '</div>';
          
          let secondRowHtml = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">' +
            '<button type="button" onclick="changePlaylistPage(-1)" ' + (playlistPage === 1 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '') + ' style="padding:3px 10px;border:1px solid #667eea;border-radius:4px;background:#667eea;color:#fff;cursor:pointer;">上一页</button>' +
            '<div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap;">' + pagesListHtml + '</div>' +
            '<button type="button" onclick="changePlaylistPage(1)" ' + (playlistPage === totalPages ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '') + ' style="padding:3px 10px;border:1px solid #667eea;border-radius:4px;background:#667eea;color:#fff;cursor:pointer;">下一页</button>' +
            '</div>';

          footerHtml = '<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid #eee;font-size:12px;color:#666;">' +
            firstRowHtml +
            secondRowHtml +
            '</div>';
        }
      }

      itemsContainer.innerHTML = itemsHtml;
      footerContainer.innerHTML = footerHtml;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\\'':'&#39;','"':'&quot;'}[char]));
    }

    function showToast(message, isError) {
      var toast = document.getElementById('mcToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mcToast';
        toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.9);color:#fff;padding:14px 26px;border-radius:30px;font-size:14px;font-weight:500;z-index:99999;box-shadow:0 12px 36px rgba(0,0,0,0.35);transition:opacity 0.25s ease, transform 0.25s ease;opacity:0;pointer-events:none;max-width:90%;text-align:center;word-break:break-all;line-height:1.4;';
        document.body.appendChild(toast);
      }
      toast.style.background = isError ? 'rgba(220,53,69,0.95)' : 'rgba(40,167,69,0.95)';
      toast.textContent = message;
      void toast.offsetWidth;
      toast.style.opacity = '1';
      toast.style.transform = 'translate(-50%, -50%) scale(1)';
      clearTimeout(toast._timer);
      toast._timer = setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, -50%) scale(0.9)';
      }, 3000);
    }

    function trySyncCopy(text) {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.width = '2em';
        ta.style.height = '2em';
        ta.style.padding = '0';
        ta.style.border = 'none';
        ta.style.outline = 'none';
        ta.style.boxShadow = 'none';
        ta.style.background = 'transparent';
        ta.style.opacity = '0.01';
        ta.style.zIndex = '-9999';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {
        ok = false;
      }
      return ok;
    }

    function copyTextToClipboard(text) {
      // 1. Android App 原生 Bridge 接口 (最高优先级，直接调用底层系统 ClipboardManager，100% 成功写入安卓剪贴板)
      try {
        if (window.AndroidBridge && typeof window.AndroidBridge.copyToClipboard === 'function') {
          if (window.AndroidBridge.copyToClipboard(text)) return Promise.resolve(true);
        }
        if (window.Android && typeof window.Android.copyToClipboard === 'function') {
          if (window.Android.copyToClipboard(text)) return Promise.resolve(true);
        }
      } catch (e) {
        console.warn('AndroidBridge copy error:', e);
      }

      // 2. 在当前点击手势内立即同步尝试 document.execCommand('copy')
      if (trySyncCopy(text)) {
        return Promise.resolve(true);
      }

      // 3. 现代浏览器的 navigator.clipboard API
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(function() {
          return true;
        }).catch(function() {
          return false;
        });
      }

      return Promise.resolve(false);
    }

    function showShareFallbackModal(url) {
      var modal = document.getElementById('shareModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'shareModal';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.backgroundColor = 'rgba(0,0,0,0.65)';
        modal.style.zIndex = '99999';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.padding = '20px';
        modal.style.boxSizing = 'border-box';
        modal.innerHTML = 
          '<div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;box-shadow:0 8px 24px rgba(0,0,0,0.3);text-align:left;position:relative;color:#333;">' +
            '<div style="font-weight:bold;font-size:16px;margin-bottom:8px;color:#1a73e8;">🔗 歌曲分享链接 (24小时有效)</div>' +
            '<div style="font-size:13px;color:#666;margin-bottom:12px;">受当前版本安全限制，请点击下方复制或长按全选：</div>' +
            '<input id="shareModalInput" type="text" readonly style="width:100%;padding:10px;font-size:13px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;background:#f8f9fa;color:#111;margin-bottom:14px;" />' +
            '<div style="display:flex;justify-content:flex-end;gap:10px;">' +
              '<button type="button" id="shareModalClose" style="padding:8px 16px;border:1px solid #ccc;border-radius:6px;background:#f1f3f4;color:#333;font-size:14px;cursor:pointer;">关闭</button>' +
              '<button type="button" id="shareModalCopy" style="padding:8px 16px;border:none;border-radius:6px;background:#28a745;color:#fff;font-size:14px;font-weight:bold;cursor:pointer;">复制链接</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(modal);
        document.getElementById('shareModalClose').onclick = function() {
          modal.style.display = 'none';
        };
        document.getElementById('shareModalCopy').onclick = function() {
          var input = document.getElementById('shareModalInput');
          input.focus();
          input.select();
          input.setSelectionRange(0, input.value.length);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch(e){}
          if (ok) {
            showToast('🔗 已复制分享链接！');
            setTimeout(function() { modal.style.display = 'none'; }, 800);
          } else {
            showToast('请直接长按输入框内容选择复制');
          }
        };
      }
      var input = document.getElementById('shareModalInput');
      input.value = url;
      modal.style.display = 'flex';
      setTimeout(function() {
        input.focus();
        input.select();
        input.setSelectionRange(0, url.length);
      }, 100);
    }

    function shareSong(index, event) {
      if (event) {
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (typeof event.preventDefault === 'function') event.preventDefault();
      }
      var item = playlistItems[index];
      if (!item || !item.key) return;

      function executeCopy(url) {
        copyTextToClipboard(url).then(function(success) {
          if (success) {
            showToast('🔗 已复制分享链接！(24小时内有效)');
          } else {
            showShareFallbackModal(url);
          }
        });
      }

      // 1. 若歌曲对象已有由服务端预先计算或此前获取过的有效分享链接，直接在用户点击手势内同步复制，零延迟且手势必激活
      if (item.shareUrl && item.shareExpires && (item.shareExpires - Date.now() > 3600000)) {
        executeCopy(item.shareUrl);
        return;
      }

      // 2. 否则通过接口向服务端获取最新签名链接并缓存
      var btn = event ? event.currentTarget : null;
      var origText = btn ? btn.textContent : '';
      if (btn) {
        btn.textContent = '⏳';
        btn.disabled = true;
      }
      fetch('/share-link?key=' + encodeURIComponent(item.key))
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (btn) {
            btn.textContent = origText;
            btn.disabled = false;
          }
          if (!data || !data.url) {
            throw new Error(data && data.error ? data.error : '生成分享链接失败');
          }
          item.shareUrl = data.url;
          item.shareExpires = data.expires;
          executeCopy(data.url);
        })
        .catch(function(err) {
          if (btn) {
            btn.textContent = origText;
            btn.disabled = false;
          }
          showToast('❌ 分享失败: ' + err.message, true);
        });
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
      nowPlaying.textContent = '正在播放: ' + (currentIndex + 1) + '. ' + item.name;
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
          if (data.key) {
            item.key = data.key;
            renderPlaylist();
          }
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
              if (data.cached) {
                item.cached = true;
                if (data.key) item.key = data.key;
                renderPlaylist();
                setTimeout(() => { progressWrap.style.display = 'none'; }, 1200);
              }
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
        nowPlaying.textContent = '正在播放: ' + (currentIndex + 1) + '. ' + title;
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
    var currentRawLyrics = null;
    var userLyricOffsets = {};
    try { userLyricOffsets = JSON.parse(localStorage.getItem('bear_lyric_offsets') || '{}'); } catch (e) {}
    var hasAutoAppendedRepeat = false;

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
      var saveBtn = document.getElementById('btnSaveOffset');
      if (saveBtn) {
        if (Math.abs(val) > 0.001) {
          saveBtn.style.opacity = '1';
          saveBtn.style.borderColor = '#16a34a';
          saveBtn.title = '将当前偏差 (' + (val > 0 ? '+' : '') + val.toFixed(1) + 's) 永久保存到服务器，下次播放无需重新校准';
        } else {
          saveBtn.style.opacity = '0.6';
          saveBtn.style.borderColor = '#86efac';
          saveBtn.title = '调整微调时间后点击保存，可永久写入服务器';
        }
      }
    }

    function shiftLrcTimestamps(lrcText, offsetSeconds) {
      if (!offsetSeconds || Math.abs(offsetSeconds) < 0.001) return lrcText;
      var lines = lrcText.split('\\n');
      var timeRe = /\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?\\]/g;
      return lines.map(function(line) {
        var trimmed = line.trim();
        if (/^\\[[a-z]+:.*\\]$/i.test(trimmed)) {
          if (/^\\[offset:\\s*([+-]?\\d+)\\]/i.test(trimmed)) return '';
          return line;
        }
        return line.replace(timeRe, function(match, m, s, msStr) {
          var minutes = parseInt(m, 10);
          var seconds = parseInt(s, 10);
          var ms = 0;
          if (msStr) {
            ms = msStr.length === 1 ? parseInt(msStr, 10) * 100 : (msStr.length === 2 ? parseInt(msStr, 10) * 10 : parseInt(msStr, 10));
          }
          var totalSec = minutes * 60 + seconds + ms / 1000 + offsetSeconds;
          if (totalSec < 0) totalSec = 0;
          var newMin = Math.floor(totalSec / 60);
          var remainSec = totalSec % 60;
          var secInt = Math.floor(remainSec);
          var msPart = Math.round((remainSec - secInt) * 100);
          if (msPart >= 100) {
            msPart = 0;
            secInt += 1;
          }
          var pad = function(n, len) {
            var str = String(n);
            while (str.length < len) str = '0' + str;
            return str;
          };
          return '[' + pad(newMin, 2) + ':' + pad(secInt, 2) + '.' + pad(msPart, 2) + ']';
        });
      }).filter(function(line) { return line !== ''; }).join('\\n');
    }

    function saveLyricOffsetPermanent() {
      var currentItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      if (!currentItem || (!currentItem.key && !currentItem.url)) {
        showToast('当前没有正在播放的歌曲', true);
        return;
      }
      if (!currentRawLyrics) {
        showToast('当前无可用歌词可保存', true);
        return;
      }

      var offset = getCurrentSongOffset();
      if (Math.abs(offset) < 0.001) {
        showToast('当前时间偏差为 0，无需保存');
        return;
      }

      var saveBtn = document.getElementById('btnSaveOffset');
      var origText = saveBtn ? saveBtn.textContent : '';
      if (saveBtn) {
        saveBtn.textContent = '⏳ 保存中...';
        saveBtn.disabled = true;
      }

      var shiftedLrc = shiftLrcTimestamps(currentRawLyrics, offset);

      fetch('/lyrics-prefer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: currentItem.key || '',
          url: currentItem.url || '',
          lyrics: shiftedLrc,
          action: 'set'
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (saveBtn) {
          saveBtn.textContent = origText;
          saveBtn.disabled = false;
        }
        if (data.success) {
          // 1. 更新当前内存中歌词
          currentRawLyrics = shiftedLrc;
          lyricLines = parseLrc(shiftedLrc);

          // 2. 将临时偏移量归零（因为已经永久写进时间戳中了）
          var key = getSongKey();
          if (key) delete userLyricOffsets[key];
          try { localStorage.setItem('bear_lyric_offsets', JSON.stringify(userLyricOffsets)); } catch (e) {}
          updateOffsetDisplay();

          // 3. 更新界面优选状态标识
          var pinBtn = document.getElementById('btnLyricPin');
          if (pinBtn) {
            pinBtn.textContent = '★ 已优选';
            pinBtn.classList.add('is-preferred');
            pinBtn.title = '当前歌词为手动校准/优选歌词（点击可取消优选）';
          }
          var meta = document.getElementById('lyricsMeta');
          if (meta && meta.textContent) {
            meta.textContent = meta.textContent.replace(/\\s*\\[.*?\\]/g, '') + ' [⭐ 已校准保存]';
          }

          // 4. 即时同步当前播放进度
          if (currentPlayer) updateLyricSync(currentPlayer.currentTime);

          showToast('💾 歌词校准已永久保存！下次播放无需重新校准');
        } else {
          showToast('保存校准失败: ' + (data.error || '未知错误'), true);
        }
      })
      .catch(function(err) {
        if (saveBtn) {
          saveBtn.textContent = origText;
          saveBtn.disabled = false;
        }
        showToast('保存网络错误: ' + err.message, true);
      });
    }

    function checkAndAutoAppendRepeatLyrics() {
      if (!currentPlayer || !currentPlayer.duration || !lyricLines.length || !currentRawLyrics) return;
      if (hasAutoAppendedRepeat) return;
      var duration = currentPlayer.duration;
      if (duration < 60 || lyricLines.length < 5) return;

      var lastTime = lyricLines[lyricLines.length - 1].time;
      if (lastTime > duration - 45) return;

      var ratio = duration / lastTime;
      var repeatTimes = 0;
      if (ratio >= 1.65 && ratio <= 2.45) {
        repeatTimes = 2;
      } else if (ratio >= 2.65 && ratio <= 3.45) {
        repeatTimes = 3;
      }

      if (repeatTimes >= 2) {
        appendRepeatLyrics(repeatTimes, true);
      }
    }

    function appendRepeatLyrics(repeatTimes, isAuto) {
      if (!currentRawLyrics || !lyricLines.length) return;
      var duration = (currentPlayer && currentPlayer.duration) || 0;
      var lastTime = lyricLines[lyricLines.length - 1].time;
      var cycle = duration > 0 ? (duration / repeatTimes) : (lastTime + 15);

      var appendedLrc = '';
      for (var r = 1; r < repeatTimes; r++) {
        var shifted = shiftLrcTimestamps(currentRawLyrics, cycle * r);
        if (shifted) appendedLrc += '\\n' + shifted;
      }

      if (!appendedLrc) return;
      var combined = currentRawLyrics + appendedLrc;
      currentRawLyrics = combined;
      lyricLines = parseLrc(combined);
      renderLyricLines(lyricLines);
      hasAutoAppendedRepeat = true;

      var meta = document.getElementById('lyricsMeta');
      if (meta && meta.textContent) {
        meta.textContent = meta.textContent.replace(/\\s*\\[.*?自动补全.*?\\]/g, '') + ' [🔁 自动补全第2遍]';
      }

      var saveBtn = document.getElementById('btnSaveOffset');
      if (saveBtn) {
        saveBtn.style.opacity = '1';
        saveBtn.style.borderColor = '#16a34a';
      }

      if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
      showToast(isAuto ? '🔁 检测到连唱音频，已自动为您补全第二遍歌词！' : '🔁 已成功追加下一遍歌词！点击「💾 保存」可永久生效');
    }

    function manualAppendRepeatLyrics() {
      if (!currentRawLyrics || !lyricLines.length) {
        showToast('当前无可用歌词可追加', true);
        return;
      }
      var duration = (currentPlayer && currentPlayer.duration) || 0;
      var lastTime = lyricLines[lyricLines.length - 1].time;
      var cycle = 0;
      if (currentPlayer && currentPlayer.currentTime > 30 && currentPlayer.currentTime > lastTime - 10) {
        cycle = Math.round((currentPlayer.currentTime - lyricLines[0].time) * 10) / 10;
      } else if (duration > 0 && duration > lastTime * 1.5) {
        cycle = Math.round((duration / 2) * 10) / 10;
      } else {
        cycle = Math.round((lastTime + 15) * 10) / 10;
      }

      var shifted = shiftLrcTimestamps(currentRawLyrics, cycle);
      if (!shifted) {
        showToast('生成下一遍歌词失败', true);
        return;
      }

      var combined = currentRawLyrics + '\\n' + shifted;
      currentRawLyrics = combined;
      lyricLines = parseLrc(combined);
      renderLyricLines(lyricLines);
      hasAutoAppendedRepeat = true;

      var meta = document.getElementById('lyricsMeta');
      if (meta && meta.textContent) {
        meta.textContent = meta.textContent.replace(/\\s*\\[.*?已追加.*?\\]/g, '') + ' [🔁 已追加第2遍]';
      }

      var saveBtn = document.getElementById('btnSaveOffset');
      if (saveBtn) {
        saveBtn.style.opacity = '1';
        saveBtn.style.borderColor = '#16a34a';
      }

      if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
      showToast('🔁 已成功追加第2遍歌词！点击「💾 保存」即可永久存储');
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
      var row = document.getElementById('lyricSearchRow');
      if (row) row.style.display = 'none';
      var btn = document.getElementById('btnLyricSearch');
      if (btn) btn.classList.remove('active');
      fetchLyrics(query, true, true);
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
      if (!hasAutoAppendedRepeat && currentTime > 3) checkAndAutoAppendRepeatLyrics();
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
      hasAutoAppendedRepeat = false;
      lastLyricsTitle = '';
      lyricLines = [];
      currentLyricIdx = -1;
      currentRawLyrics = null;
      var scroll = document.getElementById('lyricsScroll');
      if (scroll) { scroll.innerHTML = '<div class="lyrics-tip">播放音乐后自动搜索歌词</div>'; scroll.style.transform = ''; }
      var meta = document.getElementById('lyricsMeta');
      if (meta) meta.textContent = '';
      var btnOffset = document.getElementById('btnOffsetToggle');
      if (btnOffset) { btnOffset.style.display = 'none'; btnOffset.classList.remove('active'); }
      var btnClear = document.getElementById('btnClearLyrics');
      if (btnClear) btnClear.style.display = 'none';
      var btnPin = document.getElementById('btnLyricPin');
      if (btnPin) { btnPin.style.display = 'none'; btnPin.classList.remove('is-preferred'); btnPin.textContent = '⭐ 优选'; }
      var offsetRow = document.getElementById('offsetControlsRow');
      if (offsetRow) offsetRow.style.display = 'none';
      var searchRow = document.getElementById('lyricSearchRow');
      if (searchRow) searchRow.style.display = 'none';
      var btnSearch = document.getElementById('btnLyricSearch');
      if (btnSearch) btnSearch.classList.remove('active');
      updateOffsetDisplay();
    }

    function fetchLyrics(title, force, manual) {
      if (!title) return;
      hasAutoAppendedRepeat = false;
      var currentItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      var itemKey = (currentItem && currentItem.key) || '';
      var itemUrl = (currentItem && currentItem.url) || '';

      if (!force && title === lastLyricsTitle) return;
      lastLyricsTitle = title;
      lyricLines = [];
      currentLyricIdx = -1;
      currentRawLyrics = null;
      updateOffsetDisplay();
      var scroll = document.getElementById('lyricsScroll');
      var meta = document.getElementById('lyricsMeta');
      var btnOffset = document.getElementById('btnOffsetToggle');
      if (btnOffset) btnOffset.style.display = 'none';
      var btnClear = document.getElementById('btnClearLyrics');
      if (btnClear) btnClear.style.display = 'none';
      var btnPin = document.getElementById('btnLyricPin');
      if (btnPin) { btnPin.style.display = 'none'; btnPin.classList.remove('is-preferred'); btnPin.textContent = '⭐ 优选'; }
      var offsetRow = document.getElementById('offsetControlsRow');
      if (offsetRow) offsetRow.style.display = 'none';
      if (scroll) scroll.innerHTML = '<div class="lyrics-tip">搜索歌词中: ' + escapeHtml(title) + ' ...</div>';
      if (meta) meta.textContent = '';

      var query = 'title=' + encodeURIComponent(title);
      if (itemKey) query += '&key=' + encodeURIComponent(itemKey);
      if (itemUrl) query += '&url=' + encodeURIComponent(itemUrl);
      if (force) query += '&force=1';
      if (manual) query += '&manual=1';

      fetch('/lyrics?' + query)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.lyrics && data.synced) {
            currentRawLyrics = data.lyrics;
            lyricLines = parseLrc(data.lyrics);
            renderLyricLines(lyricLines);
            checkAndAutoAppendRepeatLyrics();
            var sourceNames = {
              'preferred': '⭐ 优选歌词',
              'youtube-subtitles': 'YouTube字幕',
              'local-cache': '本地歌词',
              'kugou': '酷狗/QQ音乐',
              'netease': '网易云音乐',
              'lrclib': 'LRCLIB'
            };
            var isPref = Boolean(data.source === 'preferred' || data.isPreferred);
            var tag = isPref ? ' [⭐ 优选歌词]' : (data.source ? ' [' + (sourceNames[data.source] || data.source) + ']' : '');
            if (meta) meta.textContent = (data.artistName ? data.artistName + ' · ' : '') + (data.trackName || '') + tag;
            if (btnOffset) btnOffset.style.display = 'inline-flex';
            if (btnClear) btnClear.style.display = 'inline-flex';
            if (btnPin) {
              btnPin.style.display = 'inline-flex';
              if (isPref) {
                btnPin.textContent = '★ 已优选';
                btnPin.classList.add('is-preferred');
                btnPin.title = '当前歌词为手动优选歌词（点击可取消优选）';
              } else {
                btnPin.textContent = '⭐ 优选';
                btnPin.classList.remove('is-preferred');
                btnPin.title = '将当前歌词设为优选歌词（优先级最高，下次优先使用）';
              }
            }
            if (currentPlayer) updateLyricSync(currentPlayer.currentTime);
          } else if (data.lyrics) {
            currentRawLyrics = data.lyrics;
            if (scroll) scroll.innerHTML = '<div style="padding:10px;font-size:13px;color:#888;text-align:center;white-space:pre-line;line-height:2;max-height:240px;overflow:auto">' + escapeHtml(data.lyrics.substring(0, 1000)) + '</div>';
            var isPref = Boolean(data.source === 'preferred' || data.isPreferred);
            var tag = isPref ? ' [⭐ 优选歌词]' : '';
            if (meta) meta.textContent = '纯文本歌词' + tag;
            if (btnOffset) btnOffset.style.display = 'none';
            if (btnClear) btnClear.style.display = 'inline-flex';
            if (btnPin) {
              btnPin.style.display = 'inline-flex';
              if (isPref) {
                btnPin.textContent = '★ 已优选';
                btnPin.classList.add('is-preferred');
                btnPin.title = '当前歌词为手动优选歌词（点击可取消优选）';
              } else {
                btnPin.textContent = '⭐ 优选';
                btnPin.classList.remove('is-preferred');
                btnPin.title = '将当前歌词设为优选歌词（优先级最高，下次优先使用）';
              }
            }
          } else {
            currentRawLyrics = null;
            if (scroll) scroll.innerHTML = '<div class="lyrics-tip">未找到歌词，可点击右上角 🔍 搜词尝试手动搜索</div>';
            if (btnOffset) btnOffset.style.display = 'none';
            if (btnClear) btnClear.style.display = 'none';
            if (btnPin) btnPin.style.display = 'none';
          }
        })
        .catch(function() {
          currentRawLyrics = null;
          if (scroll) scroll.innerHTML = '<div class="lyrics-tip">歌词加载失败，请重试</div>';
          if (btnPin) btnPin.style.display = 'none';
        });
    }

    function clearCurrentLyrics() {
      var currentItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      if (!currentItem || !currentItem.key) {
        alert('当前没有可清除歌词的歌曲');
        return;
      }
      if (!confirm('确定清除「' + currentItem.name + '」的已缓存歌词吗？\\n清除后您可以点击「🔍 搜词」手动重新搜索。')) return;

      try {
        for (var storageKey in localStorage) {
          if (storageKey && storageKey.indexOf('bear_manual_lyric_') === 0) {
            localStorage.removeItem(storageKey);
          }
        }
      } catch (e) {}

      fetch('/lyrics-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: currentItem.key })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          showToast('🗑️ 歌词缓存已成功清除！');
          clearLyrics();
          var scroll = document.getElementById('lyricsScroll');
          if (scroll) scroll.innerHTML = '<div class="lyrics-tip">歌词已清除，可点击右上角「🔍 搜词」重新检索</div>';
        } else {
          showToast('清除失败: ' + (data.error || '未知错误'), true);
        }
      })
      .catch(function(err) {
        showToast('清除网络错误: ' + err.message, true);
      });
    }

    function togglePinCurrentLyrics() {
      var currentItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      if (!currentItem || !currentItem.key) {
        showToast('当前没有正在播放的歌曲', true);
        return;
      }
      if (!currentRawLyrics) {
        showToast('当前无可用歌词可设为优选', true);
        return;
      }

      var btn = document.getElementById('btnLyricPin');
      var isPref = btn && btn.classList.contains('is-preferred');

      if (isPref) {
        if (!confirm('当前歌词已是优选歌词。确定要取消优选吗？\\n取消后下次将恢复默认检索规则。')) return;
        fetch('/lyrics-prefer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: currentItem.key, action: 'unset' })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            showToast('已取消优选歌词');
            if (btn) {
              btn.textContent = '⭐ 优选';
              btn.classList.remove('is-preferred');
              btn.title = '将当前歌词设为优选歌词（优先级最高，下次优先使用）';
            }
            var meta = document.getElementById('lyricsMeta');
            if (meta && meta.textContent) {
              meta.textContent = meta.textContent.replace(/\\s*\\[⭐\\s*优选歌词\\]/g, '');
            }
          } else {
            showToast('取消失败: ' + (data.error || '未知错误'), true);
          }
        })
        .catch(function(e) { showToast('操作网络错误: ' + e.message, true); });
      } else {
        fetch('/lyrics-prefer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: currentItem.key,
            lyrics: currentRawLyrics,
            action: 'set'
          })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            showToast('⭐ 已设为优选歌词！下次将优先使用此歌词');
            if (btn) {
              btn.textContent = '★ 已优选';
              btn.classList.add('is-preferred');
              btn.title = '当前歌词为手动优选歌词（点击可取消优选）';
            }
            var meta = document.getElementById('lyricsMeta');
            if (meta && meta.textContent) {
              meta.textContent = meta.textContent.replace(/\\s*\\[.*?\\]/g, '') + ' [⭐ 优选歌词]';
            }
          } else {
            showToast('保存失败: ' + (data.error || '未知错误'), true);
          }
        })
        .catch(function(e) { showToast('保存网络错误: ' + e.message, true); });
      }
    }

    audioPlayer.addEventListener('timeupdate', function() { updateLyricSync(audioPlayer.currentTime); });
    videoPlayer.addEventListener('timeupdate', function() { updateLyricSync(videoPlayer.currentTime); });
    audioPlayer.addEventListener('loadedmetadata', function() { checkAndAutoAppendRepeatLyrics(); });
    videoPlayer.addEventListener('loadedmetadata', function() { checkAndAutoAppendRepeatLyrics(); });

    audioPlayer.addEventListener('ended', playNext);
    videoPlayer.addEventListener('ended', playNext);

    singleRepeatToggle.addEventListener('change', function() {
      if (currentPlayer) currentPlayer.loop = false;
    });

    randomToggle.addEventListener('change', function() {
      if (currentPlayer) currentPlayer.loop = false;
    });


    
    try {
      for (var storageKey in localStorage) {
        if (storageKey && storageKey.indexOf('bear_manual_lyric_') === 0) {
          localStorage.removeItem(storageKey);
        }
      }
    } catch (e) {}

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
    .order-box {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .order-input {
      width: 44px;
      height: 28px;
      padding: 0 4px;
      text-align: center;
      font-size: 13px;
      font-weight: 700;
      color: #2d3748;
      border: 1.5px solid #cbd5e0;
      border-radius: 6px;
      background: #fff;
      outline: none;
      transition: all 0.2s;
      -moz-appearance: textfield;
    }
    .order-input::-webkit-outer-spin-button,
    .order-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .order-input:focus {
      border-color: #667eea;
      background: #f0f4ff;
      color: #5a67d8;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.25);
    }
    .order-btns-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 2px;
    }
    .order-btn {
      background: #edf2f7;
      border: 1px solid #cbd5e0;
      border-radius: 3px;
      font-size: 9px;
      width: 20px;
      height: 13px;
      line-height: 11px;
      cursor: pointer;
      color: #4a5568;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: all 0.15s;
    }
    .order-btn:hover:not(:disabled) {
      background: #667eea;
      color: #fff;
      border-color: #667eea;
    }
    .order-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .song-card.order-highlight {
      animation: highlightPulse 1.8s ease;
    }
    @keyframes highlightPulse {
      0% { background: #eef2ff; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.35); }
      100% { background: #f7fafc; border-color: #e2e8f0; }
    }
    #mcToast {
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(-10px);
      background: rgba(45, 55, 72, 0.95);
      color: #fff;
      padding: 10px 20px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      z-index: 99999;
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);
      transition: all 0.25s ease;
      opacity: 0;
      pointer-events: none;
      max-width: 90%;
      text-align: center;
    }
    #mcToast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
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
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      padding: 16px;
    }
    .modal-content {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      padding: 20px;
      animation: modalFadeIn 0.2s ease-out;
    }
    .visitor-row {
      transition: background 0.15s;
    }
    .visitor-row:hover {
      background: #f7fafc;
    }
    @keyframes modalFadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
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
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary" onclick="openVisitorModal()" style="background: linear-gradient(135deg, #38a169, #2f855a); padding: 8px 14px; font-size: 13px; box-shadow: 0 2px 6px rgba(56, 161, 105, 0.25);">
          👥 用户管理与访客 (<span id="headerVisitorBadge">0</span>)
        </button>
        <a href="/" class="back-btn">◀ 返回播放器</a>
      </div>
    </div>

    <div class="tips-box">
      💡 <strong>播放次序调整</strong>：支持<strong>直接输入数字序号</strong>（按回车或点击外部即刻生效）、<strong>🔝置顶 / 🔚置底</strong>、<strong>▲ / ▼ 上下微调</strong>，还支持勾选多首后点击「🔢 批量调整次序」一键整体移动。<br>
      💡 <strong>歌词匹配推荐格式</strong>：推荐将歌曲标题修改为「<strong>歌名 歌手</strong>」（例如：<code>相思 毛阿敏</code> 或 <code>情没有对错 鱼蛋</code>），点击右侧「✏️ 编辑」按钮即可修改。
    </div>

    <div class="toolbar">
      <input type="text" id="searchKeyword" class="search-input" placeholder="🔍 快速搜索歌名、歌手或格式..." oninput="onFilterChange()">
      <button type="button" class="btn btn-primary" onclick="document.getElementById('mcFileInput').click()">📁 本地上传</button>
      <input type="file" id="mcFileInput" style="display:none;" accept="audio/*,video/*" multiple onchange="mcUploadFiles(event)">
      <button type="button" class="btn btn-secondary" onclick="toggleSelectAll()">全选 / 反选</button>
      <button type="button" id="batchMoveBtn" class="btn btn-secondary" onclick="moveBatchToOrder()" disabled>🔢 批量调整次序 (<span id="batchMoveCount">0</span>)</button>
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

    <div id="statsBar" style="font-size: 12px; color: #718096; margin-bottom: 12px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <div>
        <span>共 <strong id="songCount" style="color: #667eea;">0</strong> 首歌曲</span>
        <span style="margin-left: 12px;">总存储占用：<strong id="diskSize" style="color: #667eea;">0 MB</strong></span>
      </div>
      <div style="display: flex; gap: 14px; align-items: center;">
        <span style="cursor: pointer;" onclick="openVisitorModal()" title="点击查看访客记录">今日独立访客：<strong id="mcTodayVisitors" style="color: #667eea;">0</strong> 位</span>
        <span style="cursor: pointer;" onclick="openVisitorModal()" title="点击查看访客记录">当前在线：<strong id="mcOnlineVisitors" style="color: #38a169;">0</strong> 人</span>
      </div>
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

    function renderSongs(highlightKey) {
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
        const realIndex = songsData.findIndex(s => s.key === song.key);
        const realOrder = realIndex >= 0 ? realIndex + 1 : idx + 1;
        const isFirst = (realIndex === 0);
        const isLast = (realIndex === songsData.length - 1);
        const isHighlighted = (highlightKey && song.key === highlightKey);

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

        return '<div class="song-card ' + (isPlaying ? 'playing' : '') + ' ' + (isHighlighted ? 'order-highlight' : '') + '" id="card_' + song.key + '">' +
          '<input type="checkbox" onchange="toggleSelect(\\'' + song.file + '\\', this.checked)" ' + (isSelected ? 'checked' : '') + ' style="width: 16px; height: 16px; cursor: pointer;">' +
          '<div class="order-box">' +
            '<input type="number" class="order-input" id="orderInput_' + song.key + '" value="' + realOrder + '" min="1" max="' + songsData.length + '" title="直接输入数字序号，回车或失焦即刻调整" onfocus="this.select()" onchange="jumpSongOrder(\\'' + song.key + '\\', this.value)" onkeydown="if(event.key===\\'Enter\\'){this.blur();}">' +
            '<div class="order-btns-grid">' +
              '<button type="button" class="order-btn" title="一键置顶 (第1位)" onclick="jumpSongOrder(\\'' + song.key + '\\', 1)" ' + (isFirst ? 'disabled' : '') + '>🔝</button>' +
              '<button type="button" class="order-btn" title="上移一位" onclick="moveSong(\\'' + song.key + '\\', -1)" ' + (isFirst ? 'disabled' : '') + '>▲</button>' +
              '<button type="button" class="order-btn" title="下移一位" onclick="moveSong(\\'' + song.key + '\\', 1)" ' + (isLast ? 'disabled' : '') + '>▼</button>' +
              '<button type="button" class="order-btn" title="一键置底 (最后一位)" onclick="jumpSongOrder(\\'' + song.key + '\\', ' + songsData.length + ')" ' + (isLast ? 'disabled' : '') + '>🔚</button>' +
            '</div>' +
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
            (!isEditing ? '<button type="button" class="act-btn" onclick="promptSetOrder(\\'' + song.key + '\\')" title="输入数字修改次序">🔢 次序</button>' : '') +
            (!isEditing ? '<button type="button" class="act-btn" onclick="startEdit(\\'' + song.key + '\\')">✏️ 编辑</button>' : '') +
            (!isEditing ? '<button type="button" class="act-btn" onclick="clearSongLyrics(\\'' + song.key + '\\', \\'' + escapeHtml(song.name) + '\\')" title="清除该歌曲已缓存的歌词/字幕">📜 清词</button>' : '') +
            '<button type="button" class="act-btn act-btn-del" onclick="deleteSingle(\\'' + song.file + '\\', \\'' + escapeHtml(song.name) + '\\')">🗑️ 删除</button>' +
          '</div>' +
        '</div>';
      }).join('');

      if (highlightKey) {
        setTimeout(() => {
          const el = document.getElementById('card_' + highlightKey);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 50);
      }
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
      const batchMoveBtn = document.getElementById('batchMoveBtn');
      if (batchMoveBtn) {
        batchMoveBtn.disabled = (count === 0);
        const countSpan = document.getElementById('batchMoveCount');
        if (countSpan) countSpan.textContent = count;
      }
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

    function jumpSongOrder(key, targetOrder) {
      const actualIndex = songsData.findIndex(s => s.key === key);
      if (actualIndex === -1) return;
      const song = songsData[actualIndex];
      let target = parseInt(String(targetOrder).trim(), 10);
      if (isNaN(target)) {
        renderSongs();
        return;
      }
      if (target < 1) target = 1;
      if (target > songsData.length) target = songsData.length;
      const targetIndex = target - 1;
      if (targetIndex === actualIndex) {
        renderSongs();
        return;
      }
      const [item] = songsData.splice(actualIndex, 1);
      songsData.splice(targetIndex, 0, item);
      renderSongs(key);
      syncReorderToServer();
      showToast('✅ 已将【' + (item.name || '歌曲') + '】移至第 ' + target + ' 位');
    }

    function moveSong(key, delta) {
      const actualIndex = songsData.findIndex(s => s.key === key);
      if (actualIndex === -1) return;
      const targetIndex = actualIndex + delta;
      if (targetIndex < 0 || targetIndex >= songsData.length) return;
      const [item] = songsData.splice(actualIndex, 1);
      songsData.splice(targetIndex, 0, item);
      renderSongs(key);
      syncReorderToServer();
      showToast('✅ 已调整为第 ' + (targetIndex + 1) + ' 位');
    }

    function promptSetOrder(key) {
      const actualIndex = songsData.findIndex(s => s.key === key);
      if (actualIndex === -1) return;
      const song = songsData[actualIndex];
      const curOrder = actualIndex + 1;
      const input = prompt('请输入歌曲【' + (song.name || '') + '】的新播放次序：\\n当前序号：' + curOrder + '，有效范围：1 ~ ' + songsData.length, curOrder);
      if (input === null) return;
      const target = parseInt(String(input).trim(), 10);
      if (isNaN(target) || target < 1 || target > songsData.length) {
        showToast('请输入 1 到 ' + songsData.length + ' 之间的有效数字', true);
        return;
      }
      jumpSongOrder(key, target);
    }

    function moveBatchToOrder() {
      const count = selectedSet.size;
      if (!count) {
        showToast('请先勾选需要调整次序的歌曲', true);
        return;
      }
      const input = prompt('选中的 ' + count + ' 首歌曲：\\n请输入要移动到的目标起始序号 (1 ~ ' + songsData.length + ')：', '1');
      if (input === null) return;
      const target = parseInt(String(input).trim(), 10);
      if (isNaN(target) || target < 1 || target > songsData.length) {
        showToast('请输入 1 到 ' + songsData.length + ' 之间的有效数字', true);
        return;
      }

      const selectedItems = [];
      const remainingItems = [];
      songsData.forEach(s => {
        if (selectedSet.has(s.file)) {
          selectedItems.push(s);
        } else {
          remainingItems.push(s);
        }
      });

      let insertIndex = target - 1;
      if (insertIndex > remainingItems.length) insertIndex = remainingItems.length;

      remainingItems.splice(insertIndex, 0, ...selectedItems);
      songsData = remainingItems;

      renderSongs();
      syncReorderToServer();
      showToast('✅ 已将选中的 ' + selectedItems.length + ' 首歌曲批量移至第 ' + target + ' 位');
    }

    function syncReorderToServer() {
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
          showToast('排序保存失败: ' + (data.error || '未知错误'), true);
        }
      })
      .catch(err => {
        console.warn('排序网络错误:', err.message);
        showToast('网络错误，排序未保存', true);
      });
    }

    function showToast(message, isError) {
      let toast = document.getElementById('mcToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mcToast';
        document.body.appendChild(toast);
      }
      toast.style.background = isError ? 'rgba(220, 53, 69, 0.95)' : 'rgba(45, 55, 72, 0.95)';
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    function clearSongLyrics(key, name) {
      if (!confirm('确定清除歌曲【' + name + '】的已缓存歌词/字幕吗？\\n清除后下次播放或手动搜词将重新获取。')) return;
      fetch('/lyrics-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          alert('已成功清除歌曲【' + name + '】的歌词缓存！');
        } else {
          alert('清除失败: ' + (data.error || '未知错误'));
        }
      })
      .catch(function(err) {
        alert('请求失败: ' + err.message);
      });
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
    updateVisitorStats();
    if (window.location.search.includes('open=visitors') || window.location.hash === '#visitors') {
      openVisitorModal();
    }

    function updateVisitorStats() {
      fetch('/visitors-list')
        .then(r => r.json())
        .then(data => {
          if (data && data.success) {
            const count = data.totalUniqueVisitors || 0;
            const online = data.onlineCount || 0;
            const badge = document.getElementById('headerVisitorBadge');
            if (badge) badge.textContent = count;
            const today = document.getElementById('mcTodayVisitors');
            if (today) today.textContent = count;
            const onEl = document.getElementById('mcOnlineVisitors');
            if (onEl) onEl.textContent = online;
          }
        })
        .catch(() => {});
    }

    let visitorModalTimer = null;
    function openVisitorModal(date) {
      const modal = document.getElementById('visitorModal');
      if (modal) {
        modal.style.display = 'flex';
        loadVisitorRecords(date);
        if (visitorModalTimer) clearInterval(visitorModalTimer);
        visitorModalTimer = setInterval(function() {
          if (modal.style.display !== 'none') {
            loadVisitorRecords();
          }
        }, 10000);
      }
    }

    function closeVisitorModal() {
      const modal = document.getElementById('visitorModal');
      if (modal) modal.style.display = 'none';
      if (visitorModalTimer) {
        clearInterval(visitorModalTimer);
        visitorModalTimer = null;
      }
    }

    function formatTimeFriendly(isoStr) {
      if (!isoStr) return '-';
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch {
        return isoStr;
      }
    }

    function formatDurationFriendly(sec) {
      sec = Math.max(0, parseInt(sec, 10) || 0);
      if (sec < 60) return (sec || 1) + ' 秒';
      const mins = Math.floor(sec / 60);
      const remSec = sec % 60;
      if (mins < 60) {
        return remSec ? (mins + ' 分 ' + remSec + ' 秒') : (mins + ' 分钟');
      }
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return remMins ? (hrs + ' 小时 ' + remMins + ' 分') : (hrs + ' 小时');
    }

    function loadVisitorRecords(date) {
      const select = document.getElementById('visitorDateSelect');
      const targetDate = date || (select ? select.value : '');
      const url = targetDate ? ('/visitors-list?date=' + encodeURIComponent(targetDate)) : '/visitors-list';

      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data || !data.success) {
            showToast('获取访客记录失败: ' + (data && data.error || '未知错误'), true);
            return;
          }

          document.getElementById('vmTotalCount').textContent = data.totalUniqueVisitors || 0;
          document.getElementById('vmOnlineCount').textContent = data.onlineCount || 0;
          document.getElementById('vmAppCount').textContent = data.appCount || 0;
          document.getElementById('vmWebCount').textContent = data.webCount || 0;

          const badge = document.getElementById('headerVisitorBadge');
          if (badge) badge.textContent = data.totalUniqueVisitors || 0;
          const today = document.getElementById('mcTodayVisitors');
          if (today) today.textContent = data.totalUniqueVisitors || 0;
          const onEl = document.getElementById('mcOnlineVisitors');
          if (onEl) onEl.textContent = data.onlineCount || 0;

          if (select && data.availableDates) {
            select.innerHTML = data.availableDates.map(function(d) {
              const sel = (d === data.date) ? ' selected' : '';
              const isToday = (d === data.availableDates[0]) ? ' (今日)' : '';
              return '<option value="' + d + '"' + sel + '>' + d + isToday + '</option>';
            }).join('');
          }

          const tbody = document.getElementById('visitorTableBody');
          if (!data.visitors || data.visitors.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="padding: 30px; text-align: center; color: #a0aec0;">暂无访客记录</td></tr>';
            return;
          }

          tbody.innerHTML = data.visitors.map(function(v, idx) {
            const onlineBadge = v.isOnline
              ? '<span style="display:inline-flex; align-items:center; gap:4px; color:#2f855a; font-weight:600;"><span style="width:8px; height:8px; background:#48bb78; border-radius:50%; display:inline-block;"></span>在线</span>'
              : '<span style="color:#a0aec0;">⚪ 离线</span>';

            let onlineDurationCol = '';
            if (v.isOnline) {
              onlineDurationCol = '<div style="display:inline-flex; align-items:center; gap:4px; color:#22543d; background:#f0fff4; border:1px solid #c6f6d5; padding:3px 8px; border-radius:12px; font-weight:600; font-size:11px;" title="当前持续在线中">' +
                '<span style="width:6px; height:6px; background:#38a169; border-radius:50%; display:inline-block;"></span>' +
                formatDurationFriendly(v.onlineDurationSeconds) +
                '</div>';
            } else {
              onlineDurationCol = '<span style="color:#718096; font-size:11px;" title="本次/最近一次在线时长">' +
                (v.onlineDurationSeconds ? ('上次 ' + formatDurationFriendly(v.onlineDurationSeconds)) : '-') +
                '</span>';
            }

            const clientTag = v.isApp
              ? '<span style="background:linear-gradient(135deg, #667eea, #764ba2); color:#fff; border-radius:4px; padding:2px 6px; font-size:11px; font-weight:600;">🐻 熊宝宝App</span>'
              : '<span style="background:#edf2f7; color:#4a5568; border-radius:4px; padding:2px 6px; font-size:11px;">🌐 网页端</span>';

            let loginUser = '<span style="color:#a0aec0;">未登录访客</span>';
            if (v.username) {
              loginUser = '<strong>' + escapeHtml(v.username) + '</strong>' + (v.email ? '<br><small style="color:#718096">' + escapeHtml(v.email) + '</small>' : '');
            } else if (v.isApp) {
              loginUser = '<span style="color:#38a169; font-weight:600; font-size:11px; background:#f0fff4; padding:2px 6px; border-radius:4px; border:1px solid #c6f6d5;">⚡ App免登秒进</span>';
            }

            const firstSeenStr = formatTimeFriendly(v.firstSeen);
            const lastSeenStr = formatTimeFriendly(v.lastSeen);
            const timeCol = (firstSeenStr === lastSeenStr) ? firstSeenStr : ('首次: ' + firstSeenStr + '<br>最近: <strong>' + lastSeenStr + '</strong>');

            return '<tr class="visitor-row" style="border-bottom: 1px solid #f0f2f5;">' +
              '<td style="padding: 8px;">' + onlineBadge + '</td>' +
              '<td style="padding: 8px;">' + onlineDurationCol + '</td>' +
              '<td style="padding: 8px; font-family: monospace; font-size: 12px; color: #2d3748;"><strong>' + escapeHtml(v.ip) + '</strong></td>' +
              '<td style="padding: 8px;">' +
                '<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
                  clientTag +
                  '<span style="color: #2d3748; font-weight: 500;">' + escapeHtml(v.client) + '</span>' +
                '</div>' +
                '<div style="margin-top: 3px;">' +
                  '<a href="javascript:void(0)" class="ua-toggle-btn" data-target="ua_' + idx + '" style="font-size: 11px; color: #718096; text-decoration: none;">🔍 UA明细</a>' +
                  '<div id="ua_' + idx + '" style="display:none; font-size:10px; color:#718096; word-break:break-all; background:#edf2f7; padding:4px 6px; border-radius:4px; margin-top:4px;">' + escapeHtml(v.userAgent || '无') + '</div>' +
                '</div>' +
              '</td>' +
              '<td style="padding: 8px; color: #4a5568;">' +
                escapeHtml(v.platform || '-') + '<br>' +
                '<small style="color: #718096;">' + escapeHtml(v.device || '-') + '</small>' +
              '</td>' +
              '<td style="padding: 8px;">' + loginUser + '</td>' +
              '<td style="padding: 8px; font-size: 11px; color: #4a5568;">' + timeCol + '</td>' +
              '<td style="padding: 8px; text-align: center; font-weight: 600; color: #667eea;">' + (v.visitCount || 1) + '</td>' +
            '</tr>';
          }).join('');
        })
        .catch(function(err) {
          showToast('加载失败: ' + err.message, true);
        });
    }

    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest && e.target.closest('.ua-toggle-btn');
      if (btn) {
        const targetId = btn.getAttribute('data-target');
        const el = document.getElementById(targetId);
        if (el) el.style.display = (el.style.display === 'none') ? 'block' : 'none';
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeVisitorModal();
    });
  </script>

  <!-- 访客记录与客户端登记弹层 -->
  <div id="visitorModal" class="modal-overlay" style="display:none;" onclick="if(event.target===this)closeVisitorModal()">
    <div class="modal-content" style="max-width: 980px; width: 95%; max-height: 90vh; display: flex; flex-direction: column;">
      <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <h2 style="margin: 0; font-size: 18px; color: #2d3748;">👥 用户管理与访客记录</h2>
          <select id="visitorDateSelect" onchange="loadVisitorRecords(this.value)" style="padding: 4px 10px; border-radius: 6px; border: 1.5px solid #cbd5e0; font-size: 13px; font-weight: 600; color: #4a5568; outline: none; background: #fff; cursor: pointer;"></select>
          <button type="button" class="btn btn-secondary" onclick="loadVisitorRecords()" style="padding: 4px 10px; font-size: 12px;" title="刷新访客数据与实时在线时长">🔄 刷新</button>
        </div>
        <button type="button" class="btn btn-secondary" onclick="closeVisitorModal()" style="padding: 4px 10px; font-size: 16px; line-height: 1;">✕</button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px;">
        <div style="background: #ebf8ff; border: 1px solid #bee3f8; border-radius: 8px; padding: 10px; text-align: center;">
          <div style="font-size: 11px; color: #2b6cb0; margin-bottom: 4px; font-weight: 500;">今日独立访客</div>
          <div id="vmTotalCount" style="font-size: 22px; font-weight: bold; color: #2b6cb0;">0</div>
        </div>
        <div style="background: #f0fff4; border: 1px solid #c6f6d5; border-radius: 8px; padding: 10px; text-align: center;">
          <div style="font-size: 11px; color: #276749; margin-bottom: 4px; font-weight: 500;">当前实时在线</div>
          <div id="vmOnlineCount" style="font-size: 22px; font-weight: bold; color: #276749;">0</div>
        </div>
        <div style="background: #faf5ff; border: 1px solid #e9d8fd; border-radius: 8px; padding: 10px; text-align: center;">
          <div style="font-size: 11px; color: #6b46c1; margin-bottom: 4px; font-weight: 500;">🐻 App客户端</div>
          <div id="vmAppCount" style="font-size: 22px; font-weight: bold; color: #6b46c1;">0</div>
        </div>
        <div style="background: #edf2f7; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center;">
          <div style="font-size: 11px; color: #4a5568; margin-bottom: 4px; font-weight: 500;">🌐 网页端访客</div>
          <div id="vmWebCount" style="font-size: 22px; font-weight: bold; color: #4a5568;">0</div>
        </div>
      </div>

      <div style="flex: 1; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
          <thead style="background: #f7fafc; position: sticky; top: 0; z-index: 10; border-bottom: 1.5px solid #e2e8f0;">
            <tr>
              <th style="padding: 10px 8px; width: 65px;">状态</th>
              <th style="padding: 10px 8px; width: 115px;">本次在线多久</th>
              <th style="padding: 10px 8px; width: 130px;">IP 地址</th>
              <th style="padding: 10px 8px;">客户端标识</th>
              <th style="padding: 10px 8px; width: 120px;">平台 / 设备</th>
              <th style="padding: 10px 8px; width: 130px;">身份认证</th>
              <th style="padding: 10px 8px; width: 135px;">首次/最近活跃</th>
              <th style="padding: 10px 8px; width: 50px; text-align: center;">频次</th>
            </tr>
          </thead>
          <tbody id="visitorTableBody">
            <tr>
              <td colspan="8" style="padding: 30px; text-align: center; color: #a0aec0;">⏳ 加载访客数据中...</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid #e2e8f0; flex-wrap: wrap; gap: 8px;">
        <span style="font-size: 12px; color: #718096;">提示：App 客户端点开秒进，每次打开与心跳均自动登记最新 IP 与客户端标识。</span>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary" onclick="loadVisitorRecords()">🔄 刷新数据</button>
          <button type="button" class="btn btn-primary" onclick="closeVisitorModal()">关闭</button>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

let metadataWriteQueue = Promise.resolve();

function readCacheMetadata() {
  // P1: 内存缓存，5秒 TTL，写入时立即清除缓存，避免每次请求都读磁盘
  const now = Date.now();
  if (_metadataCache && (now - _metadataCacheTime) < METADATA_CACHE_TTL) {
    return _metadataCache;
  }
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_META, 'utf8'));
    _metadataCache = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    _metadataCacheTime = now;
    return _metadataCache;
  } catch {
    _metadataCache = {};
    _metadataCacheTime = now;
    return _metadataCache;
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
    _metadataCache = null; // P1: 写入后立即清除内存缓存
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
    _metadataCache = null; // P1: 写入后立即清除内存缓存
  });
  return metadataWriteQueue;
}

const FILE_SIZE_CACHE = new Map();
function getCachedFileSize(filePath, file) {
  if (FILE_SIZE_CACHE.has(file)) return FILE_SIZE_CACHE.get(file);
  try {
    const size = fs.statSync(filePath).size;
    FILE_SIZE_CACHE.set(file, size);
    return size;
  } catch (e) {
    return 0;
  }
}

function handleCacheList(req, res) {
  if (!res) {
    res = req;
    req = null;
  }
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
      _metadataCache = null; // P1: 写入后清除内存缓存
    });
  }
  const baseUrl = req ? getShareBaseUrl(req) : (process.env.SHARE_BASE_URL || 'https://mc.azhuan.ren').replace(/\/+$/, '');
  const now = Date.now();
  const shareExpires = now + 24 * 60 * 60 * 1000;
  const items = files.map(file => {
    const key = file.replace(/\.[^.]+$/, '');
    const item = normalized[file] || normalized[key] || {};
    const isVideo = /\.(mp4|webm|mov)$/i.test(file);
    const filePath = path.join(CACHE_DIR, file);
    const size = getCachedFileSize(filePath, file);
    const shortKey = key.slice(0, 10);
    const sign = signShare(shortKey, shareExpires);
    const shareUrl = `${baseUrl}/s/${shortKey}?t=${shareExpires}&s=${sign}`;
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
      local: Boolean(item.local),
      shareUrl: shareUrl,
      shareExpires: shareExpires
    };
  }).sort((a, b) => a.order - b.order);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(items));
}

function handleCacheMetadata(req, res) {
  let body = '';
  let bodySize = 0;
  const MAX_BODY = 4096; // S4
  req.on('data', chunk => { bodySize += chunk.length; if (bodySize > MAX_BODY) { req.destroy(); return; } body += chunk; });
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
  let totalUploaded = 0;
  const MAX_UPLOAD_SIZE = 300 * 1024 * 1024; // 300MB

  req.on('data', chunk => {
    totalUploaded += chunk.length;
    if (totalUploaded > MAX_UPLOAD_SIZE) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '上传文件超过限制 (最大 300MB)' }));
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
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
  let bodySize = 0;
  const MAX_BODY = 4096; // S4
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const file = path.basename(data.file || '');
      if (!/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file)) throw new Error('invalid cache file');
      const key = file.replace(/\.[^.]+$/, '');
      const target = path.join(CACHE_DIR, file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      FILE_SIZE_CACHE.delete(file);
      // S2: 清理所有格式的歌词文件（.lrc .ytb.lrc .kugou.lrc .netease.lrc .lrclib.lrc .nosub 等）
      try {
        fs.readdirSync(CACHE_DIR).forEach(cf => {
          if (cf.startsWith(key) && (cf.endsWith('.lrc') || cf.endsWith('.nosub'))) {
            try { fs.unlinkSync(path.join(CACHE_DIR, cf)); } catch (e) {}
          }
        });
      } catch (e) {}
      deleteCacheMetadataEntry(key).then(() => {
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
  let bodySize = 0;
  const MAX_BODY = 4096; // S4
  req.on('data', chunk => { bodySize += chunk.length; if (bodySize > MAX_BODY) { req.destroy(); return; } body += chunk; });
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
        _metadataCache = null; // P1
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
  let bodySize = 0;
  const MAX_BODY = 131072; // S4: 最大 128KB
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
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
        _metadataCache = null; // P1
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
  let bodySize = 0;
  const MAX_BODY = 131072; // S4: 最大 128KB
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) throw new Error('请选择要删除的文件');
      metadataWriteQueue = metadataWriteQueue.then(() => {
        const metadata = readCacheMetadata();
        // S2: 批量删歌时扫描所有相关文件（音频、所有平台歌词、nosub）
        const allCacheFiles = fs.readdirSync(CACHE_DIR);
        files.forEach(f => {
          const file = path.basename(String(f));
          if (/^[a-f0-9]{64}\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/.test(file)) {
            const target = path.join(CACHE_DIR, file);
            if (fs.existsSync(target)) {
              try { fs.unlinkSync(target); } catch (e) {}
            }
            FILE_SIZE_CACHE.delete(file);
            const key = file.replace(/\.[^.]+$/, '');
            delete metadata[key];
            // 清理所有格式的歌词文件和标记文件
            allCacheFiles.forEach(cf => {
              if (cf.startsWith(key) && (cf.endsWith('.lrc') || cf.endsWith('.nosub'))) {
                try { fs.unlinkSync(path.join(CACHE_DIR, cf)); } catch (e) {}
              }
            });
          }
        });
        const normalized = normalizeMetadataOrder(metadata);
        const temp = CACHE_META + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n');
        fs.renameSync(temp, CACHE_META);
        _metadataCache = null; // P1
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
    res.end(JSON.stringify({ cached: true, percent: 100, key }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(progress));
}
async function handleGetAudioUrl(req, res) {
  let body = '';
  let bodySize = 0;
  const MAX_BODY = 4096; // S4: 限制请求体最大 4KB
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const inputUrl = cleanYouTubeUrl(data.url);
      const format = getYouTubeFormat(data.format);
      if (!validateYouTubeUrl(inputUrl) || !format) throw new Error('Invalid YouTube URL or format');
      let title = '';
      try {
        const ytArgs = [
          '--socket-timeout', '35',
          '--no-warnings',
          '--no-playlist',
          '--extractor-args', 'youtube:player_client=android,web',
          '--print', '%(title)s',
          '--skip-download'
        ];
        const cookiesPath = getYouTubeCookiesPath();
        if (cookiesPath) ytArgs.unshift('--cookies', cookiesPath);
        const curProxy = getYouTubeProxy();
        if (curProxy) ytArgs.unshift('--proxy', curProxy);
        ytArgs.push(inputUrl);
        const { stdout } = await execFileAsync('yt-dlp', ytArgs, { timeout: 70000 });
        title = stdout.trim().split('\n').filter(Boolean).pop() || '';
      } catch (e) {
        console.warn('Title lookup failed; metadata will be saved after a successful title lookup:', e.message);
      }
      const key = getYouTubeCacheKey(inputUrl, format);
      if (title) { // S1: 修复原来用了未定义的 finalTitle，改为 title
        writeCacheMetadataEntry(key, { url: inputUrl, title });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, title, key }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message.substring(0, 200) }));
    }
  });
}


async function handleMediaProxy(url, req, res) {
  const target = url.searchParams.get('url');
  // S3: URL 校验包裹 try/catch，防止非法 URL 抛异常
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!target || !/^https?:$/.test(targetUrl.protocol)) throw new Error('invalid protocol');
  } catch {
    res.writeHead(400);
    res.end('Invalid media URL');
    return;
  }
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
    const targetUrl = cleanYouTubeUrl(inputUrl);
    const tempPath = format === 'mp4' ? cachePath + '.download.mp4' : cachePath + '.part';
    try { fs.unlinkSync(tempPath); } catch {}
    const { spawn } = require('child_process');
    const cookiesPath = getYouTubeCookiesPath();
    const curProxy = getYouTubeProxy();
    let attempts = 0;
    const run = () => {
      attempts++;
      DOWNLOAD_PROGRESS.set(key, { status: 'loading', percent: 0, attempt: attempts });

      const ytArgs = ['--socket-timeout', '35', '--no-warnings', '--no-playlist', '--newline'];
      const useCookies = Boolean(cookiesPath && attempts === 1);
      if (useCookies && cookiesPath) ytArgs.unshift('--cookies', cookiesPath);
      if (curProxy) ytArgs.unshift('--proxy', curProxy);

      if (attempts === 1) {
        ytArgs.push('--extractor-args', 'youtube:player_client=android,web');
        if (format === 'mp4') {
          ytArgs.push('--concurrent-fragments', '4', '-f', 'bv[height<=720]+ba/bv+ba', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', tempPath, targetUrl);
        } else {
          ytArgs.push('-f', 'ba[ext=m4a]/ba[ext=webm]/bestaudio/best', '-o', '-', targetUrl);
        }
      } else if (attempts === 2) {
        // 第 2 次尝试：不带 cookies（防止 cookie 过期导致 403），强制使用 android 客户端与 m4a 音轨
        ytArgs.push('--extractor-args', 'youtube:player_client=android');
        if (format === 'mp4') {
          ytArgs.push('-f', 'bv[height<=720]+ba/best', '--merge-output-format', 'mp4', '-o', tempPath, targetUrl);
        } else {
          ytArgs.push('-f', 'ba[ext=m4a]/bestaudio/best', '-o', '-', targetUrl);
        }
      } else {
        // 第 3 次尝试：混合客户端与最佳可用流
        ytArgs.push('--extractor-args', 'youtube:player_client=android_creator,android,web');
        if (format === 'mp4') {
          ytArgs.push('-f', 'best', '-o', tempPath, targetUrl);
        } else {
          ytArgs.push('-f', 'bestaudio/best', '-o', '-', targetUrl);
        }
      }

      console.log(`[cache] ${format.toUpperCase()} download started (key=${key.slice(0, 12)}, attempt=${attempts}/3${useCookies ? ', cookies=yes' : ''})`);
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
            writeCacheMetadataEntry(key, { url: targetUrl }).then(() => {
              DOWNLOAD_PROGRESS.set(key, { status: 'complete', percent: 100 });
              console.log(`[cache] ${format.toUpperCase()} download completed (key=${key.slice(0, 12)}, size=${fs.statSync(cachePath).size} bytes)`);
              fetchYouTubeSubtitles(targetUrl, key).catch(err => {
                console.warn(`[lyrics] Subtitle auto-fetch notice for ${key.slice(0, 10)}:`, err.message);
              });
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
  const rawInputUrl = url.searchParams.get('url') || '';
  const inputUrl = cleanYouTubeUrl(rawInputUrl);
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
  const rawInputUrl = url.searchParams.get('url') || '';
  const inputUrl = cleanYouTubeUrl(rawInputUrl);
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

// ==================== YouTube 字幕提取与本地歌词持久化 ====================

function convertVttOrSrtToLrc(content) {
  if (!content) return '';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\s*\n/);
  const lrcList = [];
  const timeRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{2,3})\s*-->\s*(?:(?:\d{1,2}):)?(?:\d{2}):(?:\d{2})[.,](?:\d{2,3})/;

  let lastCombinedText = '';

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (!lines.length) continue;

    let timeMatch = null;
    let textLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('WEBVTT') || trimmed.startsWith('Kind:') || trimmed.startsWith('Language:') || trimmed.startsWith('NOTE') || /^\d+$/.test(trimmed)) {
        continue;
      }
      const m = trimmed.match(timeRegex);
      if (m) {
        timeMatch = m;
      } else if (timeMatch) {
        const clean = trimmed
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (clean) textLines.push(clean);
      }
    }

    if (timeMatch && textLines.length > 0) {
      const h = parseInt(timeMatch[1] || '0', 10);
      const m = parseInt(timeMatch[2], 10) + h * 60;
      const s = parseInt(timeMatch[3], 10);
      const ms = timeMatch[4].padEnd(3, '0').slice(0, 2);
      const mmStr = String(m).padStart(2, '0');
      const ssStr = String(s).padStart(2, '0');
      const timestamp = `[${mmStr}:${ssStr}.${ms}]`;

      const combinedText = textLines.join(' ');
      if (combinedText !== lastCombinedText) {
        lrcList.push(`${timestamp}${combinedText}`);
        lastCombinedText = combinedText;
      }
    }
  }

  return lrcList.join('\n');
}

function getLocalLrcInfo(key, preferredSource = null) {
  if (!key) return null;
  let fullKey = key;
  if (key.length < 64) {
    const metadata = readCacheMetadata();
    const matched = Object.keys(metadata).find(k => k.startsWith(key));
    if (matched) {
      fullKey = matched;
    } else {
      try {
        const files = fs.readdirSync(CACHE_DIR);
        const f = files.find(x => x.startsWith(key) && /\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(x));
        if (f) fullKey = f.replace(/\.[^.]+$/, '');
      } catch {}
    }
  }

  // 1. 如果指定了首选来源（例如 'pref' 或 'ytb'）
  if (preferredSource) {
    const p = path.join(CACHE_DIR, `${fullKey}.${preferredSource}.lrc`);
    if (fs.existsSync(p)) {
      try {
        const c = fs.readFileSync(p, 'utf8').trim();
        if (c) {
          let srcName = preferredSource;
          if (preferredSource === 'pref') srcName = 'preferred';
          else if (preferredSource === 'ytb') srcName = 'youtube-subtitles';
          return { lyrics: c, source: srcName, isPreferred: preferredSource === 'pref' };
        }
      } catch {}
    }
    // 兼容检查旧版单个 .lrc 文件如果是 ytb 来源
    if (preferredSource === 'ytb') {
      const legacyPath = path.join(CACHE_DIR, `${fullKey}.lrc`);
      if (fs.existsSync(legacyPath)) {
        try {
          const c = fs.readFileSync(legacyPath, 'utf8').trim();
          if (c && c.includes('[source:youtube-subtitles]')) {
            return { lyrics: c, source: 'youtube-subtitles' };
          }
        } catch {}
      }
    }
    return null;
  }

  // 2. 严格按优先级检查本地文件: pref (用户手动优选最高) -> ytb (YouTube原生字幕) -> kugou -> netease -> lrclib
  const candidateSources = ['pref', 'ytb', 'kugou', 'netease', 'lrclib'];
  for (const src of candidateSources) {
    const p = path.join(CACHE_DIR, `${fullKey}.${src}.lrc`);
    if (fs.existsSync(p)) {
      try {
        const c = fs.readFileSync(p, 'utf8').trim();
        if (c) {
          let srcName = src;
          if (src === 'pref') srcName = 'preferred';
          else if (src === 'ytb') srcName = 'youtube-subtitles';
          return { lyrics: c, source: srcName, isPreferred: src === 'pref' };
        }
      } catch {}
    }
  }

  // 3. 兼容检查旧版单个 .lrc 文件
  const legacyPath = path.join(CACHE_DIR, `${fullKey}.lrc`);
  if (fs.existsSync(legacyPath)) {
    try {
      const c = fs.readFileSync(legacyPath, 'utf8').trim();
      if (c) {
        const src = c.includes('[source:youtube-subtitles]') ? 'youtube-subtitles' : 'local-cache';
        return { lyrics: c, source: src };
      }
    } catch {}
  }

  return null;
}

function getLocalLrcContent(key) {
  const info = getLocalLrcInfo(key);
  return info ? info.lyrics : null;
}

function getYouTubeUrlByKey(key) {
  if (!key) return null;
  const metadata = readCacheMetadata();
  if (metadata[key] && metadata[key].url && validateYouTubeUrl(metadata[key].url)) {
    return metadata[key].url;
  }
  const fullKey = Object.keys(metadata).find(k => k.startsWith(key));
  if (fullKey && metadata[fullKey] && metadata[fullKey].url && validateYouTubeUrl(metadata[fullKey].url)) {
    return metadata[fullKey].url;
  }
  return null;
}

function hasNoSubMarker(key) {
  if (!key) return false;
  const noSubFile = path.join(CACHE_DIR, `${key}.nosub`);
  if (fs.existsSync(noSubFile)) return true;
  if (key.length >= 8 && key.length < 64) {
    try {
      const files = fs.readdirSync(CACHE_DIR);
      if (files.some(f => f.startsWith(key) && f.endsWith('.nosub'))) return true;
    } catch {}
  }
  return false;
}

function saveLocalLrcContent(key, lyrics, source = 'ytb', inputUrl = null) {
  if (!key || !lyrics) return;
  let fullKey = key;
  if (key.length < 64) {
    const metadata = readCacheMetadata();
    const matched = Object.keys(metadata).find(k => k.startsWith(key));
    if (matched) fullKey = matched;
  }

  // 区分不同平台后缀：.pref.lrc, .ytb.lrc, .kugou.lrc, .netease.lrc, .lrclib.lrc
  let extSuffix = 'ytb';
  if (source === 'preferred' || source === 'pref') extSuffix = 'pref';
  else if (source === 'youtube-subtitles' || source === 'ytb') extSuffix = 'ytb';
  else if (source === 'kugou') extSuffix = 'kugou';
  else if (source === 'netease') extSuffix = 'netease';
  else if (source === 'lrclib') extSuffix = 'lrclib';
  else extSuffix = String(source || 'lrc').replace(/[^a-z0-9_-]/gi, '');

  const targetLrc = path.join(CACHE_DIR, `${fullKey}.${extSuffix}.lrc`);
  try {
    fs.writeFileSync(targetLrc, lyrics, 'utf8');
    // 如果是优选歌词或 YouTube 原生字幕，同时写一份到 <key>.lrc 作为基准，防止被国内平台覆盖
    if (extSuffix === 'pref' || extSuffix === 'ytb') {
      try { fs.writeFileSync(path.join(CACHE_DIR, `${fullKey}.lrc`), lyrics, 'utf8'); } catch {}
    }
  } catch (e) {
    console.warn(`[lyrics] Failed to write .${extSuffix}.lrc file:`, e.message);
  }

  const noSubFile = path.join(CACHE_DIR, `${fullKey}.nosub`);
  if (fs.existsSync(noSubFile)) {
    try { fs.unlinkSync(noSubFile); } catch {}
  }

  const ytUrl = (inputUrl && validateYouTubeUrl(inputUrl)) ? inputUrl : getYouTubeUrlByKey(fullKey);
  if (ytUrl) {
    const mp3Key = getYouTubeCacheKey(ytUrl, 'mp3');
    const mp4Key = getYouTubeCacheKey(ytUrl, 'mp4');
    [mp3Key, mp4Key].forEach(k => {
      if (k && k !== fullKey) {
        try {
          fs.writeFileSync(path.join(CACHE_DIR, `${k}.${extSuffix}.lrc`), lyrics, 'utf8');
          if (extSuffix === 'pref' || extSuffix === 'ytb') {
            fs.writeFileSync(path.join(CACHE_DIR, `${k}.lrc`), lyrics, 'utf8');
          }
        } catch {}
        const nosub = path.join(CACHE_DIR, `${k}.nosub`);
        if (fs.existsSync(nosub)) try { fs.unlinkSync(nosub); } catch {}
      }
    });
  }
}

function containsChinese(text) {
  if (!text || typeof text !== 'string') return false;
  return /[\u4e00-\u9fa5]/.test(text);
}

async function translateLrcToChinese(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return lrcText;
  const lines = lrcText.split('\n');
  const lineItems = [];
  const textsToTranslate = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const match = rawLine.match(/^(\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])(.*)$/);
    if (match) {
      const tag = match[1];
      const text = match[2].trim();
      lineItems.push({ isLyric: true, tag, text, raw: rawLine });
      if (text && !containsChinese(text)) {
        textsToTranslate.push({ index: lineItems.length - 1, text });
      }
    } else {
      lineItems.push({ isLyric: false, raw: rawLine });
    }
  }

  if (textsToTranslate.length === 0) return lrcText;

  const CHUNK_SIZE = 25;
  for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
    const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
    const combined = chunk.map(item => item.text).join('\n');
    try {
      const trRes = await fetchJson(
        'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(combined) + '&langpair=autodetect|zh-CN',
        6000
      );
      if (trRes && trRes.responseData && trRes.responseData.translatedText) {
        const translatedParts = trRes.responseData.translatedText.split('\n');
        for (let j = 0; j < chunk.length; j++) {
          if (translatedParts[j] && translatedParts[j].trim()) {
            lineItems[chunk[j].index].text = translatedParts[j].trim();
          }
        }
      }
    } catch (e) {
      console.warn('[lyrics] translate chunk notice:', e.message);
    }
  }

  return lineItems.map(item => item.isLyric ? `${item.tag}${item.text}` : item.raw).join('\n');
}

async function ensureChineseLyrics(lrcText, rawTitle, key, targetYtUrl) {
  if (lrcText && containsChinese(lrcText)) return lrcText;

  let cleanTitle = '';
  if (rawTitle) {
    cleanTitle = cleanSongTitle(rawTitle) || rawTitle;
  } else if (key) {
    const metadata = readCacheMetadata();
    const item = metadata[key] || (key.length < 64 && Object.values(metadata).find(m => m.key && m.key.startsWith(key)));
    if (item && item.title) {
      cleanTitle = cleanSongTitle(item.title) || item.title;
    }
  }

  if (cleanTitle && !cleanTitle.startsWith('缓存歌曲') && !/^https?:\/\//i.test(cleanTitle)) {
    try {
      const kgRes = await searchKugouLyrics(cleanTitle, rawTitle);
      if (kgRes && kgRes.lyrics && containsChinese(kgRes.lyrics)) {
        console.log(`[lyrics] Kugou Chinese lyrics matched for "${cleanTitle}"`);
        if (key) saveLocalLrcContent(key, kgRes.lyrics, 'ytb', targetYtUrl);
        return kgRes.lyrics;
      }
    } catch (e) {
      console.warn('[lyrics] Kugou fallback error:', e.message);
    }

    try {
      const wyRes = await searchNeteaseLyrics(cleanTitle);
      if (wyRes && wyRes.lyrics && containsChinese(wyRes.lyrics)) {
        console.log(`[lyrics] Netease Chinese lyrics matched for "${cleanTitle}"`);
        if (key) saveLocalLrcContent(key, wyRes.lyrics, 'ytb', targetYtUrl);
        return wyRes.lyrics;
      }
    } catch (e) {
      console.warn('[lyrics] Netease fallback error:', e.message);
    }
  }

  if (lrcText && lrcText.trim()) {
    try {
      const tr = await translateLrcToChinese(lrcText);
      if (tr && containsChinese(tr)) {
        if (key) saveLocalLrcContent(key, tr, 'ytb', targetYtUrl);
        return tr;
      }
    } catch (e) {
      console.warn('[lyrics] Translation fallback error:', e.message);
    }
  }

  return lrcText || null;
}

async function fetchYouTubeSubtitles(inputUrl, key, songTitle = '') {
  if (!validateYouTubeUrl(inputUrl)) return null;
  if (hasNoSubMarker(key)) return null;

  const tempPrefix = path.join(CACHE_DIR, `ytsub_${key}_${Date.now()}`);
  const ytArgs = [
    '--socket-timeout', '30',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'zh-Hans,zh-CN,zh,zh-Hant,zh-TW,zh-HK,zh-SG,zh-Hans.*,zh-Hant.*,zh.*',
    '--sub-format', 'vtt/srt/best',
    '-o', `${tempPrefix}.%(ext)s`
  ];

  const cookiesPath = getYouTubeCookiesPath();
  if (cookiesPath) ytArgs.unshift('--cookies', cookiesPath);
  const curProxy = getYouTubeProxy();
  if (curProxy) ytArgs.unshift('--proxy', curProxy);
  ytArgs.push(inputUrl);

  try {
    await execFileAsync('yt-dlp', ytArgs, { timeout: 35000 });
  } catch (err) {
    console.log(`[lyrics] yt-dlp subtitle notice for ${key.slice(0, 10)}:`, err.message ? err.message.slice(0, 200) : '');
  }

  let subFiles = [];
  try {
    const dirFiles = fs.readdirSync(CACHE_DIR);
    const prefixName = path.basename(tempPrefix);
    subFiles = dirFiles.filter(f => f.startsWith(prefixName) && /\.(vtt|srt)$/i.test(f));
  } catch (e) {
    return null;
  }

  if (!subFiles.length) return null;

  // 严格只筛选中文字幕（简体/繁体/粤语），坚决过滤掉英文字幕等外文字幕
  const zhFiles = subFiles.filter(f => /(zh-Hans|zh-CN|zh-Hant|zh-TW|zh-HK|zh-SG|\.zh|\.yue)/i.test(f));

  let lrcText = null;
  if (zhFiles.length > 0) {
    const langPriority = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', 'zh-HK', 'zh-SG'];
    zhFiles.sort((a, b) => {
      const getScore = (name) => {
        for (let i = 0; i < langPriority.length; i++) {
          if (name.includes(langPriority[i])) return i;
        }
        return 999;
      };
      return getScore(a) - getScore(b);
    });

    const bestFile = path.join(CACHE_DIR, zhFiles[0]);
    try {
      const content = fs.readFileSync(bestFile, 'utf8');
      lrcText = convertVttOrSrtToLrc(content);
    } catch (e) {
      console.warn('[lyrics] Failed to read subtitle file:', e.message);
    }
  }

  for (const f of subFiles) {
    try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
  }

  if (lrcText && lrcText.trim()) {
    if (containsChinese(lrcText)) {
      const formattedLrc = `[source:youtube-subtitles]\n${lrcText.trim()}`;
      saveLocalLrcContent(key, formattedLrc, 'ytb', inputUrl);
      console.log(`[lyrics] Saved YouTube Chinese subtitle (${key.slice(0, 10)}.ytb.lrc, ${lrcText.split('\n').length} lines)`);
      return formattedLrc;
    } else {
      console.log(`[lyrics] Downloaded subtitle for ${key.slice(0, 10)} has no Chinese. Converting to Chinese...`);
      const converted = await ensureChineseLyrics(lrcText, songTitle, key, inputUrl);
      if (converted && containsChinese(converted)) {
        return converted;
      }
    }
  }

  return null;
}

async function handleLyrics(url, res) {
  const rawTitle = (url.searchParams.get('title') || '').trim().substring(0, 200);
  const key = (url.searchParams.get('key') || '').trim();
  const songUrl = (url.searchParams.get('url') || '').trim();
  const force = url.searchParams.get('force') === '1';
  const manual = url.searchParams.get('manual') === '1';

  const targetYtUrl = (songUrl && validateYouTubeUrl(songUrl)) ? songUrl : getYouTubeUrlByKey(key);

  // 0. 最高优先级：手动优选歌词 (.pref.lrc)，只要用户曾设为优选，权限高于 ytb 和所有平台
  if (!(force && manual) && key) {
    const localPref = getLocalLrcInfo(key, 'pref');
    if (localPref) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        lyrics: localPref.lyrics,
        synced: true,
        trackName: rawTitle,
        source: 'preferred',
        isPreferred: true
      }));
      return;
    }
  }

  // 1. 第二优先级：只要本地存在 ytb 字幕，优先返回 YouTube 原生中文字幕
  if (!(force && manual) && key) {
    const localYtb = getLocalLrcInfo(key, 'ytb');
    if (localYtb) {
      if (containsChinese(localYtb.lyrics)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          lyrics: localYtb.lyrics,
          synced: true,
          trackName: rawTitle,
          source: 'youtube-subtitles'
        }));
        return;
      } else {
        // 发现历史缓存是非中文字幕（如之前的英文字幕），自动触发转换并更新缓存
        console.log(`[lyrics] Cached ytb subtitle for ${key.slice(0, 10)} is non-Chinese. Converting to Chinese...`);
        const converted = await ensureChineseLyrics(localYtb.lyrics, rawTitle, key, targetYtUrl);
        if (converted && containsChinese(converted)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            lyrics: converted,
            synced: true,
            trackName: rawTitle,
            source: 'youtube-subtitles'
          }));
          return;
        }
      }
    }
  }

  // 2. 第三优先级：去 YouTube 下载原生中文字幕
  if (!(force && manual) && targetYtUrl && !hasNoSubMarker(key)) {
    const ytKey = key || getYouTubeCacheKey(targetYtUrl, 'mp3');
    try {
      const ytLrc = await fetchYouTubeSubtitles(targetYtUrl, ytKey, rawTitle);
      if (ytLrc) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          lyrics: ytLrc,
          synced: true,
          trackName: rawTitle,
          source: 'youtube-subtitles'
        }));
        return;
      }
    } catch (e) {
      console.warn('[lyrics] fetchYouTubeSubtitles notice:', e.message);
    }
  }

  // 3. 第四优先级：本地其他平台已缓存歌词 (kugou, netease, lrclib)
  if (!(force && manual) && key) {
    const localOther = getLocalLrcInfo(key);
    if (localOther && containsChinese(localOther.lyrics)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        lyrics: localOther.lyrics,
        synced: true,
        trackName: rawTitle,
        source: localOther.source
      }));
      return;
    }
  }

  // 4. 第五优先级：在线国内曲库检索 (酷狗 -> 网易云 -> lrclib)
  if (!rawTitle) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'title required' }));
    return;
  }
  const cleanTitle = cleanSongTitle(rawTitle) || rawTitle;

  // 避免使用占位符“缓存歌曲 xxxxxxxx”或链接去国内平台盲搜乱匹配出错误歌词
  if (!cleanTitle || cleanTitle.startsWith('缓存歌曲') || /^https?:\/\//i.test(cleanTitle)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lyrics: null }));
    return;
  }

  // 1. 优先：酷狗音乐 / QQ音乐曲库
  let result = await searchKugouLyrics(cleanTitle, rawTitle);

  // 2. 备用：网易云音乐
  if (!result) {
    result = await searchNeteaseLyrics(cleanTitle);
  }

  // 3. 备用：lrclib.net（外文/欧美歌曲）
  if (!result) {
    result = await searchLrclibLyrics(cleanTitle);
    if (result && result.lyrics && !containsChinese(result.lyrics)) {
      try {
        const tr = await translateLrcToChinese(result.lyrics);
        if (tr && containsChinese(tr)) result.lyrics = tr;
      } catch (e) {}
    }
  }

  if (result && result.lyrics) {
    if (key && /^[a-f0-9]{8,64}$/i.test(key)) {
      // 标注来自哪个平台保存，例如 <key>.kugou.lrc 或 <key>.netease.lrc
      saveLocalLrcContent(key, result.lyrics, result.source || 'kugou', targetYtUrl);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lyrics: null }));
  }
}

function handleLyricsDelete(req, res) {
  let body = '';
  let bodySize = 0;
  const MAX_BODY = 4096; // S4: 限制请求体最大 4KB
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const key = String(data.key || '').trim();
      if (!key || !/^[a-f0-9]{8,64}$/i.test(key)) {
        throw new Error('无效的歌曲标识');
      }

      let deletedCount = 0;
      let fullKey = key;
      const metadata = readCacheMetadata();
      if (key.length < 64) {
        const matched = Object.keys(metadata).find(k => k.startsWith(key));
        if (matched) fullKey = matched;
      }

      // 一次 readdir，后续复用（Q2: 避免循环内重复读目录）
      let allCacheFiles = [];
      try { allCacheFiles = fs.readdirSync(CACHE_DIR); } catch {}

      // 清除该 key 下所有格式的歌词文件: .ytb.lrc, .kugou.lrc, .netease.lrc, .lrclib.lrc, .lrc
      allCacheFiles.forEach(f => {
        if ((f.startsWith(key) && f.endsWith('.lrc')) || (f.startsWith(`ytsub_${key}`))) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, f));
            deletedCount++;
          } catch {}
        }
      });

      // 若为 YouTube 歌曲，同时清理对应的 mp3/mp4 格式歌词并打上 nosub 标记
      const ytUrl = getYouTubeUrlByKey(fullKey);
      if (ytUrl) {
        const mp3Key = getYouTubeCacheKey(ytUrl, 'mp3');
        const mp4Key = getYouTubeCacheKey(ytUrl, 'mp4');
        [mp3Key, mp4Key].forEach(k => {
          if (k) {
            // Q2: 复用已读取的文件列表，不再重复 readdirSync
            allCacheFiles.forEach(f => {
              if (f.startsWith(k) && f.endsWith('.lrc')) {
                try { fs.unlinkSync(path.join(CACHE_DIR, f)); deletedCount++; } catch {}
              }
            });
            try { fs.writeFileSync(path.join(CACHE_DIR, `${k}.nosub`), '', 'utf8'); } catch {}
          }
        });
      }

      // 创建 nosub 标记，防止再次播放时立即重复拉取已被用户清除的错误字幕
      try {
        fs.writeFileSync(path.join(CACHE_DIR, `${fullKey}.nosub`), '', 'utf8');
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deleted: deletedCount }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

function handleLyricsPrefer(req, res) {
  let body = '';
  let bodySize = 0;
  const MAX_BODY = 128 * 1024;
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      let key = String(data.key || '').trim();
      const lyrics = String(data.lyrics || '').trim();
      const action = String(data.action || 'set').trim();
      const songUrl = String(data.url || '').trim();

      if (!key && songUrl && validateYouTubeUrl(songUrl)) {
        key = getYouTubeCacheKey(songUrl, 'mp3');
      }

      if (!key || !/^[a-f0-9]{8,64}$/i.test(key)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的歌曲标识' }));
        return;
      }

      let fullKey = key;
      const metadata = readCacheMetadata();
      if (key.length < 64) {
        const matched = Object.keys(metadata).find(k => k.startsWith(key));
        if (matched) fullKey = matched;
      }

      if (action === 'unset') {
        const prefPath = path.join(CACHE_DIR, `${fullKey}.pref.lrc`);
        if (fs.existsSync(prefPath)) {
          try { fs.unlinkSync(prefPath); } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, action: 'unset' }));
        return;
      }

      if (!lyrics) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '歌词内容不能为空' }));
        return;
      }

      saveLocalLrcContent(fullKey, lyrics, 'pref');
      console.log(`[lyrics] Set preferred lyrics for ${fullKey.slice(0, 10)}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, isPreferred: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ==================== 24小时免登分享功能 ====================
function getOrCreateShareSecret() {
  if (process.env.SHARE_SECRET) {
    return process.env.SHARE_SECRET;
  }
  const secretFile = path.join(CACHE_DIR, '.share_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const content = fs.readFileSync(secretFile, 'utf8').trim();
      if (content) return content;
    }
  } catch (e) {}
  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, newSecret, 'utf8');
  } catch (e) {
    console.warn('Failed to save share secret to disk, using in-memory secret:', e.message);
  }
  return newSecret;
}
const SHARE_SECRET = getOrCreateShareSecret();

function escapeHtmlServer(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\'':'&#39;','"':'&quot;'}[char]));
}

function signShare(shortKey, expires) {
  return crypto.createHmac('sha256', SHARE_SECRET)
    .update(`${shortKey}:${expires}`)
    .digest('hex')
    .slice(0, 16);
}

function verifyShareSignature(shortKey, expires, sign) {
  if (!shortKey || !expires || !sign) return false;
  const expected = signShare(shortKey, expires);
  if (expected.length !== sign.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sign));
  } catch (e) {
    return false;
  }
}

function findCacheFileByShortKey(shortKey) {
  if (!shortKey || shortKey.length < 8) return null;
  let files = [];
  try {
    files = fs.readdirSync(CACHE_DIR);
  } catch (e) {
    return null;
  }
  const matched = files.find(f => f.startsWith(shortKey) && /\.(mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov)$/i.test(f));
  if (!matched) return null;
  const fullKey = matched.replace(/\.[^.]+$/, '');
  const ext = path.extname(matched).toLowerCase();
  const metadata = readCacheMetadata();
  const meta = metadata[matched] || metadata[fullKey] || {};
  return {
    file: matched,
    fullKey: fullKey,
    path: path.join(CACHE_DIR, matched),
    ext: ext,
    isVideo: /\.(mp4|webm|mov)$/i.test(ext),
    title: meta.title || '分享歌曲 ' + shortKey,
    url: meta.url || ''
  };
}

function getShareBaseUrl(req) {
  if (process.env.SHARE_BASE_URL) return process.env.SHARE_BASE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
  if (host && (host.includes('localhost') || host.includes('127.0.0.1') || /^192\.168\./.test(host) || /^10\./.test(host))) {
    return `${proto}://${host}`;
  }
  return 'https://mc.azhuan.ren';
}

function handleShareLink(req, res, url) {
  const fullKey = (url.searchParams.get('key') || '').trim();
  if (!fullKey) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '缺少歌曲 key' }));
    return;
  }
  // 截取 10 位短 hash (8-12位均可)
  const shortKey = fullKey.slice(0, 10);
  const song = findCacheFileByShortKey(shortKey);
  if (!song) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未在服务器缓存中找到该歌曲' }));
    return;
  }
  // 24小时有效
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const sign = signShare(shortKey, expires);
  const baseUrl = getShareBaseUrl(req);
  const shareUrl = `${baseUrl}/s/${shortKey}?t=${expires}&s=${sign}`;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    success: true,
    url: shareUrl,
    shortKey: shortKey,
    title: song.title,
    expires: expires
  }));
}

function handleShareRoute(req, res, url) {
  const pathname = url.pathname;

  // 歌词请求: /s/lyrics?title=...
  if (pathname === '/s/lyrics') {
    handleLyrics(url, res);
    return;
  }

  // 媒体流请求: /s/media/:shortKey?t=...&s=...
  if (pathname.startsWith('/s/media/')) {
    const shortKey = pathname.slice('/s/media/'.length).trim();
    const t = url.searchParams.get('t');
    const s = url.searchParams.get('s');

    if (!verifyShareSignature(shortKey, t, s)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: 签名无效');
      return;
    }
    if (Date.now() > Number(t)) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Gone: 分享已过期 (24小时)');
      return;
    }

    const song = findCacheFileByShortKey(shortKey);
    if (!song || !fs.existsSync(song.path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found');
      return;
    }

    const contentType = song.isVideo ? 'video/mp4' : (song.ext === '.flac' ? 'audio/flac' : (song.ext === '.wav' ? 'audio/wav' : 'audio/mpeg'));
    streamAudioFile(req, res, song.path, contentType);
    return;
  }

  // 落地播放页: /s/:shortKey?t=...&s=...
  const shortKey = pathname.slice('/s/'.length).trim();
  if (!shortKey) {
    res.writeHead(302, { 'Location': '/' });
    res.end();
    return;
  }

  const t = url.searchParams.get('t');
  const s = url.searchParams.get('s');

  if (!verifyShareSignature(shortKey, t, s)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderShareErrorHTML('⚠️ 分享链接无效', '该链接不完整或验证签名不匹配，请向好友获取最新分享链接。'));
    return;
  }

  const expNum = Number(t);
  if (Date.now() > expNum) {
    const expDateStr = new Date(expNum).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderShareErrorHTML('⏳ 分享链接已过期', `该分享链接的 24 小时有效期已于 <strong>${expDateStr}</strong> 截止。<br><br>歌曲资源仍在服务器，您可以联系好友重新生成分享链接。`));
    return;
  }

  const song = findCacheFileByShortKey(shortKey);
  if (!song) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderShareErrorHTML('🎵 歌曲不存在', '该歌曲已被服务器移除或无法读取。'));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderSharePlayerHTML(song, shortKey, t, s));
}

function renderShareErrorHTML(title, message) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtmlServer(title)} - 熊宝宝音乐</title>
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(circle at 50% 30%, #282a36 0%, #171822 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      padding: 36px 28px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
    }
    .logo { width: 90px; height: 75px; margin: 0 auto 16px; display: block; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.3)); }
    h1 { font-size: 20px; margin-bottom: 12px; color: #ffb86c; }
    p { font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.75); margin-bottom: 24px; }
    .btn {
      display: inline-block;
      padding: 9px 26px;
      background: #667eea;
      color: #fff;
      border-radius: 24px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .btn:hover { background: #5a67d8; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/logo.svg" alt="熊宝宝" class="logo">
    <h1>${escapeHtmlServer(title)}</h1>
    <p>${message}</p>
    <a href="/" class="btn">前往播放器首页</a>
  </div>
</body>
</html>`;
}

function renderSharePlayerHTML(song, shortKey, t, s) {
  const safeTitle = escapeHtmlServer(song.title);
  const mediaUrl = `/s/media/${encodeURIComponent(shortKey)}?t=${encodeURIComponent(t)}&s=${encodeURIComponent(s)}`;
  const lyricsUrl = `/s/lyrics?title=${encodeURIComponent(song.title)}&key=${encodeURIComponent(song.fullKey)}&url=${encodeURIComponent(song.url || '')}`;
  const expNum = Number(t) || 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>🎵 ${safeTitle} - 熊宝宝音乐分享</title>
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <meta name="theme-color" content="#1a1b26">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(circle at 50% 25%, #2a2d42 0%, #14151f 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px 14px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      width: 100%;
      max-width: 440px;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 24px;
      padding: 24px 20px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
      text-align: center;
      position: relative;
    }
    .brand-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 14px;
    }
    .brand-logo {
      width: 26px;
      height: 22px;
    }
    .brand-text {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.7);
      font-weight: 500;
      letter-spacing: 0.5px;
    }
    .badge-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(102, 126, 234, 0.25);
      color: #a3bffa;
      border: 1px solid rgba(102, 126, 234, 0.4);
      margin-left: 4px;
    }
    .disc-container {
      position: relative;
      width: 190px;
      height: 190px;
      margin: 10px auto 16px;
    }
    .vinyl-disc {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle, #2b2b36 0%, #15151c 65%, #0d0d12 100%);
      border: 5px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), inset 0 0 0 2px rgba(255, 255, 255, 0.05), inset 0 0 0 10px rgba(0,0,0,0.5), inset 0 0 0 24px rgba(255, 255, 255, 0.03), inset 0 0 0 40px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: spinVinyl 18s linear infinite;
      animation-play-state: paused;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
    }
    .vinyl-disc.playing {
      animation-play-state: running;
    }
    @keyframes spinVinyl {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .vinyl-center {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: 3px solid rgba(255, 255, 255, 0.35);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vinyl-center img {
      width: 44px;
      height: 35px;
    }
    .play-overlay-hint {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 2px solid rgba(255, 255, 255, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      transition: opacity 0.3s;
      box-shadow: 0 0 20px rgba(102, 126, 234, 0.6);
    }
    .play-overlay-hint svg {
      margin-left: 3px;
      fill: #fff;
    }
    .video-wrap {
      width: 100%;
      margin: 10px 0 16px;
      border-radius: 14px;
      overflow: hidden;
      background: #000;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
    .video-wrap video {
      width: 100%;
      display: block;
      max-height: 50vh;
      outline: none;
    }
    .song-title {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      line-height: 1.4;
      margin: 4px 0 8px;
      word-break: break-all;
    }
    .song-meta {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 12px;
    }
    .lyrics-container {
      height: 160px;
      overflow: hidden;
      position: relative;
      margin: 12px 0 16px;
      mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
    }
    .lyrics-scroll {
      position: relative;
      transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
      padding: 65px 0;
      text-align: center;
    }
    .lyric-line {
      font-size: 13.5px;
      line-height: 1.6;
      padding: 5px 12px;
      min-height: 28px;
      color: rgba(255, 255, 255, 0.35);
      transition: color 0.3s ease, font-size 0.3s ease, transform 0.3s ease;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      border-radius: 6px;
      word-break: break-word;
    }
    .lyric-line:hover {
      color: rgba(255, 255, 255, 0.85);
      background: rgba(255, 255, 255, 0.05);
    }
    .lyric-line.near {
      color: rgba(255, 255, 255, 0.65);
    }
    .lyric-line.active {
      color: #a3bffa;
      font-size: 15.5px;
      font-weight: 700;
      transform: scale(1.03);
      text-shadow: 0 0 16px rgba(102, 126, 234, 0.85);
    }
    .progress-section {
      margin-top: 10px;
    }
    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 3px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #667eea, #9f7aea);
      border-radius: 3px;
      transition: width 0.1s linear;
    }
    .time-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      margin-top: 6px;
    }
    .controls-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;
      margin: 16px 0 10px;
    }
    .ctrl-btn {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.8);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px;
      border-radius: 50%;
      transition: all 0.2s;
    }
    .ctrl-btn:hover {
      color: #fff;
      transform: scale(1.1);
    }
    .ctrl-btn-play {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
    }
    .ctrl-btn-play:hover {
      transform: scale(1.06);
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.7);
    }
    .expire-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 14px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
      margin-top: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
  </style>
</head>
<body>
  <div class="container" id="playerCard">
    <div class="brand-header">
      <img src="/logo.svg" alt="熊宝宝" class="brand-logo">
      <span class="brand-text">熊宝宝音乐</span>
      <span class="badge-pill">好友分享</span>
    </div>

    ${song.isVideo ? `
    <div class="video-wrap">
      <video id="mediaPlayer" src="${mediaUrl}" controls playsinline autoplay></video>
    </div>
    ` : `
    <div class="disc-container" id="discBox" onclick="togglePlay()">
      <div class="vinyl-disc" id="vinylDisc">
        <div class="vinyl-center">
          <img src="/logo.svg" alt="熊宝宝">
        </div>
      </div>
      <div class="play-overlay-hint" id="playHint">
        <svg viewBox="0 0 24 24" width="28" height="28"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </div>
    `}

    <div class="song-title">${safeTitle}</div>
    <div class="song-meta">${song.isVideo ? '🎬 高清视频' : '🎵 高品质音频'} · 服务器本地极速直出</div>

    ${!song.isVideo ? `
    <div class="lyrics-container" id="lyricsContainer">
      <div class="lyrics-scroll" id="lyricsScroll">
        <div class="lyric-line active" id="lrcStatus">正在加载歌词...</div>
      </div>
    </div>

    <div class="progress-section">
      <div class="progress-bar-bg" id="progressBg" onclick="seekAudio(event)">
        <div class="progress-bar-fill" id="progressFill"></div>
      </div>
      <div class="time-labels">
        <span id="curTime">00:00</span>
        <span id="durTime">--:--</span>
      </div>
    </div>

    <div class="controls-row">
      <button type="button" class="ctrl-btn" onclick="skipTime(-10)" title="后退10秒">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.22 3.16-1.98 5.12-1.98 3.53 0 6.47 2.44 7.29 5.75l2.42-.77C21.03 11.08 17.2 8 12.5 8z"/><text x="12" y="18" font-size="7" font-weight="bold" text-anchor="middle" fill="currentColor">10</text></svg>
      </button>

      <button type="button" class="ctrl-btn ctrl-btn-play" id="mainPlayBtn" onclick="togglePlay()" title="播放/暂停">
        <svg id="playIcon" viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <svg id="pauseIcon" viewBox="0 0 24 24" width="30" height="30" fill="currentColor" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>

      <button type="button" class="ctrl-btn" onclick="skipTime(10)" title="快进10秒">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.22-3.16-1.98-5.12-1.98-3.53 0-6.47 2.44-7.29 5.75l-2.42-.77C2.97 11.08 6.8 8 11.5 8z"/><text x="12" y="18" font-size="7" font-weight="bold" text-anchor="middle" fill="currentColor">10</text></svg>
      </button>

      <button type="button" class="ctrl-btn" id="muteBtn" onclick="toggleMute()" title="静音切换">
        <svg id="volIcon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
        <svg id="muteIcon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="display:none;"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
      </button>
    </div>

    <audio id="mediaPlayer" src="${mediaUrl}" preload="auto" playsinline></audio>
    ` : ''}

    <div>
      <div class="expire-pill">
        <span>⏰ 24小时有效通道</span>
        <span>·</span>
        <span id="remainCount">计算中...</span>
      </div>
    </div>
  </div>

  <script>
    var player = document.getElementById('mediaPlayer');
    var isVideo = ${song.isVideo ? 'true' : 'false'};
    var vinylDisc = document.getElementById('vinylDisc');
    var playHint = document.getElementById('playHint');
    var playIcon = document.getElementById('playIcon');
    var pauseIcon = document.getElementById('pauseIcon');
    var curTime = document.getElementById('curTime');
    var durTime = document.getElementById('durTime');
    var progressFill = document.getElementById('progressFill');
    var progressBg = document.getElementById('progressBg');
    var lyricsScroll = document.getElementById('lyricsScroll');
    var lrcStatus = document.getElementById('lrcStatus');
    var remainCount = document.getElementById('remainCount');
    var volIcon = document.getElementById('volIcon');
    var muteIcon = document.getElementById('muteIcon');
    var expireTime = ${expNum};
    var lrcData = [];
    var curLrcIndex = -1;

    function formatTime(s) {
      if (!s || isNaN(s)) return '00:00';
      var m = Math.floor(s / 60);
      var sec = Math.floor(s % 60);
      return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function updateExpireCountdown() {
      var diff = expireTime - Date.now();
      if (diff <= 0) {
        remainCount.textContent = '链接已过期';
        if (player) player.pause();
        return;
      }
      var h = Math.floor(diff / (1000 * 60 * 60));
      var m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      remainCount.textContent = '剩余约 ' + (h > 0 ? (h + ' 小时 ') : '') + m + ' 分钟';
    }
    updateExpireCountdown();
    setInterval(updateExpireCountdown, 30000);

    function togglePlay() {
      if (!player) return;
      if (player.paused) {
        player.play().catch(function(e) { console.warn('播放被阻止:', e); });
      } else {
        player.pause();
      }
    }

    function skipTime(delta) {
      if (!player) return;
      player.currentTime = Math.max(0, Math.min(player.duration || 0, player.currentTime + delta));
      updateLyrics(player.currentTime, true);
    }

    function toggleMute() {
      if (!player) return;
      player.muted = !player.muted;
      if (volIcon && muteIcon) {
        volIcon.style.display = player.muted ? 'none' : 'block';
        muteIcon.style.display = player.muted ? 'block' : 'none';
      }
    }

    function seekAudio(e) {
      if (!player || !player.duration || !progressBg) return;
      var rect = progressBg.getBoundingClientRect();
      var ratio = (e.clientX - rect.left) / rect.width;
      player.currentTime = Math.max(0, Math.min(player.duration, Math.max(0, ratio * player.duration)));
      updateLyrics(player.currentTime, true);
    }

    function jumpToLyric(time) {
      if (!player || isNaN(time)) return;
      player.currentTime = Math.max(0, time);
      if (player.paused) {
        player.play().catch(function() {});
      }
      updateLyrics(time, true);
    }

    if (player) {
      player.addEventListener('play', function() {
        if (vinylDisc) vinylDisc.classList.add('playing');
        if (playHint) playHint.style.opacity = '0';
        if (playIcon) playIcon.style.display = 'none';
        if (pauseIcon) pauseIcon.style.display = 'block';
      });

      player.addEventListener('pause', function() {
        if (vinylDisc) vinylDisc.classList.remove('playing');
        if (playHint) playHint.style.opacity = '1';
        if (playIcon) playIcon.style.display = 'block';
        if (pauseIcon) pauseIcon.style.display = 'none';
      });

      player.addEventListener('timeupdate', function() {
        if (!isVideo) {
          var cur = player.currentTime || 0;
          var dur = player.duration || 0;
          if (curTime) curTime.textContent = formatTime(cur);
          if (durTime && dur) durTime.textContent = formatTime(dur);
          if (progressFill && dur) progressFill.style.width = ((cur / dur) * 100) + '%';
          updateLyrics(cur);
        }
      });

      player.addEventListener('seeking', function() {
        if (!isVideo && player) updateLyrics(player.currentTime || 0, true);
      });

      player.addEventListener('seeked', function() {
        if (!isVideo && player) updateLyrics(player.currentTime || 0, true);
      });

      player.addEventListener('loadedmetadata', function() {
        if (durTime) durTime.textContent = formatTime(player.duration);
      });

      window.addEventListener('resize', function() {
        if (!isVideo && player) updateLyrics(player.currentTime || 0, true);
      });

      var playPromise = player.play();
      if (playPromise !== undefined) {
        playPromise.catch(function() {
          if (playHint) playHint.style.opacity = '1';
          function onceClick() {
            player.play().catch(function() {});
            document.removeEventListener('click', onceClick);
            document.removeEventListener('touchend', onceClick);
          }
          document.addEventListener('click', onceClick);
          document.addEventListener('touchend', onceClick);
        });
      }
    }

    if (!isVideo) {
      var lyricsUrl = ${JSON.stringify(lyricsUrl)};
      fetch(lyricsUrl)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (!data || !data.lyrics) {
            if (lrcStatus) lrcStatus.textContent = '🎵 纯享播放模式 · 聆听音乐';
            return;
          }
          parseLrc(data.lyrics);
        })
        .catch(function(err) {
          console.warn('获取歌词失败:', err);
          if (lrcStatus) lrcStatus.textContent = '🎵 纯音乐 / 暂未匹配到歌词';
        });
    }

    function parseLrc(text) {
      if (!text || typeof text !== 'string') {
        if (lrcStatus) lrcStatus.textContent = '🎵 纯享模式 · 聆听好音乐';
        return;
      }
      var lines = text.split('\\n');
      var list = [];
      var timeRe = /\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?\\]/g;
      var offsetMatch = text.match(/\\[offset:\\s*([+-]?\\d+)\\]/i);
      var lrcOffset = offsetMatch ? parseInt(offsetMatch[1], 10) / 1000 : 0;
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
            ms = msLen === 1 ? parseInt(m[3], 10) * 100 : (msLen === 2 ? parseInt(m[3], 10) * 10 : parseInt(m[3], 10));
          }
          times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000 - lrcOffset);
        }
        var t = line.replace(/\\[\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?\\]/g, '').trim();
        if (t && times.length) {
          for (var j = 0; j < times.length; j++) {
            list.push({ time: Math.max(0, times[j]), text: t });
          }
        }
      }
      list.sort(function(a, b) { return a.time - b.time; });
      lrcData = list;
      if (!list.length) {
        var cleanPlainText = text.replace(/\\[[^\\]]*\\]/g, '').trim();
        if (cleanPlainText && lyricsScroll) {
          lyricsScroll.innerHTML = '<div style="padding:10px;font-size:13px;color:rgba(255,255,255,0.6);text-align:center;white-space:pre-line;line-height:1.8;">' + escapeHtmlText(cleanPlainText.substring(0, 1500)) + '</div>';
        } else if (lrcStatus) {
          lrcStatus.textContent = '🎵 纯享模式 · 聆听好音乐';
        }
        return;
      }
      renderLrcDom();
    }

    function renderLrcDom() {
      if (!lyricsScroll) return;
      var html = '';
      for (var i = 0; i < lrcData.length; i++) {
        html += '<div class="lyric-line" id="lrc_' + i + '" onclick="jumpToLyric(' + lrcData[i].time + ')" title="点击跳转播放">' + escapeHtmlText(lrcData[i].text) + '</div>';
      }
      lyricsScroll.innerHTML = html;
      curLrcIndex = -1;
      updateLyrics(player ? (player.currentTime || 0) : 0, true);
    }

    function updateLyrics(cur, force) {
      if (!lrcData || !lrcData.length || !lyricsScroll) return;
      var idx = -1;
      for (var i = 0; i < lrcData.length; i++) {
        if (cur >= lrcData[i].time) {
          idx = i;
        } else {
          break;
        }
      }
      if (!force && idx === curLrcIndex) return;
      curLrcIndex = idx;
      var lines = lyricsScroll.children;
      for (var j = 0; j < lines.length; j++) {
        lines[j].classList.remove('active', 'near');
        if (j === idx) {
          lines[j].classList.add('active');
        } else if (idx >= 0 && Math.abs(j - idx) <= 1) {
          lines[j].classList.add('near');
        }
      }
      if (idx >= 0) {
        var activeLine = document.getElementById('lrc_' + idx);
        if (activeLine) {
          var container = lyricsScroll.parentElement;
          var boxH = container ? container.clientHeight : 160;
          var centerOffset = (boxH - activeLine.offsetHeight) / 2;
          var offset = activeLine.offsetTop - centerOffset;
          lyricsScroll.style.transform = 'translateY(-' + Math.max(0, offset) + 'px)';
        }
      } else {
        lyricsScroll.style.transform = 'translateY(0px)';
      }
    }

    function escapeHtmlText(str) {
      return String(str || '').replace(/[&<>'"]/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
      });
    }
  </script>
</body>
</html>`;
}

module.exports = server;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
