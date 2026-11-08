const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  mode: 'submit',
  actionDelay: 700,
  submitDelay: 1500,
  pageTimeout: 8000,
  maxRounds: 50,
  concurrency: 2,
  useCache: true,
  extraPrompt: ''
};

const FIELDS = {
  apiKey: 'value',
  baseUrl: 'value',
  model: 'value',
  mode: 'value',
  actionDelay: 'number',
  submitDelay: 'number',
  pageTimeout: 'number',
  maxRounds: 'number',
  concurrency: 'number',
  useCache: 'checked',
  extraPrompt: 'value'
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function say(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function load() {
  const { mcqSettings } = await chrome.storage.local.get('mcqSettings');
  const s = { ...DEFAULTS, ...(mcqSettings || {}) };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (kind === 'checked') el.checked = !!s[key];
    else el.value = s[key];
  }
}

async function save() {
  const s = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (kind === 'checked') s[key] = el.checked;
    else if (kind === 'number') s[key] = Number(el.value) || DEFAULTS[key];
    else s[key] = el.value.trim();
  }
  if (!s.baseUrl) s.baseUrl = DEFAULTS.baseUrl;
  if (!s.model) s.model = DEFAULTS.model;
  await chrome.storage.local.set({ mcqSettings: s });
  return s;
}

for (const key of Object.keys(FIELDS)) {
  $(key).addEventListener('change', () => save());
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 给标签页发消息；内容脚本没注入过（插件刚装好、页面早就开着）就现场注入一次 */
async function tell(type) {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) {
    say('这个页面不支持注入脚本（chrome:// 等内部页面）', 'err');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content/overlay.css'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/detector.js', 'content/vision.js', 'content/solver.js']
      });
      return await chrome.tabs.sendMessage(tab.id, { type });
    } catch (e) {
      say('无法注入内容脚本：' + e.message, 'err');
      return null;
    }
  }
}

$('scan').onclick = async () => {
  await save();
  say('扫描中…');
  const res = await tell('MCQ_SCAN');
  if (res) say(`扫描到 ${res.count} 道题，详情看页面右下角面板`, 'ok');
};

$('run').onclick = async () => {
  const s = await save();
  if (!s.apiKey) return say('先填 API Key', 'err');
  const res = await tell('MCQ_START');
  if (res) {
    say('已启动，进度在页面右下角面板；按 Esc 可中断', 'ok');
    window.close();
  }
};

$('stop').onclick = async () => {
  const res = await tell('MCQ_STOP');
  if (res) say('已发送停止指令', 'ok');
};

$('reset').onclick = async () => {
  const res = await tell('MCQ_RESET');
  if (res) say('已清空本页去重记录，可重新作答', 'ok');
};

$('test').onclick = async () => {
  const s = await save();
  if (!s.apiKey) return say('先填 API Key', 'err');
  say('测试中…');
  const res = await chrome.runtime.sendMessage({ type: 'MCQ_TEST', payload: s });
  if (res.ok) say('连接正常 · 返回：' + res.sample, 'ok');
  else say('失败：' + res.error, 'err');
};

$('clearCache').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'MCQ_CLEAR_CACHE' });
  say(`已清除 ${res.removed} 条缓存`, 'ok');
};

(async () => {
  await load();
  const tab = await activeTab();
  try {
    $('host').textContent = new URL(tab.url).host;
  } catch (_) {}
})();
