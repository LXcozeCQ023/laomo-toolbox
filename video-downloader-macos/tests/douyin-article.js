'use strict';
// 抖音文章（长文）回归：路由识别 → 标题清理 → 正文归一化 → 落盘结构。
// 这里不开浏览器：正文的 DOM 提取依赖真实页面，由 tests/browser-integration.js 那条
// 链路覆盖；本文件把能离线验证的部分锁死，改了不至于悄悄退化。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = require(path.resolve(__dirname, '..', 'server.js'));
const douyin = require(path.resolve(__dirname, '..', 'scripts', 'douyin-anonymous-resolver.js'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-article-test-'));
const ID = '7690770708850363690';

try {
  // 分享短链会 302 到 /article/<id>：认不出这条路由，连解析都进不去。
  assert.strictEqual(app.extractDouyinVideoId(`https://www.douyin.com/article/${ID}`), ID, 'article 路由要能取到编号');
  assert.strictEqual(app.extractDouyinVideoId(`https://www.douyin.com/article/${ID}?previous_page=web_code_link`), ID, '带查询参数也要认');
  assert.strictEqual(app.extractDouyinVideoId(`https://www.douyin.com/video/${ID}`), ID, 'video 路由不受影响');
  assert.strictEqual(app.extractDouyinVideoId(`https://www.douyin.com/note/${ID}`), ID, 'note 路由不受影响');
  assert.strictEqual(app.extractDouyinVideoId(`https://www.douyin.com/user?modal_id=${ID}`), ID, 'modal_id 不受影响');
  assert.strictEqual(app.extractDouyinVideoId('https://www.douyin.com/article/123'), '', '编号长度不对不该认');

  assert.strictEqual(douyin.ARTICLE_PATH_RE.test('/article/7690770708850363690'), true, '文章路由应被识别');
  assert.strictEqual(douyin.ARTICLE_PATH_RE.test('/video/7690770708850363690'), false, '视频路由不该被当成文章');

  // <title> 形如「标题 #话题1 #话题2 - 抖音」
  assert.strictEqual(
    douyin.articleTitle('今天，我决定开源「AI Hot」 #开源 #抖音前沿科技首发计划 #数字生命卡兹克 - 抖音'),
    '今天，我决定开源「AI Hot」',
  );
  assert.strictEqual(douyin.articleTitle('一个没有话题的标题 - 抖音'), '一个没有话题的标题');
  assert.strictEqual(douyin.articleTitle('只有话题 #a #b'), '只有话题');

  // 页面 innerText 夹着零宽字符、行内多余空格、连续空行
  assert.strictEqual(
    douyin.normalizeArticleText('第一段\u200b\n\n\n\n第二段   有   空格\n\n第三段\r\n'),
    '第一段\n\n第二段 有 空格\n\n第三段',
  );

  // 落盘：按标题第一句建子目录，正文.txt 带标题、日期和来源行
  const job = app.newJob('https://v.douyin.com/p793MQKyjiM/', path.join(temp, 'out'));
  app.saveDouyinArticle(job, {
    kind: 'article',
    title: '今天，我决定开源「AI Hot」。后面这句不该进目录名',
    date: '2026-09-29',
    text: '第一段。\n\n第二段。',
    sourceUrl: `https://www.douyin.com/article/${ID}`,
  });
  assert.strictEqual(job.status, 'done', '文章应直接判完成');
  assert.strictEqual(job.pct, 100);
  assert.strictEqual(job.isDirectory, true);
  assert.strictEqual(job.name, '今天，我决定开源「AI Hot」', '目录名取标题第一句');
  const body = fs.readFileSync(path.join(job.file, '正文.txt'), 'utf8');
  assert.match(body, /^今天，我决定开源「AI Hot」/, '正文稿应以标题开头');
  assert.match(body, /2026-09-29/);
  assert.match(body, /第一段。\n\n第二段。/);
  assert.match(body, /来源：https:\/\/www\.douyin\.com\/article\/7690770708850363690/, '末尾要留来源');
  assert.match(job.note, /文章 ·/);

  // 没有标题时的兜底目录名不能跟图集撞
  assert.strictEqual(app.douyinFolderName('', '抖音文章'), '抖音文章');
  assert.strictEqual(app.douyinFolderName('', undefined), '抖音图文', '图集的兜底名不该被改掉');

  // 「allocator multiple times」是 Chrome 正常启动也会打印的噪声，不该再被解读成
  // 「启动参数被外部环境干扰」——实测那条提示把排查方向带偏过。
  assert.strictEqual(douyin.browserDiagnosis('allocator multiple times'), '', '启动噪声不该给出误导性结论');
  assert.match(douyin.browserDiagnosis('Failed to initialize sandbox.'), /--no-sandbox/, '沙箱失败的提示要保留');

  // 抖音解析刻意不再走代理：代理端口漂移时把失效地址交给 Chrome 会卡死导航。
  assert.strictEqual(douyin.chromeArgs('/tmp/p', '', false).includes('--proxy-server='), false);
  assert.strictEqual(douyin.chromeArgs('/tmp/p', '', false).some((a) => a.startsWith('--proxy-server')), false, '没有代理时不该带任何代理参数');

  console.log('抖音文章测试通过：article 路由识别、标题清理、正文归一化、按标题建子目录落盘、来源行、兜底目录名、启动日志不再误导归因。');
} finally {
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('douyin-article-test-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
