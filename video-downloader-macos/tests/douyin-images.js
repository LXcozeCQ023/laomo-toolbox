'use strict';
// 抖音图文（图集）下载回归：解析 → 逐张下载 → 文件头/结尾校验 → 重复与损坏处理。
// 不发外网请求：抖音接口和图片 CDN 都用本地服务冒充，fetch 只在测试内重定向。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-images-test-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const VIDEO_ID = '7519000000000000000';
const CDN = 'https://p3-sign.douyinpic.com';
let mode = 'ok';
let port = 0;
const flakyHits = {};

function shoot(file, color) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=${color}:s=240x160`, '-frames:v', '1', '-y', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.strictEqual(result.status, 0, result.stderr);
}

const names = ['01.jpg', '02.jpg', '03.jpg'];
const bytes = names.map((name, i) => {
  const file = path.join(temp, name);
  shoot(file, ['red', 'green', 'blue'][i]);
  return fs.readFileSync(file);
});
const truncated = bytes[0].subarray(0, bytes[0].length - 4);   // 少了 FFD9 结尾标记
const webpFile = path.join(temp, 'webp-source.webp');
shoot(webpFile, 'yellow');
const webpBytes = fs.readFileSync(webpFile);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === `/share/video/${VIDEO_ID}/`) {
    const item = {
      aweme_id: VIDEO_ID,
      desc: '测试图文作品。\n第二句不该出现在目录名里，用来验证只取标题第一句',
      images: names.map((_, i) => ({ url_list: [`${CDN}/img/${i + 1}.jpg`] })),
    };
    const data = JSON.stringify({ loaderData: { page: { item_list: [item] } } });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<html><script>window._ROUTER_DATA = ${data}</script></html>`);
  }
  const match = url.pathname.match(/^\/img\/(\d)\.jpg$/);
  if (match) {
    const index = Number(match[1]) - 1;
    if (mode === 'notimage') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>nope</html>'); }
    if (mode === 'webp') { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(webpBytes); }
    if (mode === 'flaky') {   // 第 2 张第一次返回 503，重试后应成功
      flakyHits[index] = (flakyHits[index] || 0) + 1;
      if (index === 1 && flakyHits[index] === 1) { res.writeHead(503); return res.end('busy'); }
    }
    if (mode === 'truncated' && index === 0) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(truncated); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(bytes[index]);
  }
  res.writeHead(404);
  res.end();
});

const realFetch = globalThis.fetch;
function mapped(value) {
  if (String(value).startsWith(`https://www.iesdouyin.com/share/video/${VIDEO_ID}/`)) return `http://127.0.0.1:${port}/share/video/${VIDEO_ID}/`;
  const match = String(value).match(/^https:\/\/p3-sign\.douyinpic\.com\/img\/(\d)\.jpg$/);
  if (match) return `http://127.0.0.1:${port}/img/${match[1]}.jpg`;
  return '';
}
globalThis.fetch = async (url, options) => {
  const target = mapped(url);
  if (!target) throw new Error('测试出现未预期的请求：' + url);
  return realFetch(target, options);
};

const app = require('../server');

async function settled(job) {
  for (let i = 0; i < 400 && job.status === 'running'; i++) await delay(50);
  assert.notStrictEqual(job.status, 'running', '图文任务超时');
  return job;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const link = `https://www.douyin.com/note/${VIDEO_ID}`;

  const job = await settled(app.newJob(link, path.join(temp, 'downloads')));
  assert.strictEqual(job.status, 'done', job.err);
  assert.strictEqual(job.isDirectory, true, '图文任务应记录目录');
  assert.match(job.note, /图文 · 3 张/);
  assert.strictEqual(path.basename(job.file), '测试图文作品', '子文件夹应直接用作品标题命名');
  assert.strictEqual(path.dirname(job.file), path.join(temp, 'downloads'), '子文件夹必须建在用户选定的保存目录内');
  const files = fs.readdirSync(job.file).sort();
  assert.deepStrictEqual(files, ['01.jpg', '02.jpg', '03.jpg'], '图片应按序号命名');
  for (const name of files) {
    const buffer = fs.readFileSync(path.join(job.file, name));
    assert.strictEqual(buffer[0], 0xff, 'JPEG 文件头不对');
    assert.strictEqual(buffer[buffer.length - 1], 0xd9, 'JPEG 缺少结尾标记');
  }

  const again = await settled(app.newJob(link, path.join(temp, 'downloads')));
  assert.strictEqual(again.status, 'done');
  assert.match(again.note, /此前已下载过/, '已存在的图集不应重复下载');

  // 同名目录里图片不全：另开一个带后缀的目录，既不覆盖也不混在一起。
  const partial = path.join(temp, 'partial');
  fs.mkdirSync(path.join(partial, '测试图文作品'), { recursive: true });
  fs.writeFileSync(path.join(partial, '测试图文作品', '01.jpg'), bytes[0]);
  const conflict = await settled(app.newJob(link, partial));
  assert.strictEqual(conflict.status, 'done', conflict.err);
  assert.match(path.basename(conflict.file), /^测试图文作品-/, '不完整同名目录应另建新目录');
  assert.strictEqual(fs.readdirSync(path.join(partial, '测试图文作品')).length, 1, '原有目录不能被覆盖');
  assert.strictEqual(fs.readdirSync(conflict.file).length, 3, '新目录应完整下载 3 张');

  mode = 'truncated';
  const broken = await settled(app.newJob(link, path.join(temp, 'truncated')));
  assert.strictEqual(broken.status, 'error', '缺结尾标记的图必须判失败');
  assert.match(broken.err, /不完整|无法识别/);
  assert.strictEqual(fs.readdirSync(path.join(temp, 'truncated')).filter(n => /\.jpg$/.test(n)).length, 0, '失败任务不应留下图片文件');

  mode = 'webp';
  const webpJob = await settled(app.newJob(link, path.join(temp, 'webpcase')));
  assert.strictEqual(webpJob.status, 'done', webpJob.err);
  assert.deepStrictEqual(fs.readdirSync(webpJob.file).sort(), ['01.jpg', '02.jpg', '03.jpg'], 'webp 图集应统一转成 jpg');
  const jpeg = fs.readFileSync(path.join(webpJob.file, '01.jpg'));
  assert.strictEqual(jpeg[0], 0xff, '转码结果应为 JPEG');
  assert.strictEqual(jpeg[jpeg.length - 1], 0xd9, '转码结果应有 JPEG 结尾');

  mode = 'flaky';
  const flakyJob = await settled(app.newJob(link, path.join(temp, 'flaky')));
  assert.strictEqual(flakyJob.status, 'done', flakyJob.err);
  assert.strictEqual(fs.readdirSync(flakyJob.file).length, 3, '单张图偶发失败应自动重试成功');

  mode = 'notimage';
  const wrong = await settled(app.newJob(link, path.join(temp, 'notimage')));
  assert.strictEqual(wrong.status, 'error', '非图片内容必须判失败');
  assert.match(wrong.err, /不是图片/);

  console.log('抖音图文测试通过：标题第一句作子目录名、图集解析、逐张下载、序号命名、webp 转 jpg、偶发失败自动重试、文件头与结尾校验、重复识别、同名不覆盖、损坏与非图片内容拒绝。');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  if (server.listening) server.close();
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('douyin-images-test-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});
