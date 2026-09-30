'use strict';
// 手机上分享出来的文案：有的带链接，有的链接被聊天软件吃掉只剩域名，
// 有的干脆只有一串 App 口令。这里验证三种情况分别怎么处理。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = require('../server');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-share-text-'));

const WITH_LINK = '9.94 msh:/ 复制打开抖音，看看【老默的作品】AI短剧 https://v.douyin.com/iRNBxrTL/ 复制此链接，打开Dou音搜索，直接观看视频！';
const NO_SCHEME = '打开抖音看看 v.douyin.com/iRNBxrTL/ 复制此链接';
const CODE_ONLY = '1:/ 04/03 I@i.ca :5pm 【AI短剧，就是一场耗材狂欢】长按复制打开抖音，即可阅读文章 ※※0v7XzW044zi8a9ˇˇ';

(async () => {
  // 1. 正常的分享文案：把链接挑出来，尾巴上的中文标点要去掉。
  assert.strictEqual(app.extractUrl(WITH_LINK), 'https://v.douyin.com/iRNBxrTL/', '应取出完整短链');

  // 2. http:// 被吃掉：只剩裸域名时补回去。
  assert.strictEqual(app.extractUrl(NO_SCHEME), '', '没有协议头时 extractUrl 取不到');
  assert.strictEqual(app.recoverUrl(NO_SCHEME), 'https://v.douyin.com/iRNBxrTL/', '裸域名应补成 https');

  // 3. 只有口令：取不到链接，但必须给出能照做的提示，而不是含糊地失败。
  assert.strictEqual(app.extractUrl(CODE_ONLY), '', '口令文案里没有链接');
  assert.strictEqual(app.recoverUrl(CODE_ONLY), '', '口令文案里也没有裸域名');
  const hint = app.shareTextHint(CODE_ONLY);
  assert.ok(hint, '口令文案必须给出提示');
  assert.match(hint, /复制链接/, '提示要说清楚怎么拿到链接');
  assert.match(hint, /口令/, '提示要点明这是口令');
  // 不是抖音的东西不要乱提示
  assert.strictEqual(app.shareTextHint('https://www.bilibili.com/video/BV1xx'), '', '普通链接不该触发口令提示');

  // 4. 正文文字稿：有文案才写，空文案不产生垃圾文件。
  const dir = path.join(temp, '作品');
  fs.mkdirSync(dir, { recursive: true });
  const written = app.saveDouyinText(dir, '正文.txt', { text: '  第一行。\r\n第二行。\n\n\n\n第三行。  ' });
  assert.strictEqual(path.basename(written), '正文.txt');
  assert.strictEqual(fs.readFileSync(written, 'utf8'), '第一行。\n第二行。\n\n第三行。\n', '正文要去空白、统一换行、压掉连续空行');
  assert.strictEqual(app.saveDouyinText(dir, '空.txt', { text: '   ' }), '', '空文案不该生成文件');
  assert.strictEqual(app.saveDouyinText(dir, '空.txt', {}), '', '没有文案字段不该生成文件');

  console.log('分享文案测试通过：带链接的取出链接、裸域名补协议、口令文案给出可照做的提示、正文文字稿落盘且空文案不产生文件。');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  if (!path.basename(temp).startsWith('douyin-share-text-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});
