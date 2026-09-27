'use strict';
// 代理自愈回归：锁定的代理端口一旦失效，必须重新探测，不能继续拿它当出口。
// 起因：工具启动时把探测到的代理锁在内存里，之后 Clash 换端口（原先 7890，重启后
// 探到 7891，随后 7891 又被关掉），死地址让所有抖音请求一路卡到超时——用户看到
// 的就是「今天所有链接都失败」。这里用本机基本不会被监听的 9 号端口冒充死代理。
const assert = require('assert');
const net = require('net');

const DEAD = 'http://127.0.0.1:9'; // 9 = discard，正常机器上没人监听

// 关键：在 require 之前写进环境变量，复现「宿主会话留下的代理被锁死」这条路径。
process.env.HTTPS_PROXY = DEAD;
process.env.HTTP_PROXY = DEAD;

const app = require('../server');

function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function probe(url) {
  return new Promise((resolve) => app.proxyAlive(url, resolve));
}

function detect() {
  return new Promise((resolve) => app.detectProxy(resolve));
}

let server;

(async () => {
  server = await listen();
  const live = `http://127.0.0.1:${server.address().port}`;

  // 1. 探活本身：有监听判存活，没人监听或地址写法不对判失效。
  assert.strictEqual(await probe(live), true, '有监听的端口应判为存活');
  assert.strictEqual(await probe(DEAD), false, '没人监听的端口应判为失效');
  assert.strictEqual(await probe(''), false, '空地址应判为失效');
  assert.strictEqual(await probe('这不是代理地址'), false, '无法解析的地址应判为失效');
  assert.strictEqual(await probe('socks5://127.0.0.1:9'), false, 'socks5 写法同样要能探');

  // 2. 锁定的死代理必须被换掉。旧实现（if (ACTIVE_PROXY) return cb(ACTIVE_PROXY)）会
  //    原样返回死地址，这一步就会失败——这正是本次要防住的回归。
  const found = await detect();
  assert.notStrictEqual(found, DEAD, '锁定的死代理必须重新探测，不能原样返回');
  assert.ok(found === '' || /^https?:\/\/127\.0\.0\.1:\d+$|^socks5:\/\/127\.0\.0\.1:\d+$/.test(found), '重新探测的结果必须是候选里的地址或空');

  // 3. 重新探测到活代理时，下游（内置 fetch、yt-dlp 子进程）读的环境变量要跟着换；
  //    一个都找不到时必须把死地址清掉，否则请求仍会被带进黑洞。
  process.env.HTTPS_PROXY = DEAD;
  process.env.HTTP_PROXY = DEAD;
  const applied = await app.ensureProxy();
  assert.strictEqual(app.getActiveProxy(), applied, 'ensureProxy 后进程内地址应与返回一致');
  assert.notStrictEqual(applied, DEAD, 'ensureProxy 不能把死代理留下');
  if (applied) {
    assert.strictEqual(process.env.HTTPS_PROXY, applied, '活代理要同步进环境变量');
    assert.strictEqual(process.env.HTTP_PROXY, applied, '活代理要同步进环境变量');
  } else {
    assert.strictEqual(process.env.HTTPS_PROXY, undefined, '没有可用代理时应清掉环境变量里的死地址');
    assert.strictEqual(process.env.HTTP_PROXY, undefined, '没有可用代理时应清掉环境变量里的死地址');
  }

  // 4. 已经确认可用的代理要稳定复用，不能每次任务都抖动换地址。
  assert.strictEqual(await app.ensureProxy(), applied, '存活的代理应被稳定复用');

  console.log('代理自愈测试通过：端口探活（http/socks5/非法地址）、锁定的死代理会被重新探测、环境变量同步、活代理稳定复用。');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => { if (server) server.close(); });
