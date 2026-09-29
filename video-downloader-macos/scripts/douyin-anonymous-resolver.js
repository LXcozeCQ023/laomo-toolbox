#!/usr/bin/env node
'use strict';

// Resolve a public Douyin video through a brand-new anonymous browser session.
// The session never reads the user's Chrome/Edge profile and never exports cookies.
// Its temporary profile is removed as soon as resolution finishes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        '/usr/bin/google-chrome',
        '/usr/bin/microsoft-edge',
      ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function isAllowedMediaUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'www.douyin.com'
      || host === 'aweme.snssdk.com'
      || host.endsWith('.douyinvod.com')
      || host.endsWith('.byteimg.com')
      || host.endsWith('.douyinpic.com')
      || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

function addressUrls(address) {
  const list = address?.url_list || address?.urlList || [];
  return list.filter((url) => isAllowedMediaUrl(url));
}

function chooseVideo(item) {
  const rates = item?.video?.bit_rate || item?.video?.bitRate || [];
  const compatible = rates
    .map((rate) => ({
      bitrate: Number(rate.bit_rate || rate.bitRate) || 0,
      format: String(rate.format || '').toLowerCase(),
      h265: Number(rate.is_h265 ?? rate.isH265 ?? 0) !== 0,
      bytevc1: Number(rate.is_bytevc1 ?? rate.isBytevc1 ?? 0) !== 0,
      urls: addressUrls(rate.play_addr || rate.playAddr),
    }))
    .filter((rate) => rate.urls.length && rate.format === 'mp4' && !rate.h265 && !rate.bytevc1)
    .sort((a, b) => b.bitrate - a.bitrate);
  if (compatible.length) return compatible[0].urls[0];

  const progressive = addressUrls(item?.video?.play_addr || item?.video?.playAddr);
  if (progressive.length) return progressive[0];
  return '';
}

// 图文（图集）作品：取每张图的原图地址，优先 download_url_list，其次 url_list。
const MAX_IMAGES = 100;

function chooseImages(item) {
  const raw = Array.isArray(item?.images) ? item.images
    : Array.isArray(item?.image_list) ? item.image_list
    : Array.isArray(item?.imageList) ? item.imageList
    : [];
  const urls = [];
  const seen = new Set();
  for (const image of raw) {
    if (!image || typeof image !== 'object') continue;
    const candidates = [
      ...(Array.isArray(image.download_url_list) ? image.download_url_list : []),
      ...(Array.isArray(image.downloadUrlList) ? image.downloadUrlList : []),
      ...(Array.isArray(image.url_list) ? image.url_list : []),
      ...(Array.isArray(image.urlList) ? image.urlList : []),
    ];
    const picked = candidates.find((url) => typeof url === 'string' && isAllowedMediaUrl(url));
    if (picked && !seen.has(picked)) {
      seen.add(picked);
      urls.push(picked);
    }
    if (urls.length >= MAX_IMAGES) break;
  }
  return urls;
}

function findItem(value, videoId) {
  if (!value || typeof value !== 'object') return null;
  const candidateId = value.aweme_id || value.awemeId || value.itemId || value.item_id || '';
  // 图文作品没有 video 字段，只有 images / image_list，必须一并接受。
  if (String(candidateId) === String(videoId) && (value.video || value.images || value.image_list || value.imageList)) return value;
  for (const child of Object.values(value)) {
    const found = findItem(child, videoId);
    if (found) return found;
  }
  return null;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = [];
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.close(); reject(new Error('浏览器连接超时')); }, 5000);
      this.socket.onopen = () => { clearTimeout(timer); resolve(); };
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('浏览器连接失败')); };
    });
    this.socket.onclose = () => { for (const request of this.pending.values()) request.reject(new Error('临时浏览器已关闭')); this.pending.clear(); };
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      if (!message.method) return;
      for (const handler of this.handlers) Promise.resolve(handler(message)).catch(() => {});
    };
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器操作超时')); }, 5000);
      const finish = callback => value => { clearTimeout(timer); this.pending.delete(id); callback(value); };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.get(id).reject(error); }
    });
  }

  on(handler) { this.handlers.push(handler); }
  close() { try { this.socket.close(); } catch {} }
}

// 被宿主程序限制的进程里，Chrome 建不了自己的沙箱：网络进程反复崩溃、GPU 进程
// FATAL 退出，最后连 DevTools 端口都答不上话。特征的报错文案都在这条正则里。
const SANDBOX_BLOCKED_RE = /sandbox initialization failed|Failed to initialize sandbox/i;

// Chrome 的 stderr 在正常启动时也会刷一堆 sandbox / GPU / allocator 警告，所以
// 不能拿关键字去猜结论：先把最后一条真正致命的日志捞出来当证据。
function chromeFatalLine(log) {
  const lines = String(log || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/FATAL|:ERROR:|ERROR:/.test(lines[i])) return lines[i].slice(-240);
  }
  return lines.length ? lines[lines.length - 1].slice(-240) : '';
}

// 把 Chrome 起不来的常见原因翻译成用户能照着做的提示。
function browserDiagnosis(log) {
  if (SANDBOX_BLOCKED_RE.test(log)) {
    return '当前运行环境不允许 Chrome 建立自身沙箱（常见于被宿主程序限制的进程），可改用 --no-sandbox 的临时会话重试';
  }
  if (/GPU process isn't usable|GPU process exited unexpectedly/i.test(log)) {
    return 'Chrome 的 GPU 进程无法启动';
  }
  if (/allocator multiple times/i.test(log)) {
    return 'Chrome 启动参数被外部环境干扰';
  }
  return '';
}

// 启动失败时留一份现场：Chrome 的路径、参数、退出码、stderr 尾巴。下次再出问题
// 不用猜。只保留最后一段，别把磁盘写满。
function recordBrowserFailure(state, message) {
  try {
    const file = path.join(__dirname, '..', 'bin', 'browser.log');
    const block = [
      `===== ${new Date().toISOString()} ${message} =====`,
      `browser=${state.browser || '(未找到)'} noSandbox=${!!state.noSandbox} exitCode=${state.child ? state.child.exitCode : '-'}`,
      `args=${(state.args || []).join(' ')}`,
      `spawnError=${state.spawnError ? state.spawnError.message : '-'}`,
      state.log ? `stderr:\n${state.log.slice(-4000)}` : 'stderr: (空)',
      '',
    ].join('\n');
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, (previous + block).slice(-60000));
  } catch {}
}

async function waitForDevTools(profileDir, child, state = {}) {
  const marker = path.join(profileDir, 'DevToolsActivePort');
  // 全新配置目录的冷启动（杀毒扫描、Gatekeeper 校验、磁盘忙）偶尔会超过 12 秒，
  // 给到 20 秒，别把能起得来的情况误判成起不来。
  for (let attempt = 0; attempt < 200; attempt++) {
    if (state.spawnError) throw new Error(`匿名浏览器启动失败：${state.spawnError.message}`);
    if (child && (child.killed || child.exitCode !== null)) throw new Error('临时浏览器已退出');
    if (fs.existsSync(marker)) {
      const port = fs.readFileSync(marker, 'utf8').split(/\r?\n/)[0];
      if (/^\d+$/.test(port)) return port;
    }
    await sleep(100);
  }
  throw new Error('匿名浏览器启动超时');
}

async function findPageTarget(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json();
      const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank')
        || targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error('匿名浏览器页面未就绪');
}

function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
  }
  try { child.kill(); } catch {}
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(value); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function watchBrowserOwner(child, timeoutMs) {
  const stop = () => stopBrowser(child);
  const cancel = message => { if (message === 'cancel') stop(); };
  const timer = setTimeout(stop, timeoutMs);
  process.once('disconnect', stop);
  process.on('message', cancel);
  if (process.connected) process.send({ type: 'browser-started', pid: child.pid });
  return () => { clearTimeout(timer); process.removeListener('disconnect', stop); process.removeListener('message', cancel); };
}

// 排查现场用的轻量日志：匿名会话每一步记一行，文件自己截断，不会写满磁盘。
// 只有这条链路异常时才需要看，正常时可以忽略。
function diag(line) {
  try {
    const file = path.join(__dirname, '..', 'bin', 'browser.log');
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, (previous + `[${new Date().toISOString()}] ${line}\n`).slice(-60000));
  } catch {}
}

// 启动参数集中在这里，方便把 --no-sandbox 这条退路插进同一个地方。
function chromeArgs(profileDir, proxy = '', noSandbox = false) {
  const args = [
    '--headless=new', '--incognito', '--mute-audio', '--disable-gpu', '--disable-extensions',
    '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
    // 从 launchd（双击启动的后台服务）拉起时，Chrome 会被系统当成后台程序：
    // 隐藏页面的定时器被掐到一分钟一次，页面 JS 半死不活，渲染进程连
    // Runtime.evaluate 都答不上话——表现就是"页面打开了但永远不来数据"。
    // 这组参数是自动化场景的标准防抖配置，明确告诉 Chrome 别掐后台页面。
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
  ];
  // 只在被宿主限制了沙箱时才退到 --no-sandbox：临时配置目录、不开扩展、只访问
  // 公开页面、用完即删，换成能跑起来是划算的。
  if (noSandbox) args.push('--no-sandbox');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push('--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank');
  return args;
}

// 从 Finder 双击的 .app 启动的脚本会被 LaunchServices 按 x86_64 拉起来（可执行文件
// 是脚本，没有架构元数据），Rosetta 的架构偏好顺着 spawn 链一路传给 Chrome，
// 渲染进程全在 x86 翻译模式下跑——页面慢十倍、详情接口永远等不到的根源。
// 显式用 arch -arm64 起 Chrome，把它掰回原生；arch 会原地 exec，pid 就是 Chrome 自己。
function browserCommand(browser) {
  if (process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync('/usr/bin/arch')) {
    return { command: '/usr/bin/arch', prefix: ['-arm64', browser] };
  }
  return { command: browser, prefix: [] };
}

function startBrowser(browser, profileDir, proxy, noSandbox) {
  const args = chromeArgs(profileDir, proxy, noSandbox);
  const { command, prefix } = browserCommand(browser);
  const child = spawn(command, [...prefix, ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { browser, args, noSandbox, child, log: '', spawnError: null };
  // spawn 失败（路径不可执行、被策略拦）只会走 error 事件；以前这里直接吞掉，
  // 结果表现成"启动超时"，白白等十几秒还看不出原因。
  child.on('error', (error) => { state.spawnError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { state.log = (state.log + data).slice(-8000); });
  return state;
}

async function resolveOnce(videoId, proxy, noSandbox) {
  const browser = findBrowser();
  if (!browser) throw new Error('需要安装 Chrome 或 Edge 才能建立匿名临时会话');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinewood-douyin-'));
  const state = startBrowser(browser, profileDir, proxy, noSandbox);
  const { child } = state;
  const releaseOwnerWatch = watchBrowserOwner(child, 40000);
  let cdp;
  diag(`开始 id=${videoId} proxy=${proxy || '(无)'} noSandbox=${!!noSandbox} pid=${child.pid}`);
  try {
    let port;
    try {
      port = await waitForDevTools(profileDir, child, state);
    } catch (error) {
      recordBrowserFailure(state, error.message);
      const hint = browserDiagnosis(state.log);
      const fatal = hint ? '' : chromeFatalLine(state.log);
      const suffix = hint || fatal;
      const failed = new Error(suffix ? `${error.message}：${suffix}` : error.message);
      // 启动类失败都值得换一条参数再试一次，取数据阶段失败则不必。
      failed.chromeStartupFailure = true;
      failed.chromeSandboxBlocked = SANDBOX_BLOCKED_RE.test(state.log);
      throw failed;
    }
    diag(`DevTools 就绪 port=${port}`);
    const target = await findPageTarget(port);
    diag(`页面 target=${target.url}`);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    diag('CDP 已连接');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 渲染进程一崩，页面 JS 就不再跑、详情接口永远不来，但浏览器本身还活着，
    // 不监听这个事件就只能干等 18 秒然后报"没取到数据"。
    await cdp.send('Inspector.enable').catch(() => {});
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: DESKTOP_UA,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Windows',
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})",
    });
    diag('CDP 初始化完成');

    let finish;
    let settled = false;
    const found = new Promise((resolve) => { finish = resolve; });
    const candidates = new Set();
    cdp.on(async (message) => {
      if (settled) return;
      if (message.method === 'Inspector.targetCrashed') {
        diag('页面渲染进程崩溃（页面 JS 不会再跑，这轮不会有数据）');
        return;
      }
      if (message.method === 'Network.responseReceived') {
        const { requestId, response, type } = message.params;
        const isJson = /(?:json|javascript)/i.test(response.mimeType || '');
        if (isJson && (type === 'XHR' || type === 'Fetch' || /aweme|detail|feed/i.test(response.url))) {
          candidates.add(requestId);
        }
        return;
      }
      if (message.method !== 'Network.loadingFinished' || !candidates.has(message.params.requestId)) return;
      candidates.delete(message.params.requestId);
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: message.params.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        diag(`候选 JSON ${text.length}B 含编号=${text.includes(String(videoId))}`);
        if (text.length > 8 * 1024 * 1024 || !text.includes(String(videoId))) return;
        const item = findItem(JSON.parse(text), videoId);
        if (!item) return;
        const base = {
          id: String(videoId),
          title: String(item.desc || '抖音作品').slice(0, 200),
          userAgent: DESKTOP_UA,
          referer: 'https://www.douyin.com/',
        };
        const url = chooseVideo(item);
        if (url) {
          settled = true;
          return finish({ ...base, kind: 'video', duration: Number(item.video?.duration || item.duration) || 0, url });
        }
        // 图文作品：没有播放地址，改为交出图片清单。
        const images = chooseImages(item);
        if (images.length) {
          settled = true;
          return finish({ ...base, kind: 'images', count: images.length, images });
        }
      } catch {}
    });

    // 先访问 /video/ 再退回 /note/。实测图文作品走 /video/ 会自己跳到图文页并很快
    // 吐出详情，反过来先开 /note/ 反而慢一倍，所以顺序不要调。
    const visit = async (pageUrl) => {
      diag(`导航 ${pageUrl}`);
      const nav = await cdp.send('Page.navigate', { url: pageUrl });
      if (nav && nav.errorText) diag(`导航返回错误 ${pageUrl} -> ${nav.errorText}`);
      diag(`导航已提交 ${pageUrl}`);
      const outcome = await Promise.race([found, sleep(18000).then(() => null)]);
      if (!outcome) {
        diag(`18 秒没等到数据 ${pageUrl}`);
        // 直接看看页面现在的样子：是验证页、空白页还是正常页面只是没吐数据。
        try {
          const snapshot = await cdp.send('Runtime.evaluate', {
            expression: "[location.href, document.title, 'scripts='+document.scripts.length, 'imgs='+document.images.length, (document.body ? document.body.innerText.slice(0, 160).replace(/\\s+/g,' ') : '(body 为空)')].join(' | ')",
            returnByValue: true,
          });
          diag(`页面状态：${snapshot?.result?.value ?? '(读不到)'}`);
        } catch (snapError) {
          diag(`读取页面状态失败：${snapError.message}`);
        }
      }
      return outcome;
    };
    const result = await visit(`https://www.douyin.com/video/${videoId}`)
      || await visit(`https://www.douyin.com/note/${videoId}`);
    if (!result) throw new Error('匿名临时会话没有取得播放地址（视频或图文）');
    diag(`取到数据 kind=${result.kind} count=${result.count || 1}`);
    return result;
  } catch (error) {
    diag(`出错：${error.message}`);
    // 已经带上启动失败标记的，原样往外抛，别被二次包装冲掉标记。
    if (error.chromeStartupFailure) throw error;
    // 浏览器起来了又掉线：同样是"起不来"，值得换参数再试一次。
    const startup = /临时浏览器已关闭|浏览器连接失败|浏览器连接超时|浏览器页面未就绪/.test(String(error.message));
    if (startup) {
      recordBrowserFailure(state, error.message);
      error.chromeStartupFailure = true;
      error.chromeSandboxBlocked = SANDBOX_BLOCKED_RE.test(state.log);
    }
    const hint = browserDiagnosis(state.log);
    if (hint && !String(error.message).includes(hint)) error.message = `${error.message}：${hint}`;
    throw error;
  } finally {
    releaseOwnerWatch();
    cdp?.close();
    stopBrowser(child);
    // 等 Chrome 真的退出再删配置目录：只 sleep 一小会儿就删，它会边写边被杀，
    // 每个任务都会在临时目录留一份上百 KB 的残留。
    await waitForExit(child, 3000);
    if (!path.resolve(profileDir).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(profileDir).startsWith('shinewood-douyin-')) throw new Error('临时目录检查失败');
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); } catch {}
      if (!fs.existsSync(profileDir)) break;
      await sleep(400);
    }
  }
}

// 匿名临时会话：沙箱能建就用沙箱，建不了（被宿主程序限制的进程）就自动换
// --no-sandbox 再跑一次，而不是直接放弃。调试时也可以用 SHINEWOOD_CHROME_NO_SANDBOX=1
// 强制走免沙箱模式。
function wantsNoSandbox(options) {
  return options?.noSandbox === true || process.env.SHINEWOOD_CHROME_NO_SANDBOX === '1';
}

async function resolveAnonymous(videoId, proxy = '', options = {}) {
  if (!/^\d{15,25}$/.test(String(videoId || ''))) throw new Error('抖音视频编号无效');
  const noSandbox = wantsNoSandbox(options);
  try {
    return await resolveOnce(videoId, proxy, noSandbox);
  } catch (error) {
    if (noSandbox || !error.chromeStartupFailure) throw error;
    diag(`首轮失败（${error.message}），换免沙箱模式重试`);
    try {
      return await resolveOnce(videoId, proxy, true);
    } catch (retryError) {
      const first = String(error.message).split('：')[0];
      throw new Error(`${first}（换用免沙箱模式后仍然失败：${retryError.message}）`);
    }
  }
}

async function main() {
  const result = await resolveAnonymous(process.argv[2], process.argv[3] || '');
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error.message || '匿名临时会话解析失败'));
    process.exitCode = 1;
  }).finally(() => { if (process.connected) process.disconnect(); });
}

module.exports = { chooseVideo, chooseImages, findItem, isAllowedMediaUrl, resolveAnonymous,
  findBrowser, browserCommand, CdpClient, waitForDevTools, findPageTarget, stopBrowser, watchBrowserOwner,
  chromeArgs, browserDiagnosis, chromeFatalLine, SANDBOX_BLOCKED_RE };
