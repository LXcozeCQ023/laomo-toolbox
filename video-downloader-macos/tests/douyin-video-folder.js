'use strict';
// 抖音视频落盘回归：视频 + 文案要放进同一个「标题 [编号]」子文件夹，
// 并且旧版本摊在保存目录里的那对文件要被顺手收进去（而不是重下一遍）。
// 只跑文件系统，不发网络请求、不开浏览器。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const app = require(path.join(root, 'server.js'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-video-folder-test-'));
const TITLE = '为什么你生成的打斗画面这么帅';
const ID = '7684165894347443471';
const STEM = `${TITLE} [${ID}]`;
const info = { title: TITLE, id: ID };

function workdir(name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 造一个画面 + 声音都齐全的 mp4，好让 fileIsComplete 判为“下完整了”。
function realMp4(file) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(result.status, 0, result.stderr);
  return file;
}

try {
  assert.strictEqual(app.fileIsComplete(path.join(temp, '不存在.mp4')), false, '文件不存在应判未完成');

  // ① 首次下载：位置就在新建的「标题 [编号]」文件夹里，别散在保存目录里。
  {
    const dir = workdir('first');
    const plan = app.planDouyinVideoTarget(dir, info, 'abcd1234');
    assert.strictEqual(plan.stem, STEM);
    assert.strictEqual(plan.folder, path.join(dir, STEM));
    assert.strictEqual(plan.mainVideo, path.join(dir, STEM, `${STEM}.mp4`), 'mp4 要落在子文件夹里');
    assert.strictEqual(plan.videoFile, plan.mainVideo);
    assert.strictEqual(plan.done, false);
    assert.strictEqual(plan.migrated, false);
  }

  // ② 旧版本散落在保存目录里的 mp4 + 文案：收进文件夹、判为「已下载过」，不重下。
  {
    const dir = workdir('legacy');
    realMp4(path.join(dir, `${STEM}.mp4`));
    fs.writeFileSync(path.join(dir, `${STEM}.txt`), '旧的文案\n');
    const plan = app.planDouyinVideoTarget(dir, info, 'abcd1234');
    assert.strictEqual(plan.done, true, '散落的完整 mp4 应被认成已下载过');
    assert.strictEqual(plan.migrated, true, '应记录发生了归档');
    assert.strictEqual(fs.existsSync(path.join(dir, `${STEM}.mp4`)), false, '保存目录里不该再留着散落的 mp4');
    assert.strictEqual(fs.existsSync(plan.mainVideo), true, 'mp4 应已收进文件夹');
    assert.strictEqual(
      fs.readFileSync(path.join(plan.folder, `${STEM}.txt`), 'utf8'), '旧的文案\n',
      '配套文案要跟着一起进文件夹',
    );
  }

  // ③ 已经在新文件夹里的完整视频：报「已下载过」，不重复归档。
  {
    const dir = workdir('done');
    const folder = path.join(dir, STEM);
    fs.mkdirSync(folder, { recursive: true });
    realMp4(path.join(folder, `${STEM}.mp4`));
    const plan = app.planDouyinVideoTarget(dir, info, 'abcd1234');
    assert.strictEqual(plan.done, true);
    assert.strictEqual(plan.migrated, false, '本来就在文件夹里就不算归档');
    assert.strictEqual(plan.folder, folder);
  }

  // ④ 文件夹里躺着上次没下完的同名残文件：换名字下，既不覆盖也不硬用。
  {
    const dir = workdir('partial');
    const folder = path.join(dir, STEM);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${STEM}.mp4`), 'not a video');
    const plan = app.planDouyinVideoTarget(dir, info, 'abcd1234');
    assert.strictEqual(plan.done, false, '半截文件不该被当成已完成');
    assert.strictEqual(plan.videoFile, path.join(folder, `${STEM}-abcd.mp4`), '应改名另存，不覆盖残文件');
  }

  // ⑤ 文案要写进文件夹里（跟 mp4 同一个目录），而不是保存目录根下。
  {
    const dir = workdir('text');
    const folder = path.join(dir, STEM);
    fs.mkdirSync(folder, { recursive: true });
    const file = app.saveDouyinText(folder, `${STEM}.txt`, { text: '这是作品文案。\n第二段。' });
    assert.strictEqual(file, path.join(folder, `${STEM}.txt`));
    assert.strictEqual(fs.existsSync(path.join(dir, `${STEM}.txt`)), false, '不该在保存目录根下另留一份');
  }

  console.log('抖音视频文件夹测试通过：按「标题 [编号]」建子文件夹放视频与文案、旧版散落文件自动归档不重下、已完成识别、半截文件改名另存、文案紧跟视频同目录。');
} finally {
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('douyin-video-folder-test-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
