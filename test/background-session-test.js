'use strict';

function storageArea(seed) {
  const data = { ...(seed || {}) };
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      const out = {};
      for (const key of keys) out[key] = data[key];
      return out;
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    data
  };
}

let messageListener;
let tabRemovedListener;
const local = storageArea({ mcqSettings: { apiKey: 'test' } });
const session = storageArea();

global.chrome = {
  storage: { local, session },
  runtime: {
    lastError: undefined,
    onMessage: { addListener(fn) { messageListener = fn; } },
    onInstalled: { addListener() {} }
  },
  tabs: {
    sendMessage() { return Promise.resolve(); },
    onRemoved: { addListener(fn) { tabRemovedListener = fn; } }
  }
};

require('../background.js');

function send(message, sender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout: ' + message.type)), 1000);
    const result = messageListener(message, sender, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    if (result !== true) {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

(async () => {
  const top = { tab: { id: 7 }, frameId: 0, url: 'https://quiz.example/q1' };
  const child = { tab: { id: 7 }, frameId: 3, url: 'https://embed.example/question' };
  const stranger = { tab: { id: 7 }, frameId: 4, url: 'https://ads.example/banner' };
  const checks = [];
  const check = (name, ok) => checks.push([name, !!ok]);

  let res = await send({ type: 'MCQ_SESSION_GET' }, top);
  check('初始没有恢复会话', res && res.session === null);

  res = await send({ type: 'MCQ_SESSION_BEGIN' }, top);
  check('顶层页面能建立标签页会话', res && res.session && res.session.active && res.session.done.length === 0);
  check('普通启动会话明确标记auto模式', res.session.kind === 'auto');

  await send({ type: 'MCQ_SESSION_PROGRESS', payload: { done: ['q1'] } }, top);
  res = await send({ type: 'MCQ_SESSION_GET' }, { ...top, url: 'https://quiz.example/q2' });
  check('顶层页面跨 URL 恢复并保留 hash', res && res.session && res.session.done[0] === 'q1');

  res = await send({ type: 'MCQ_SESSION_GET' }, stranger);
  check('无关 iframe 不会自动恢复', res && res.session === null);

  await send({ type: 'MCQ_SESSION_PROGRESS', payload: { done: ['q2'] } }, child);
  res = await send({ type: 'MCQ_SESSION_GET' }, { ...child, frameId: 9, url: 'https://embed.example/feedback' });
  check('参与答题的 iframe 可按 origin 恢复', res && res.session && res.session.done.length === 2);

  res = await send({ type: 'MCQ_SESSION_END', payload: { manual: false } }, stranger);
  check('无关 iframe 不能结束会话', res && res.removed === false);

  res = await send({ type: 'MCQ_SESSION_END', payload: { manual: true } }, stranger);
  check('用户手动停止会清除整个标签页会话', res && res.removed === true);

  await send({ type: 'MCQ_SESSION_BEGIN' }, top);
  tabRemovedListener(7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  res = await send({ type: 'MCQ_SESSION_GET' }, top);
  check('关闭标签页会清理恢复状态', res && res.session === null);

  res = await send({ type: 'MCQ_SESSION_BEGIN', payload: { kind: 'highlight' } }, top);
  check('快捷键进入测验可保存highlight会话', res.session.kind === 'highlight' && res.session.active);
  await send({ type: 'MCQ_SESSION_PROGRESS', payload: { done: [] } }, top);
  res = await send({ type: 'MCQ_SESSION_GET' }, { ...top, url: 'https://quiz.example/first-question' });
  check('跳转及更新不会把高亮会话升级为auto', res.session.kind === 'highlight');
  res = await send({ type: 'MCQ_SESSION_BEGIN' }, top);
  check('再次手动启动恢复普通auto会话', res.session.kind === 'auto');

  const failed = checks.filter((item) => !item[1]);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  console.log(`background-session-test: ${checks.length - failed.length}/${checks.length}`);
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
