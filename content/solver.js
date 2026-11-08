/**
 * 内容脚本主逻辑：扫描 -> 询问模型 -> 高亮/勾选 -> 校验 -> 提交/翻页 -> 等下一题 -> 循环。
 *
 * 针对「一页一题 + 提交按钮」做了专门优化：
 *   - 按钮打分时考虑与题目的位置关系，优先点题目下方最近的那颗
 *   - 提交前先确认选项真的被选中了（没选中不提交，避免交白卷）
 *   - 提交前等按钮从 disabled 变可用（很多站点选完才解锁提交）
 *   - 提交后轮询等待「新题目出现」，而不是靠 DOM 静默猜
 *   - 支持 提交 -> 对错反馈页 -> 下一题 的多段式流程（一轮内最多连点 4 次）
 *
 * 顶层 frame 负责渲染悬浮面板；子 frame 只干活，日志通过 background 转发到顶层。
 */
(function () {
  'use strict';
  if (window.__MCQ_SOLVER__) return;
  window.__MCQ_SOLVER__ = true;

  const D = window.__MCQ_DETECTOR__;
  const IS_TOP = window.top === window;

  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    mode: 'submit', // 'highlight' | 'select' | 'submit'
    actionDelay: 700,
    submitDelay: 1500,
    pageTimeout: 8000,
    maxRounds: 50,
    concurrency: 2,
    useCache: true,
    extraPrompt: ''
  };

  const state = {
    running: false,
    settings: { ...DEFAULTS },
    done: new Set(), // 已处理过的题目 hash
    stats: { asked: 0, answered: 0, failed: 0, rounds: 0, timeouts: 0 }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MODE_NAME = { highlight: '仅高亮', select: '自动选中 / 填写', submit: '自动选中 / 填写并提交' };

  // 答案标记留在元素上，仅在按住 Ctrl + Alt + P 时启用样式。
  // 不存入会话：刷新后的页面始终从隐藏状态开始。
  let pHeld = false;
  let chordHeld = false;
  let answersVisible = false;
  let panelHidden = false;
  const highlightAnswers = new Map();
  const selectHints = new WeakMap();
  let highlightTask = null;
  let highlightRequested = false;
  let highlightEpoch = 0;
  let highlightTaskEpoch = 0;
  let highlightSnapshot = '';
  let highlightEntrySession = false;
  let highlightNavigationPending = false;
  const highlightStatus = { phase: 'idle', answered: 0, error: '' };
  let onePickTask = null;
  let onePickEpoch = 0;
  let onePickKeyHeld = false;
  let imagePickBusy = false;
  let queuedImagePicks = 0;
  const pickIds = new WeakMap();
  let pickSeq = 0;
  const answerRequests = new Map();
  let connectChoiceQueue = Promise.resolve();
  const onePickCompleted = new Map();
  const onePickStatus = { phase: 'idle', hash: '', letter: '', error: '', checked: 0, corrected: 0, failed: 0 };
  const CANVAS_CACHE_SELECTOR = '.question.multiple_choice_question, .question.multiple_answers_question, .question.true_false_question, .question.numerical_question, .question.calculated_question, .question.matching_question';
  const canvasCache = new Map();
  const dirtyCanvas = new Set();
  const scanStats = { fullScans: 0, canvasParses: 0, cacheHits: 0 };
  const ownMarkClasses = new Set(['__mcq_pick', '__mcq_pick_warn', '__mcq_scan', '__mas_answers_visible']);

  function invalidateCanvas(records) {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || target.closest('#__mcq_panel_host')) continue;
      if (record.type === 'attributes' && record.attributeName === 'class') {
        const strip = value => String(value || '').split(/\s+/).filter(token => token && !ownMarkClasses.has(token)).join(' ');
        if (strip(record.oldValue) === strip(target.getAttribute('class'))) continue;
      }
      const container = target.closest(CANVAS_CACHE_SELECTOR);
      if (container) dirtyCanvas.add(container);
      else if (record.type === 'attributes') target.querySelectorAll(CANVAS_CACHE_SELECTOR).forEach(node => dirtyCanvas.add(node));
    }
  }
  const canvasObserver = new MutationObserver(invalidateCanvas);
  canvasObserver.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-disabled', 'aria-hidden', 'aria-label', 'aria-labelledby', 'type', 'name', 'for', 'id', 'value', 'role', 'src', 'srcset', 'width', 'height']
  });
  window.addEventListener('resize', () => canvasCache.forEach((_, container) => dirtyCanvas.add(container)));

  function cachedCanvasQuestions(container) {
    invalidateCanvas(canvasObserver.takeRecords());
    if (container.querySelector('canvas')) dirtyCanvas.add(container); // canvas绘图不会触发DOM observer
    if (!canvasCache.has(container) || dirtyCanvas.has(container)) {
      scanStats.canvasParses++;
      canvasCache.set(container, D.collect(container, { includeReadOnly: true }).filter(q => q.container === container));
      dirtyCanvas.delete(container);
    } else scanStats.cacheHits++;
    const questions = canvasCache.get(container);
    for (const q of questions) {
      const inputs = q.answerSelect ? [q.answerSelect] : q.type === 'numeric' ? [q.answerInput].filter(Boolean) : q.options.map(o => o.input).filter(Boolean);
      q.readOnly = inputs.some(input => input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true');
    }
    return questions;
  }

  function collectEfficiently(opts) {
    invalidateCanvas(canvasObserver.takeRecords());
    const containers = Array.from(document.querySelectorAll(CANVAS_CACHE_SELECTOR));
    if (!containers.length || document.querySelector('.question-area[id^="matchingType"], awd-probe .awd-probe-type-fill_in_the_blank, .worksheet__main iframe.external[title="Assessment Tool iFrame"]')) {
      canvasCache.clear(); dirtyCanvas.clear();
      scanStats.fullScans++;
      return D.collect(document, opts);
    }
    for (const node of canvasCache.keys()) if (!node.isConnected || !node.matches(CANVAS_CACHE_SELECTOR)) canvasCache.delete(node);
    for (const node of dirtyCanvas) if (!node.isConnected) dirtyCanvas.delete(node);
    return containers.flatMap(cachedCanvasQuestions).filter(q => opts?.includeReadOnly || !q.readOnly);
  }

  function liveQuestion(q) {
    const matches = q.container.isConnected && q.container.matches(CANVAS_CACHE_SELECTOR)
      ? cachedCanvasQuestions(q.container)
      : collectEfficiently({ includeReadOnly: true });
    const valid = matches.filter(item => item.hash === q.hash && !item.incomplete);
    return valid.find(item => item.container === q.container) || (valid.length === 1 ? valid[0] : null);
  }

  function cancelOnePick() {
    onePickEpoch++;
    onePickKeyHeld = false;
    queuedImagePicks = 0;
    if (onePickTask) onePickStatus.phase = 'cancelled';
  }

  function pickKey(q) {
    const control = q.answerSelect || q.container;
    if (!pickIds.has(control)) pickIds.set(control, ++pickSeq);
    return q.hash + ':' + pickIds.get(control);
  }

  function prefetchNextImage(questions, q, epoch, settings) {
    if (!settings?.apiKey || epoch !== onePickEpoch || document.hidden) return;
    const next = questions.slice(questions.indexOf(q) + 1).find(item => !onePickCompleted.has(pickKey(item)));
    // 只预取紧邻的下一道图片题，最多一个；不扫描整页并批量请求模型。
    if (!next?.visuals?.length || highlightAnswers.has(next.hash)) return;
    ask(next).then(result => {
      if (epoch === onePickEpoch && validMcqAnswer(next, result) && liveQuestion(next)) highlightAnswers.set(next.hash, result);
    }).catch(() => {}); // 预取失败由该题真正收到按键时重试，不阻塞当前题。
  }

  function pickableMcq(q) {
    return !q.readOnly && !q.incomplete && !q.answerCell && (!q.answerSelect || q.container.matches('.question.matching_question')) &&
      (q.type === 'single' || q.type === 'multi') && q.options.length >= 2;
  }

  function questionsForOnePick() {
    let questions = collectEfficiently().filter(pickableMcq);
    const canvas = questions.filter(q => q.container.matches('.question.multiple_choice_question, .question.multiple_answers_question, .question.true_false_question, .question.matching_question'));
    if (canvas.length) questions = canvas;
    // 检测器已按 DOM 题目顺序排序；连续按快捷键始终从上到下推进。
    return questions;
  }

  function validMcqAnswer(q, result) {
    return result?.ok && Array.isArray(result.letters) && result.letters.length > 0 &&
      (q.type !== 'single' || result.letters.length === 1) &&
      result.letters.every(letter => q.options.some(o => o.letter === letter && !o.unavailable));
  }

  async function checkAllMcq(questions, epoch, settings) {
    Object.assign(onePickStatus, { phase: 'checking', checked: 0, corrected: 0, failed: 0, error: '' });
    for (const q of questions) {
      if (epoch !== onePickEpoch || document.hidden) return;
      try {
        let result = highlightAnswers.get(q.hash);
        if (!result) {
          if (!settings?.apiKey) throw new Error('缺少答案缓存及 API Key');
          result = await ask(q);
        }
        if (epoch !== onePickEpoch) return;
        if (!validMcqAnswer(q, result)) throw new Error('没有可用答案，跳过该题');
        let current = liveQuestion(q);
        if (!current || !pickableMcq(current)) throw new Error('题目已变化，跳过该题');
        const wanted = new Set(result.letters);
        const wrong = current.options.filter(o => isSelected(o) !== wanted.has(o.letter));
        if (wrong.length) {
          // 原生radio选中正确项会自动取消同组错误项；checkbox须同时去掉多勾项。
          const changes = current.type === 'single' ? current.options.filter(o => wanted.has(o.letter)) : wrong;
          for (const option of changes) {
            if (epoch !== onePickEpoch || document.hidden) return;
            current = liveQuestion(q);
            if (!current || !pickableMcq(current) || !option.clickTarget.isConnected || isDisabled(option.input || option.clickTarget)) throw new Error('选项已不可用');
            const checked = wanted.has(option.letter);
            if (isSelected(option) === checked) continue;
            if (option.selectOption) {
              await clickOption(option, () => epoch === onePickEpoch && !document.hidden);
            } else if (option.input) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
              setter.call(option.input, checked);
              option.input.dispatchEvent(new Event('input', { bubbles: true }));
              option.input.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              if (isSelected(option) === null) throw new Error('无法验证自定义选项状态');
              realClick(option.clickTarget);
            }
          }
          await sleep(0); // 让站点受控组件更新，也让页面响应Esc和绘制。
          if (epoch !== onePickEpoch) return;
          current = liveQuestion(q);
          if (!current || !pickableMcq(current) || !current.options.every(o => isSelected(o) === wanted.has(o.letter))) throw new Error('修正未生效，请手动检查该题');
          onePickStatus.corrected++;
        }
        highlightAnswers.set(q.hash, result);
        onePickCompleted.set(pickKey(current), result.letters.slice());
        onePickStatus.checked++;
      } catch (error) {
        if (epoch !== onePickEpoch) return;
        onePickStatus.failed++;
        onePickStatus.error = String(error.message || error);
      }
      if ((onePickStatus.checked + onePickStatus.failed) % 8 === 0) await sleep(0);
    }
    if (epoch === onePickEpoch) onePickStatus.phase = onePickStatus.failed ? 'error' : 'checked';
  }

  // 一次快捷键只选择一个正确选项，独立于保存的自动提交模式。
  function pickOneMcq() {
    if (onePickTask) {
      // 图片等待期间的独立按键保留少量意图；长按repeat由键盘层过滤。
      if (imagePickBusy) queuedImagePicks = Math.min(4, queuedImagePicks + 1);
      return onePickTask;
    }
    setPanelHidden(true);
    if (state.running) stop('切换到单项选择快捷键', true);
    const questions = questionsForOnePick();
    const q = questions.find(item => !onePickCompleted.has(pickKey(item)));
    if (!questions.length) {
      Object.assign(onePickStatus, { phase: 'idle', hash: '', letter: '', error: '没有可选择的未完成MCQ题目' });
      return Promise.resolve();
    }
    const epoch = onePickEpoch;
    imagePickBusy = !!q?.visuals?.length;
    Object.assign(onePickStatus, { phase: 'loading', hash: q?.hash || '', letter: '', error: '', checked: 0, corrected: 0, failed: 0 });
    onePickTask = (async () => {
      // 清除旧自动流程的跨页续跑状态，避免手动选择后下一页又恢复自动提交。
      await runtimeRequest({ type: 'MCQ_SESSION_END', payload: { manual: true } });
      const { mcqSettings } = await chrome.storage.local.get('mcqSettings');
      if (epoch !== onePickEpoch) return;
      if (!q) return checkAllMcq(questions, epoch, mcqSettings);
      prefetchNextImage(questions, q, epoch, mcqSettings);
      let result = highlightAnswers.get(q.hash);
      if (!result) {
        if (!mcqSettings?.apiKey) throw new Error('请先在插件设置中填写 API Key');
        result = await ask(q);
      }
      if (epoch !== onePickEpoch) return;
      if (!validMcqAnswer(q, result)) {
        throw new Error(result.error || '模型没有给出可用的正确选项');
      }
      const current = liveQuestion(q);
      if (!current || !pickableMcq(current)) throw new Error('题目已变化，请在新题上再次按快捷键');
      highlightAnswers.set(q.hash, result);
      const option = current.options.find(o => result.letters.includes(o.letter) && isSelected(o) !== true);
      if (option) {
        const canClick = () => epoch === onePickEpoch && !document.hidden && option.clickTarget.isConnected &&
          !isDisabled(option.input || option.clickTarget) &&
          (() => { const live = liveQuestion(current); return live && pickableMcq(live); })();
        await clickOption(option, canClick);
        if (epoch !== onePickEpoch) return;
        if (!canClick() || isSelected(option) !== true) throw new Error('选中状态未生效，请手动检查该题');
        onePickStatus.letter = option.letter;
      } else {
        onePickStatus.letter = result.letters.join(',');
      }
      if (result.letters.every(letter => isSelected(current.options.find(o => o.letter === letter)) === true)) {
        onePickCompleted.set(pickKey(current), result.letters.slice());
      }
      onePickStatus.phase = 'selected';
    })().catch(error => {
      if (epoch !== onePickEpoch) return;
      queuedImagePicks = 0;
      onePickStatus.phase = 'error';
      onePickStatus.error = String(error.message || error);
    }).finally(() => {
      onePickTask = null;
      imagePickBusy = false;
      if (epoch === onePickEpoch && queuedImagePicks && onePickStatus.phase === 'selected') {
        queuedImagePicks--;
        pickOneMcq();
      }
    });
    return onePickTask;
  }

  function setPanelHidden(hidden) {
    panelHidden = hidden;
    if (panel) {
      if (hidden) panel.host.style.setProperty('display', 'none', 'important');
      else panel.host.style.removeProperty('display');
    }
  }

  function disclosedReviewAnswer(q) {
    if (!q.readOnly || q.type === 'numeric' || q.type === 'text') return null;
    const letters = q.options.filter(o => {
      const row = o.clickTarget.closest('.answer');
      return row && q.container.contains(row) && row.classList.contains('correct_answer');
    }).map(o => o.letter);
    return letters.length ? { ok: true, letters, confidence: 1, reason: 'Canvas 已公开的正确答案' } : null;
  }

  async function enterHighlightAssessment(settings, epoch) {
    const button = findAdvanceButton(null, { excludeChrome: true, onlyStart: true });
    if (!button) return;
    if (!settings?.apiKey || isDisabled(button.el)) {
      highlightStatus.error = !settings?.apiKey ? '请先在插件设置中填写 API Key' : 'Get Started 按钮尚未启用';
      return;
    }
    const saved = await runtimeRequest({ type: 'MCQ_SESSION_BEGIN', payload: { kind: 'highlight' } });
    if (!saved?.ok) {
      highlightStatus.error = '无法保存刷新后的高亮续跑状态，请重新加载插件';
      return;
    }
    highlightEntrySession = true;
    if (epoch !== highlightEpoch) return;
    highlightNavigationPending = clickForNavigation(button.el);
    if (highlightNavigationPending) return; // 原生表单导航：保留会话，交给新文档恢复。
    const deadline = performance.now() + Math.max(1000, Number(settings.pageTimeout) || DEFAULTS.pageTimeout);
    while (epoch === highlightEpoch && performance.now() < deadline) {
      if (D.collect(document, { includeReadOnly: true }).length) {
        highlightRequested = true;
        return;
      }
      await sleep(100);
    }
    highlightStatus.error = '点击 Get Started 后未发现题目';
  }

  // 快捷键独立于自动选中/提交流程；不建立续跑会话、不写答案、不显示日志窗口。
  async function prepareHighlights() {
    if (D.isDelegatedConnectFrame?.()) return Promise.resolve();
    setPanelHidden(true);
    if (state.running) stop('切换到快捷键高亮', true);
    const refreshEpoch = highlightEpoch;
    await D.refreshConnectChoices?.();
    if (refreshEpoch !== highlightEpoch) return;
    const questions = collectEfficiently({ includeReadOnly: true }).filter(q => !q.incomplete);
    const snapshot = questions.map(q => q.hash).join('|');
    if (highlightTask) {
      if (snapshot !== highlightSnapshot || highlightTaskEpoch !== highlightEpoch) highlightRequested = true;
      return highlightTask;
    }
    highlightRequested = false;
    const epoch = highlightEpoch;
    highlightTaskEpoch = epoch;
    highlightSnapshot = snapshot;
    highlightTask = (async () => {
      highlightStatus.phase = 'loading';
      highlightStatus.answered = 0;
      highlightStatus.error = '';
      const { mcqSettings } = await chrome.storage.local.get('mcqSettings');
      if (epoch !== highlightEpoch) return;
      if (!questions.length) {
        await enterHighlightAssessment(mcqSettings, epoch);
        return;
      }
      const queue = questions.slice();
      const workers = Math.min(6, Math.max(1, Number(mcqSettings?.concurrency) || DEFAULTS.concurrency));
      await Promise.all(Array.from({ length: workers }, async () => {
        while (queue.length && epoch === highlightEpoch) {
          const q = queue.shift();
          try {
            if (q.readOnly && !disclosedReviewAnswer(q)) continue;
            if (!q.readOnly && !mcqSettings?.apiKey) {
              highlightStatus.error = '请先在插件设置中填写 API Key';
              continue;
            }
            const res = q.readOnly ? disclosedReviewAnswer(q) : highlightAnswers.get(q.hash) || await ask(q);
            if (epoch !== highlightEpoch) return;
            const valid = res.ok && (q.type === 'text' ? textValues(q, res.values) !== null : q.type === 'numeric'
              ? numericValue(res.value) !== null
              : Array.isArray(res.letters) && res.letters.length > 0 && (!(q.answerSelect || q.answerCell) || res.letters.length === 1) && res.letters.every(letter => q.options.some(o => o.letter === letter && !o.unavailable)));
            if (!valid) {
              highlightStatus.error = res.error || '模型没有给出可用答案';
              continue;
            }
            highlightAnswers.set(q.hash, res);
            // 请求期间 SPA 可能换题或替换控件，只标记当前 DOM 中仍匹配的题目。
            const current = liveQuestion(q);
            if (!current || current.readOnly && !disclosedReviewAnswer(current)) continue;
            // 回顾页使用当前 DOM 公布的答案，避免同题状态改变后套用旧模型答案。
            const answer = current.readOnly ? disclosedReviewAnswer(current) : res;
            clearMarks(current);
            mark(current, answer.letters || [], typeof answer.confidence === 'number' && answer.confidence < 0.5, answer.values, answer.value);
            highlightStatus.answered++;
          } catch (error) {
            highlightStatus.error = String(error.message || error);
          }
        }
      }));
    })().catch(error => {
      highlightStatus.error = String(error.message || error);
    }).finally(() => {
      highlightTask = null;
      highlightStatus.phase = highlightStatus.error ? 'error' : 'ready';
      if (highlightRequested) prepareHighlights();
      else if (highlightEntrySession && !highlightNavigationPending) {
        highlightEntrySession = false;
        endSession(false);
      }
    });
    return highlightTask;
  }

  function showAnswers(visible) {
    answersVisible = visible;
    document.documentElement.classList.toggle('__mas_answers_visible', visible);
  }

  function publishAnswers(visible) {
    showAnswers(visible);
    if (visible) prepareHighlights();
    runtimeRequest({ type: 'MAS_HIGHLIGHTS_SET', payload: { visible } });
  }

  function hideAnswers() {
    const shouldBroadcast = chordHeld || answersVisible;
    pHeld = false;
    chordHeld = false;
    showAnswers(false);
    if (shouldBroadcast) publishAnswers(false);
  }

  function updateAnswerKeys(e) {
    const isP = e.code === 'KeyP' || (!e.code && String(e.key).toLowerCase() === 'p');
    if (isP) pHeld = e.type === 'keydown';
    const held = pHeld && e.ctrlKey && e.altKey && !e.metaKey;
    if (held) e.preventDefault();
    if (held !== chordHeld) {
      chordHeld = held;
      publishAnswers(held);
    }
  }

  showAnswers(false);
  window.addEventListener('keydown', updateAnswerKeys, true);
  window.addEventListener('keyup', updateAnswerKeys, true);
  window.addEventListener('keydown', e => {
    const isW = e.code === 'KeyW' || (!e.code && String(e.key).toLowerCase() === 'w');
    if (!isW || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || onePickKeyHeld) return;
    onePickKeyHeld = true;
    pickOneMcq();
  }, true);
  window.addEventListener('keyup', e => {
    if (e.code === 'KeyW' || (!e.code && String(e.key).toLowerCase() === 'w')) onePickKeyHeld = false;
  }, true);
  window.addEventListener('blur', cancelOnePick);
  window.addEventListener('pagehide', cancelOnePick);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelOnePick(); });
  window.addEventListener('blur', hideAnswers);
  window.addEventListener('pagehide', hideAnswers);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideAnswers();
  });

  // ---------------- 悬浮面板（仅顶层 frame） ----------------

  let panel = null;

  function buildPanel() {
    if (!IS_TOP || panel) return panel;
    const host = document.createElement('div');
    host.id = '__mcq_panel_host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          width: 330px; max-height: 70vh; display: flex; flex-direction: column;
          font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          color: #0f172a; background: #fff; border: 1px solid #cbd5e1;
          border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,.22); overflow: hidden;
        }
        .hd { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
              background: #0f172a; color: #f8fafc; cursor: move; user-select: none; }
        .hd b { font-size: 13px; font-weight: 600; flex: 1; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
        .dot.on { background: #22c55e; animation: p 1.1s infinite; }
        @keyframes p { 50% { opacity: .3 } }
        .x { cursor: pointer; opacity: .7; padding: 0 4px; }
        .x:hover { opacity: 1; }
        .bar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
        button { flex: 1; padding: 6px 8px; font-size: 12px; font-family: inherit; cursor: pointer;
                 border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; color: #0f172a; }
        button:hover { background: #eef2f7; }
        button.pri { background: #2563eb; border-color: #2563eb; color: #fff; }
        button.pri:hover { background: #1d4ed8; }
        button.stop { background: #dc2626; border-color: #dc2626; color: #fff; }
        .meta { padding: 6px 11px; font-size: 11px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
        .log { flex: 1; overflow-y: auto; padding: 6px 0; }
        .row { padding: 6px 11px; border-bottom: 1px solid #f1f5f9; }
        .row:last-child { border-bottom: 0; }
        .q { font-size: 11.5px; color: #475569; overflow-wrap: anywhere; }
        .a { margin-top: 2px; font-size: 12px; }
        .pick { display: inline-block; min-width: 18px; padding: 0 5px; margin-right: 6px;
                border-radius: 4px; background: #16a34a; color: #fff; font-weight: 700; text-align: center; }
        .pick.warn { background: #f59e0b; }
        .pick.err  { background: #dc2626; }
        .pick.step { background: #475569; }
        .why { color: #64748b; font-size: 11.5px; white-space: pre-line; overflow-wrap: anywhere; }
        .empty { padding: 14px 11px; color: #94a3b8; font-size: 12px; text-align: center; }
      </style>
      <div class="wrap">
        <div class="hd"><span class="dot" id="dot"></span><b>mas</b><span class="x" id="close">✕</span></div>
        <div class="bar">
          <button id="scan">扫描</button>
          <button id="run" class="pri">开始</button>
          <button id="stop" class="stop">停止</button>
        </div>
        <div class="meta" id="meta">待命</div>
        <div class="log" id="log"><div class="empty">还没有记录</div></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    if (panelHidden) host.style.setProperty('display', 'none', 'important');

    const $ = (id) => shadow.getElementById(id);
    $('close').onclick = () => {
      host.remove();
      panel = null;
    };
    $('scan').onclick = () => scanOnly();
    $('run').onclick = () => start();
    $('stop').onclick = () => stop('用户手动停止');

    const hd = shadow.querySelector('.hd');
    const wrap = shadow.querySelector('.wrap');
    let drag = null;
    hd.addEventListener('mousedown', (e) => {
      const r = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      wrap.style.left = e.clientX - drag.dx + 'px';
      wrap.style.top = e.clientY - drag.dy + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => (drag = null));

    panel = { host, shadow, $ };
    return panel;
  }

  function setBusy(on) {
    if (panel) panel.$('dot').classList.toggle('on', !!on);
  }

  function setMeta(txt) {
    if (IS_TOP) {
      buildPanel();
      panel.$('meta').textContent = txt;
    } else {
      chrome.runtime.sendMessage({ type: 'MCQ_RELAY', payload: { kind: 'meta', text: txt } });
    }
  }

  /** entry = { level?: 'ok'|'warn'|'err'|'step', stem, pick, why } */
  function log(entry) {
    if (!IS_TOP) {
      chrome.runtime.sendMessage({ type: 'MCQ_RELAY', payload: { kind: 'log', entry } });
      return;
    }
    buildPanel();
    const box = panel.$('log');
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'row';
    const cls = ['err', 'warn', 'step'].includes(entry.level) ? entry.level : '';
    row.innerHTML = `<div class="q"></div><div class="a"><span class="pick ${cls}"></span><span class="why"></span></div>`;
    row.querySelector('.q').textContent = entry.stem || '';
    row.querySelector('.pick').textContent = entry.pick || '?';
    row.querySelector('.why').textContent = entry.why || '';
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  // ---------------- 高亮与点击 ----------------

  function clearMarks(q) {
    if (q.type === 'text') {
      q.answerInputs.forEach(input => {
        input.classList.remove('__mcq_pick', '__mcq_pick_warn', '__mcq_scan');
        selectHints.get(input)?.remove();
        selectHints.delete(input);
      });
      return;
    }
    if (q.answerSelect || q.answerCell) {
      const control = q.answerSelect || q.answerCell;
      control.classList.remove('__mcq_pick', '__mcq_pick_warn', '__mcq_scan');
      selectHints.get(control)?.remove();
      selectHints.delete(control);
      return;
    }
    if (q.type === 'numeric') {
      const control = q.answerNumberCell || q.answerInput;
      if (control) {control.classList.remove('__mcq_pick', '__mcq_pick_warn', '__mcq_scan');selectHints.get(control)?.remove();selectHints.delete(control);}
      return;
    }
    q.options.forEach((o) => o.clickTarget.classList.remove('__mcq_pick', '__mcq_pick_warn', '__mcq_scan'));
  }

  function mark(q, letters, lowConf, values, value) {
    if (q.type === 'text') {
      const answers = textValues(q, values);
      if (!answers) return;
      q.answerInputs.forEach((input, index) => {
        input.classList.add(lowConf ? '__mcq_pick_warn' : '__mcq_pick');
        const hint = document.createElement('span');
        hint.className = '__mas_select_hint' + (lowConf ? ' __mas_select_hint_warn' : '');
        hint.textContent = '建议：' + answers[index];
        input.insertAdjacentElement('afterend', hint);
        selectHints.set(input, hint);
      });
      return;
    }
    if (q.answerSelect || q.answerCell) {
      const option = q.options.find(o => o.letter === letters[0]);
      if (!option) return;
      const control = q.answerSelect || q.answerCell;
      control.classList.add(lowConf ? '__mcq_pick_warn' : '__mcq_pick');
      const hint = document.createElement('span');
      hint.className = '__mas_select_hint' + (lowConf ? ' __mas_select_hint_warn' : '');
      hint.textContent = '建议：' + option.text;
      if (q.answerCell) control.append(hint); // span 只能放在单元格内，不能插入 tr 中破坏表格布局。
      else control.insertAdjacentElement('afterend', hint);
      selectHints.set(control, hint);
      return;
    }
    if (q.type === 'numeric') {
      const control = q.answerNumberCell || q.answerInput;
      if (control) control.classList.add(lowConf ? '__mcq_pick_warn' : '__mcq_pick');
      if (q.answerNumberCell && numericValue(value) !== null) {
        const hint = document.createElement('span');hint.className='__mas_select_hint' + (lowConf?' __mas_select_hint_warn':'');
        hint.textContent='建议：'+numericValue(value);control.append(hint);selectHints.set(control,hint);
      }
      return;
    }
    q.options.forEach((o) => {
      if (letters.includes(o.letter)) o.clickTarget.classList.add(lowConf ? '__mcq_pick_warn' : '__mcq_pick');
    });
  }

  function nativeCheck(input) {
    // React / Vue 受控组件：绕过框架的 value setter 直接改再派发事件
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked');
      if (desc && desc.set) desc.set.call(input, true);
      else input.checked = true;
    } catch (_) {
      input.checked = true;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function numericValue(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const str = String(value).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(str) || !Number.isFinite(Number(str))) return null;
    return String(Number(str));
  }

  function connectNumericText(cell) {
    const copy=cell.cloneNode(true);
    copy.querySelectorAll('.__mas_select_hint, .currencySymbol').forEach(el=>el.remove());
    let text=D.norm(copy.textContent).replace(/\u2212/g,'-');
    // 只在读取 Connect 数字单元格的显示值时剥离格式；模型回复仍用严格数字协议。
    text=text.replace(/^([+-]?)\s*[$€£¥₹]\s*/,'$1').replace(/\s*[$€£¥₹%]$/,'').trim();
    if(/^\(.*\)$/.test(text))text='-'+text.slice(1,-1).trim().replace(/^[$€£¥₹]\s*/,'');
    if(/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(text))text=text.replace(/,/g,'');
    return numericValue(text)??text;
  }

  const connectNumericValue=cell=>numericValue(connectNumericText(cell));

  async function applyNumericAnswer(q, value) {
    if (q.answerNumberCell) {
      const task = connectChoiceQueue.then(() => applyConnectNumericAnswer(q,value));
      connectChoiceQueue = task.catch(() => {});
      return task;
    }
    const input = q.answerInput;
    const answer = numericValue(value);
    if (!input || !input.isConnected || isDisabled(input) || input.readOnly || answer === null) return false;
    try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    input.focus();
    // 使用原生 setter，让受控输入框的 input/change 监听器收到变更。
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, answer);
    else input.value = answer;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    await sleep(Math.max(50, state.settings.actionDelay / 2));
    return input.isConnected && numericValue(input.value) === answer && input.checkValidity();
  }

  function textValues(q, values) {
    if (!Array.isArray(values) || values.length !== q.answerInputs.length) return null;
    const answers = values.map(value => typeof value === 'string' ? value.trim() : null);
    return answers.every((answer, index) => answer && answer.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(answer) &&
      (q.answerInputs[index].maxLength < 0 || answer.length <= q.answerInputs[index].maxLength)) ? answers : null;
  }

  function textAnswerMatches(q, values) {
    const answers = textValues(q, values), current = liveQuestion(q);
    return !!answers && !!current && !current.readOnly && !current.incomplete &&
      current.answerInputs?.length === q.answerInputs.length && current.answerInputs.every((input, index) =>
        input === q.answerInputs[index] && !isDisabled(input) && !input.readOnly && input.value === answers[index] && input.checkValidity());
  }

  async function applyTextAnswer(q, values) {
    const answers = textValues(q, values);
    const stillCurrent = () => {
      const current = liveQuestion(q);
      return state.running && current && !current.readOnly && !current.incomplete &&
        current.answerInputs?.length === q.answerInputs.length &&
        current.answerInputs.every((input, index) => input === q.answerInputs[index] && !isDisabled(input) && !input.readOnly);
    };
    if (!answers || !stillCurrent()) return false;
    // 先检查全部答案及原生限制，避免第二空明显无效时先写入第一空。
    if (!q.answerInputs.every((input, index) => {
      const copy = input.cloneNode(); copy.value = answers[index]; return copy.checkValidity();
    })) return false;
    try { q.answerInputs[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    for (let index = 0; index < answers.length; index++) {
      if (!stillCurrent()) return false;
      const input = q.answerInputs[index];
      input.focus();
      if (!stillCurrent()) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, answers[index]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!stillCurrent()) return false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      await sleep(Math.max(50, state.settings.actionDelay / 2));
    }
    return state.running && textAnswerMatches(q, answers);
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: el.ownerDocument.defaultView || window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', base));
    try {
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.click();
  }

  const SELECTED_CLASS = /(^|[\s_-])(selected|active|checked|chosen|is-selected)([\s_-]|$)/i;

  /** 返回 true / false / null（null = 这个控件看不出选中状态） */
  function isSelected(opt) {
    if (opt.connectCell) return D.connectCellText(opt.connectCell) === opt.value;
    if (opt.selectOption) return opt.clickTarget.value === opt.value;
    if (opt.input) return !!opt.input.checked;
    const t = opt.clickTarget;
    const aria = t.getAttribute('aria-checked') || t.getAttribute('aria-selected');
    if (aria != null) return aria === 'true';
    if (SELECTED_CLASS.test(t.className || '')) return true;
    return null; // 自定义组件且没有可读状态，只能相信点击生效了
  }

  function verifySelection(q, letters) {
    let anyKnown = false;
    for (const letter of letters) {
      const opt = q.options.find((o) => o.letter === letter);
      if (!opt) return false;
      const s = isSelected(opt);
      if (s === false) return false;
      if (s === true) anyKnown = true;
    }
    return anyKnown ? true : null;
  }

  async function clickOption(opt, canClick) {
    if (canClick && !canClick()) return;
    if (!opt.clickTarget.isConnected) return;
    if (opt.selectOption) {
      if (isDisabled(opt.clickTarget) || !opt.selectOption.isConnected || opt.selectOption.disabled) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(opt.clickTarget, opt.value);
      opt.clickTarget.dispatchEvent(new Event('input', { bubbles: true }));
      opt.clickTarget.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(0);
      return;
    }
    // 已经是选中状态就别再点了，否则多选题会被点成取消
    if (isSelected(opt) === true) return;
    try {
      opt.clickTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {}
    await sleep(120);
    if (canClick && !canClick()) return;
    realClick(opt.clickTarget);
    if (opt.input && !opt.input.checked) nativeCheck(opt.input);
  }

  /** 点选答案并校验；必要时重试一次。返回 true/false/null */
  async function applyAnswer(q, letters) {
    if (q.answerCell) {
      const task = connectChoiceQueue.then(() => applyConnectAnswer(q, letters));
      connectChoiceQueue = task.catch(() => {});
      return task;
    }
    if (q.answerSelect) {
      const select = q.answerSelect;
      const option = letters.length === 1 && q.options.find(o => o.letter === letters[0]);
      if (!option || !select.isConnected || isDisabled(select) || !Array.from(select.options).includes(option.selectOption) || option.selectOption.disabled || option.selectOption.parentElement.disabled) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(Math.max(50, state.settings.actionDelay / 2));
      return select.isConnected && select.value === option.value && select.checkValidity();
    }
    for (const letter of letters) {
      const opt = q.options.find((o) => o.letter === letter);
      if (opt) await clickOption(opt);
      await sleep(Math.max(150, state.settings.actionDelay / 2));
    }
    let ok = verifySelection(q, letters);
    if (ok === false) {
      // 第一次没生效：直接对 input 本身再来一次
      for (const letter of letters) {
        const opt = q.options.find((o) => o.letter === letter);
        if (!opt) continue;
        if (opt.input && opt.input.isConnected) {
          realClick(opt.input);
          if (!opt.input.checked) nativeCheck(opt.input);
        } else if (opt.clickTarget.isConnected) {
          realClick(opt.clickTarget);
        }
        await sleep(200);
      }
      ok = verifySelection(q, letters);
    }
    return ok;
  }

  async function applyConnectAnswer(q, letters) {
    const cell = q.answerCell, doc = cell.ownerDocument;
    const option = letters.length === 1 && q.options.find(o => o.letter === letters[0]);
    const current = () => state.running && cell.isConnected && liveQuestion(q)?.answerCell === cell &&
      !cell.classList.contains('td-readOnly') && cell.getAttribute('aria-disabled') !== 'true' && cell.getAttribute('aria-readonly') !== 'true';
    if (!option || !current()) return false;
    selectHints.get(cell)?.remove();
    selectHints.delete(cell);
    if (D.connectCellText(cell) === option.value) return true;
    cell.focus();
    realClick(cell);
    let menu = null;
    for (let attempt=0; attempt<20 && current(); attempt++) {
      menu = D.connectMenuFor(cell, true);
      if (menu) break;
      // 站点先激活单元格，再用浮动的 Show All Items 按钮打开共用菜单。
      if (attempt === 3 && cell.classList.contains('jSheetCellActive')) {
        const buttons = Array.from(doc.querySelectorAll('input.dropdownButton[title="Show All Items"]')).filter(D.isVisible);
        if (buttons.length === 1) realClick(buttons[0]);
      }
      await sleep(50);
    }
    if (!menu || !current()) return false;
    const items = Array.from(menu.querySelectorAll('[role="option"]')).filter(item => D.isVisible(item) &&
      !item.classList.contains('li_disabled') && item.getAttribute('aria-disabled') !== 'true');
    const matches = items.filter(item => D.norm(item.querySelector('.list_content')?.textContent || '') === option.value);
    if (matches.length !== 1 || D.connectMenuFor(cell,true) !== menu) return false;
    realClick(matches[0]); // 让站点自身 click 处理器更新数据和自动保存，不改 td.textContent。
    await sleep(Math.max(50,state.settings.actionDelay/2));
    return current() && D.connectCellText(cell) === option.value;
  }

  async function applyConnectNumericAnswer(q, value) {
    const cell=q.answerNumberCell,doc=cell.ownerDocument,win=doc.defaultView,answer=numericValue(value);
    const current=()=>state.running&&cell.isConnected&&!isDisabled(cell)&&!cell.classList.contains('td-readOnly')&&cell.getAttribute('aria-readonly')!=='true'&&liveQuestion(q)?.answerNumberCell===cell;
    if(answer===null||!current())return false;
    selectHints.get(cell)?.remove();selectHints.delete(cell);
    if(connectNumericValue(cell)===answer)return true;
    cell.focus();realClick(cell);
    cell.dispatchEvent(new win.MouseEvent('dblclick',{bubbles:true,cancelable:true,view:win}));
    let editor;
    for(let attempt=0;attempt<20&&current();attempt++){
      const editors=Array.from(doc.querySelectorAll('textarea.jSheetInPlaceEdit')).filter(D.isVisible);
      if(editors.length===1&&cell.classList.contains('jSheetCellActive')){editor=editors[0];break;}
      await sleep(50);
    }
    if(!editor||!current()||editor.disabled||editor.readOnly)return false;
    editor.focus();
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value').set.call(editor,answer);
    editor.dispatchEvent(new win.Event('input',{bubbles:true}));
    editor.dispatchEvent(new win.Event('change',{bubbles:true}));
    if(!current())return false;
    editor.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
    if(editor.isConnected)editor.blur();
    const started=performance.now();
    while(current()&&performance.now()-started<1500){
      if(connectNumericValue(cell)===answer)return true;
      await sleep(50);
    }
    return false;
  }

  // ---------------- 提交 / 下一题 ----------------

  const GO_EXACT = /^(submit|next|continue|finish|done|check|确认|确定|提交|交卷|下一题|下一页|下一个|继续|保存并继续)\s*(question|page|answer|答案)?$/i;
  const GO_LOOSE = /(submit|next|continue|check answer|提交|下一题|下一页|继续)/i;
  const KNOWLEDGE_CHECK_RE = /^(?:next\s*[:：-]?\s*)?knowledge\s*check(?:\s+\d+(?:\.\d+)*)?$/i;
  const CHAPTER_QUIZ_RE = /^(?:next\s*[:：-]?\s*)?chapter(?:\s+\d+(?:\.\d+)*)?\s+quiz$/i;
  const DO_ACTIVITY_RE = /^(?:do|redo|repeat|retake)\s+(?:the\s+)?activity\b/i;
  const BACK_DIRECTION_RE = /\b(?:previous|prev|go back|back to)\b|上一|前一|返回/i;
  const GET_STARTED_RE = /^get\s+started$/i;
  const NO_RE = /(cancel|back|previous|prev|reset|clear|exit|quit|logout|sign out|delete|report|flag|hint|skip|上一|返回|取消|清除|重置|退出|删除|跳过|提示)/i;

  const BTN_SELECTOR =
    'button, input[type="submit"], input[type="button"], a[href], a[role="button"], [role="button"], a.btn, [class*="submit"], [class*="next"]';
  const NATIVE_CLICK_SELECTOR =
    'button, input[type="submit"], input[type="button"], a[href], a[role="button"], [role="button"]';

  // 导航栏 / 页眉 / 页脚里的 "Next"、"Submit" 几乎不可能是答题用的按钮
  const CHROME_SEL =
    'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [class*="navbar"], [class*="nav-"], [class*="header"], [class*="footer"], [class*="sidebar"], [class*="menu"]';
  const SKIP_LINK_SEL =
    '#top-skip-links, #bottom-skip-links, .top-tab, .bottom-tab, .skip-link, [class*="skip-link"]';

  // btn-disabled / is-disabled / ui-disabled … 各家写法不一
  const DISABLED_CLASS = /(^|[\s_-])(disabled|inactive)([\s_-]|$)/i;

  /** 原生 disabled：浏览器本身会阻止点击事件。 */
  function isHardDisabled(el) {
    return !!el.disabled;
  }

  /**
   * 页面声明为禁用：包含 aria-disabled 和仅靠类名/onclick 管理状态的组件。
   * aria-disabled 本身不会阻止事件，但站点通常会同时配合事件处理器，所以提交前仍要等它解除。
   */
  function isDisabled(el) {
    const className = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return isHardDisabled(el) || el.getAttribute('aria-disabled') === 'true' || DISABLED_CLASS.test(className);
  }

  /**
   * 很多站点把 next/submit 类放在外层布局容器上，真正绑定导航的是里面的 <a>。
   * 点击外层 div 只会冒泡到祖先，不会把事件送给子链接，因此先归一到实际控件。
   */
  function clickableElement(el) {
    if (el.matches(NATIVE_CLICK_SELECTOR)) return el;
    const parent = el.closest(NATIVE_CLICK_SELECTOR);
    if (parent) return parent;
    const child = el.querySelector(NATIVE_CLICK_SELECTOR);
    return child || el;
  }

  function isMcgrawNextButton(el, label) {
    return el.matches('button') && !!el.closest('awd-navigation-bar awd-question-button-bar') &&
      /^next\s+question$/i.test(label || D.norm(el.innerText || el.getAttribute('aria-label') || ''));
  }

  /**
   * anchor = 当前题目的容器。一页一题时，题目正下方最近的那颗按钮几乎必然是目标，
   * 所以位置权重给得比较重，能把页头页脚的 "Next" 之类干扰项压下去。
   */
  function findAdvanceButton(anchor, opts) {
    const { excludeChrome = false, minScore = 1, onlyStart = false } = opts || {};
    const scored = [];
    const seen = new Set();
    const connectHost = !!document.querySelector('.worksheet__main iframe.external[title="Assessment Tool iFrame"]');
    for (const rawEl of document.querySelectorAll(BTN_SELECTOR)) {
      const el = clickableElement(rawEl);
      if (seen.has(el)) continue;
      seen.add(el);
      if (!D.isVisible(el) || el.closest('#__mcq_panel_host')) continue;
      // Sage 在文档最前/最后各放了一颗同名无障碍链接，href 只是当前页 #next-page。
      // 它只负责把焦点滚到真正按钮，不能进入 Knowledge Check，必须从推进候选中排除。
      if (el.closest(SKIP_LINK_SEL)) continue;
      const label = D.norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '');
      if (!label || label.length > 30) continue;
      if (NO_RE.test(label)) continue;
      if (connectHost && /^(?:submit|check my work)$/i.test(label)) continue; // 不把整份作业交卷当成本题下一步。
      // 标题可能只写 Knowledge Check 7.4，方向信息在 aria-label/title 中。
      // 活动卡片属于复习内容，不能当成下一章测验入口反复重做。
      const description = D.norm((el.getAttribute('aria-label') || '') + ' ' + (el.title || ''));
      if (BACK_DIRECTION_RE.test(description) || DO_ACTIVITY_RE.test(label) || DO_ACTIVITY_RE.test(description)) continue;
      if (onlyStart && !GET_STARTED_RE.test(label)) continue;

      const knowledgeCheck = KNOWLEDGE_CHECK_RE.test(label);
      const chapterQuiz = CHAPTER_QUIZ_RE.test(label);
      const assessmentEntry = knowledgeCheck || chapterQuiz;
      // McGraw Hill 将置信度按钮作为提交入口，文字只有 High / Medium / Low。
      // 必须同时匹配真实提交组件和专用属性，不能把其它页面的同名按钮算进来。
      const confidenceLevel = el.matches('button') && el.closest('awd-confidence-buttons') &&
        /^confidence-buttons--(high|medium|low)_confidence$/.exec(el.getAttribute('data-automation-id') || '')?.[1];
      // 默认选 Medium；这是真正的题目提交区，即使嵌在底部导航里也不能被过滤。
      const confidenceScore = confidenceLevel ? { medium: 14, high: 12, low: 10 }[confidenceLevel] : 0;
      // McGraw Hill 的反馈页把 Next Question 放在 role=navigation 的 footer 内。
      // 仅对该站点实际题目按钮栏中的下一题放行，普通页眉/页脚仍按原规则排除。
      const mcgrawNext = isMcgrawNextButton(el, label);
      const connectNext = connectHost && el.matches('button.footer__link--next') && /^next$/i.test(label);
      const chromeArea = confidenceLevel || mcgrawNext || connectNext ? null : el.closest(CHROME_SEL);
      // 后续推进排除普通页眉/侧栏按钮；明确的测验入口可在正文按钮缺失时兜底。
      if (excludeChrome && chromeArea && !assessmentEntry) continue;

      let score = confidenceScore || (connectNext ? 16 : mcgrawNext ? 14 : chapterQuiz ? (/^next\b/i.test(label) ? 16 : 10) : GET_STARTED_RE.test(label) ? 12 : GO_EXACT.test(label) ? 10 : knowledgeCheck ? (/^next\b/i.test(label) ? 12 : 8) : GO_LOOSE.test(label) ? 5 : 0);
      if (!score) continue;
      if (isDisabled(el)) score -= 1; // 可能是「选完才解锁」，别直接淘汰
      if (chromeArea) score -= assessmentEntry ? 4 : 6; // 同名测验入口可兜底，普通导航件继续重罚
      if (assessmentEntry) {
        const target = navigationTarget(el);
        if (target) {
          const here = new URL(location.href);
          const there = new URL(target.url);
          const sameDocument = here.origin === there.origin && here.pathname === there.pathname && here.search === there.search;
          // SPA 也会用 hash 路由，不能把所有同页 hash 都当成无障碍定位链接。
          let pointsToElement = false;
          try { pointsToElement = !!there.hash && !!document.getElementById(decodeURIComponent(there.hash.slice(1))); } catch (_) {}
          score += sameDocument ? (pointsToElement ? -5 : 0) : 3;
        }
      }

      const r = el.getBoundingClientRect();
      if (anchor && anchor.isConnected) {
        // 正在处理题目时，章节入口不能压过本题的 Submit / Continue。
        if (assessmentEntry && !anchor.contains(el)) score -= 14;
        const ar = anchor.getBoundingClientRect();
        if (anchor.contains(el)) score += 3;
        else if (anchor.parentElement && anchor.parentElement.contains(el)) score += 2;
        if (r.top >= ar.top - 20) score += 2; // 在题目下方
        score += Math.max(0, 3 - Math.abs(r.top - ar.bottom) / 250); // 越近越高
      } else if (r.top > window.innerHeight * 3) {
        score -= 2; // 太远的多半是页脚
      }
      scored.push({ el, label, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].score >= minScore ? scored[0] : null;
  }

  const NAV_URL_ATTRS = ['href', 'data-href', 'data-url', 'data-destination', 'data-next-url', 'data-route', 'data-link', 'formaction'];

  function usableNavigationUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '#' || /^(javascript|mailto|tel):/i.test(raw)) return null;
    try {
      const url = new URL(raw, location.href);
      const allowedProtocol = /^https?:$/.test(url.protocol) || (location.protocol === 'file:' && url.protocol === 'file:');
      if (!allowedProtocol || url.href === location.href) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  /** 从实际控件、外层包装和内部链接中提取站点已经提供的导航地址。 */
  function navigationTarget(el) {
    const nodes = [];
    const add = (node) => {
      if (node && !nodes.includes(node)) nodes.push(node);
    };
    add(el);
    add(el.closest('a[href]'));
    add(el.querySelector && el.querySelector('a[href], [data-href], [data-url], [data-next-url]'));
    let parent = el.parentElement;
    for (let i = 0; parent && i < 3; i++, parent = parent.parentElement) add(parent);

    for (const node of nodes) {
      for (const attr of NAV_URL_ATTRS) {
        const url = usableNavigationUrl(node.getAttribute && node.getAttribute(attr));
        if (url) return { url, attr, node };
      }
    }
    return null;
  }

  /**
   * 常规 click 对 target=_blank、被包装的链接或某些 SPA 事件代理可能没有效果。
   * 只对明确的 Knowledge Check / Chapter Quiz 使用站点自身 URL，在当前页打开。
   */
  function forceAssessmentNavigation(btn) {
    if (!KNOWLEDGE_CHECK_RE.test(btn.label) && !CHAPTER_QUIZ_RE.test(btn.label)) return false;
    const target = navigationTarget(btn.el);
    if (!target) return false;
    log({
      level: 'warn',
      stem: `常规点击「${btn.label}」未跳转`,
      pick: '↗',
      why: '改用按钮链接在当前页打开'
    });
    location.assign(target.url);
    return target.url;
  }

  /** 很多站点选完答案才解锁提交按钮，等它一下 */
  async function waitEnabled(el, timeout = 3000) {
    const t0 = performance.now();
    while (state.running && isDisabled(el) && performance.now() - t0 < timeout) await sleep(150);
    return !isDisabled(el);
  }

  // 原生表单 POST 和跨页链接 GET 都交给新文档接管，避免旧页超时清除会话。
  // 被阻止的事件和同文档 hash 跳转继续由 DOM 变化检测推进。
  function clickForNavigation(el) {
    const form = el.form;
    const link = el.closest('a[href]');
    let submitted = null;
    let clicked = null;
    const capture = event => { if (!event.submitter || event.submitter === el) submitted = event; };
    const captureClick = event => { clicked = event; };
    if (form) form.addEventListener('submit', capture, true);
    if (link) link.addEventListener('click', captureClick, true);
    try { realClick(el); }
    finally {
      if (form) form.removeEventListener('submit', capture, true);
      if (link) link.removeEventListener('click', captureClick, true);
    }
    const target = el.getAttribute('formtarget') || form?.getAttribute('target') || '';
    const method = el.getAttribute('formmethod') || form?.method || '';
    if (submitted && !submitted.defaultPrevented && method.toLowerCase() !== 'dialog' && (!target || target === '_self')) return true;
    const linkTarget = link?.getAttribute('target') || '';
    return !!clicked && !clicked.defaultPrevented && !link.hasAttribute('download') &&
      (!linkTarget || linkTarget === '_self') && isDocumentNavigation(link.href);
  }

  function isDocumentNavigation(value) {
    const target = usableNavigationUrl(value);
    if (!target) return false;
    const here = new URL(location.href), there = new URL(target);
    return here.origin !== there.origin || here.pathname !== there.pathname || here.search !== there.search;
  }

  function pendingQuestions() {
    return D.collect().filter((q) => !state.done.has(q.hash));
  }

  function connectPageSnapshot() {
    const frames = Array.from(document.querySelectorAll('.worksheet__main iframe.external[title="Assessment Tool iFrame"]')).filter(D.isVisible);
    const context = frames.map(frame => {
      const copy=frame.closest('.worksheet__main').cloneNode(true);
      copy.querySelectorAll('iframe, .gaspar_audio__container, .t-hidden, [aria-hidden="true"], .__mas_select_hint').forEach(el=>el.remove());
      return D.norm(copy.textContent);
    }).join('\n');
    return {href:location.href,context,frames:frames.map(frame=>{
      try {
        const doc=frame.contentDocument,cells=Array.from(doc?.querySelectorAll('#jQuerySheet table.jSheet td.responseCell')||[]);
        const loading=doc?.getElementById('loading_image');
        const source=new URL(frame.src,location.href),loaded=doc?.location.href;
        const key=source.search.match(/Q_[\w-]+/)?.[0];
        return {frame,doc,name:frame.name,src:frame.src,cells,values:cells.map(cell=>cell.classList.contains('isN')?connectNumericText(cell):D.connectCellText(cell)),
          ready:!!doc&&doc.readyState==='complete'&&cells.length>0&&(!loading||getComputedStyle(loading).display==='none')&&(!key||loaded?.includes(key)),
          structure:cells.map(cell=>cell.id+'|'+cell.getAttribute('dropdownid')+'|'+cell.getAttribute('dropdowntype')).join('::')};
      }catch(_){return {frame,doc:null,cells:[],values:[],ready:false};}
    })};
  }

  function sameConnectSnapshot(a,b) {
    return a.href===b.href&&a.context===b.context&&a.frames.length===b.frames.length&&a.frames.every((item,index)=>{
      const other=b.frames[index];
      return item.frame===other.frame&&item.doc===other.doc&&item.src===other.src&&item.name===other.name&&item.ready===other.ready&&item.structure===other.structure&&
        item.cells.length===other.cells.length&&item.cells.every((cell,i)=>cell===other.cells[i])&&item.values.join('\u0000')===other.values.join('\u0000');
    });
  }

  async function waitForConnectQuestion(before,timeout) {
    const started=performance.now();let previous=null,stableSince=started,lastRefresh=0,progressed=false,issues=[];
    while(state.running&&performance.now()-started<(progressed?Math.max(timeout,15000):timeout)){
      const current=connectPageSnapshot();
      if(!sameConnectSnapshot(before,current))progressed=true;
      const replaced=current.frames.length!==before.frames.length||current.frames.some((item,index)=>{
        const old=before.frames[index];
        return !old||item.frame!==old.frame||item.doc!==old.doc||item.src!==old.src||item.name!==old.name;
      });
      const changedContext=current.context!==before.context||current.href!==before.href||replaced;
      // 题干先变、旧iframe尚未换掉时不能把旧控件当成新题；原位重用时必须已重置字段。
      const controlsReady=current.frames.length>0&&current.frames.every(item=>{
        if(!item.ready)return false;
        const old=before.frames.find(old=>old.frame===item.frame);
        return !old||item.doc!==old.doc||item.structure!==old.structure||
          item.cells.length!==old.cells.length||item.cells.some((cell,i)=>cell!==old.cells[i])||
          item.values.every(value=>value==='')&&old.values.some(value=>value!=='');
      });
      const native=D.collect().filter(q=>q.container.ownerDocument===document&&!q.readOnly&&!state.done.has(q.hash));
      if(!previous||!sameConnectSnapshot(previous,current)){previous=current;stableSince=performance.now();}
      if((controlsReady&&changedContext||native.length)&&performance.now()-stableSince>=350){
        if(performance.now()-lastRefresh>=500){await D.refreshConnectChoices?.();lastRefresh=performance.now();}
        if(!state.running)break;
        const after=connectPageSnapshot();
        if(!sameConnectSnapshot(current,after)){previous=after;stableSince=performance.now();continue;}
        const questions=D.collect().filter(q=>!q.readOnly);
        issues=questions.filter(q=>q.incomplete).flatMap(q=>q.issues);
        if(questions.length&&!issues.length){
          // 两个不同题目可能具有相同文字；确认是新页后不能因旧hash而跳过新控件。
          questions.forEach(q=>state.done.delete(q.hash));
          return {ok:true,questions};
        }
      }
      await sleep(100);
    }
    if(!state.running)return {ok:false,cancelled:true,reason:'已停止等待下一题'};
    state.stats.timeouts++;
    return {ok:false,reason:progressed
      ? '已进入下一题，但题目控件尚未就绪'+(issues.length?'：'+[...new Set(issues)].join('；'):'，请等待页面加载后重新开始')
      : '点击 Next 后未检测到题目变化，已停止，避免跳过题目'};
  }

  function isReadOnlyQuiz() {
    const questions = D.collect(document, { includeReadOnly: true });
    // McGraw Hill 提交中及反馈页都会禁用文本框；Next 可能稍后才出现。
    // 文本框禁用不足以判定测验结束，继续由推进流程等待反馈/下一题。
    return questions.length > 0 && questions.every((q) => q.readOnly && q.type !== 'text');
  }

  /** 轮询等待「页面上出现了没做过的新题」 */
  async function waitForNewQuestion(timeout) {
    const t0 = performance.now();
    while (state.running && performance.now() - t0 < timeout) {
      const qs = pendingQuestions();
      if (qs.length) return qs;
      await sleep(250);
    }
    return [];
  }

  /**
   * 点完按钮后等结果。三种结局：
   *   question —— 新题出来了
   *   changed  —— 页面确实变了但没有题（多半是「回答正确/错误」这种反馈页），可以立刻再点一次
   *   timeout  —— 什么都没发生
   *
   * 关键在 changed：一页一题的站点普遍是 提交 -> 反馈 -> 下一题，
   * 如果傻等满 pageTimeout 才去点 Continue，每道题都要白扔好几秒。
   * 这里只要「DOM 已静默 + 刚点的那颗按钮消失/失效 + 出现了另一颗按钮」就马上推进。
   */
  async function waitForProgress(anchor, clickedBtn, timeout, onStall) {
    const t0 = performance.now();
    const startUrl = location.href;
    let lastMutation = t0;
    let retried = false;
    const obs = new MutationObserver(() => (lastMutation = performance.now()));
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      while (state.running && performance.now() - t0 < timeout) {
        const qs = pendingQuestions();
        if (qs.length) return { kind: 'question', questions: qs };
        if (isReadOnlyQuiz()) return { kind: 'complete' };

        const elapsed = performance.now() - t0;
        const quiet = performance.now() - lastMutation > 400;
        if (location.href !== startUrl) return { kind: 'changed' };
        const moved = (anchor && !anchor.isConnected) || !clickedBtn.isConnected || isDisabled(clickedBtn);
        if (elapsed > 600 && quiet && moved) {
          // 这里必须挑剔：页面处于「加载中…」的空窗期时，页面上唯一还剩的
          // 「Next」很可能是导航栏的链接，点下去只会跑偏。所以排除导航件。
          const next = findAdvanceButton(anchor, { excludeChrome: true });
          // 只有当「换了一颗按钮」才算真的推进了；否则可能只是提交请求还在飞
          if (next && next.el !== clickedBtn) return { kind: 'changed', button: next };
        }
        // 页面完全静止时别白等完整个 pageTimeout。明确的测验入口可用其 href
        // 在当前页继续，解决 target=_blank、外层容器和站点事件代理吞掉合成 click 的情况。
        if (!retried && elapsed > Math.min(1400, Math.max(700, timeout / 4)) && quiet && !moved && onStall) {
          retried = true;
          const redirected = onStall();
          if (typeof redirected === 'string' && isDocumentNavigation(redirected)) return { kind: 'navigating' };
        }
        await sleep(200);
      }
    } finally {
      obs.disconnect();
    }
    return { kind: 'timeout' };
  }

  /**
   * 点提交 / 下一题，直到新题出现。
   * 支持 提交 -> 对错反馈 -> 下一题 的多段式流程，一轮内最多连点 4 次。
   */
  async function advance(anchor) {
    let lastClicked = null;
    for (let step = 0; step < 4 && state.running; step++) {
      // anchor 一直传下去：反馈页通常还挂在同一个题目容器里，位置权重照样管用。
      // 第 0 步（提交本题）只降权导航件；后续的「继续」步骤直接把它们排除掉。
      const btn = findAdvanceButton(anchor, { excludeChrome: step > 0 });
      if (!btn) return { ok: false, reason: step === 0 ? '找不到「提交 / 下一题」按钮' : '没有更多可点的按钮了' };
      if (btn.el === lastClicked) return { ok: false, reason: `点了「${btn.label}」但页面没有反应` };

      if (isDisabled(btn.el) && !(await waitEnabled(btn.el))) {
        return { ok: false, reason: `按钮「${btn.label}」一直是禁用状态` };
      }
      const connectNext=btn.el.matches('button.footer__link--next')&&!!document.querySelector('.worksheet__main iframe.external[title="Assessment Tool iFrame"]');
      log({ level: 'step', stem: '点击「' + btn.label + '」', pick: '→', why: connectNext?'保存后进入下一题':step === 0 ? '提交本题' : '继续' });
      if (step === 0) {
        // 紧贴导航动作落盘：写早了，提交前的意外刷新可能把未提交题误判为已完成；
        // 写晚了，按钮触发整页导航后当前 JS 上下文已经不存在。
        await saveSessionProgress();
      }
      const connectBefore=connectNext?connectPageSnapshot():null;
      if (clickForNavigation(btn.el)) return { ok: true, navigating: true };
      if(connectBefore)return waitForConnectQuestion(connectBefore,state.settings.pageTimeout);
      lastClicked = btn.el;

      const r = await waitForProgress(anchor, btn.el, state.settings.pageTimeout, () => forceAssessmentNavigation(btn));
      if (r.kind === 'navigating') return { ok: true, navigating: true };
      if (r.kind === 'question') return { ok: true, questions: r.questions };
      if (r.kind === 'complete') return { ok: false, reason: '测验已提交，当前是只读结果页面' };
      if (r.kind === 'changed') continue; // 反馈页之类，接着点

      // 走到这里说明白等了一整个 pageTimeout —— 记一笔，方便用户调参
      state.stats.timeouts++;
      log({ level: 'warn', stem: `等了 ${state.settings.pageTimeout}ms 没等到下一题`, pick: '⏱', why: '页面可能加载很慢，可调大「等下一题超时」' });
      // 如果页面上已经换了别的按钮，还值得再试一次
      const next = findAdvanceButton(anchor, { excludeChrome: true });
      if (!next || next.el === btn.el) return { ok: false, reason: '点了提交但没等到下一题' };
    }
    return { ok: false, reason: '连点多次仍没出现新题目' };
  }

  // ---------------- 与 background 通信 ----------------

  function runtimeRequest(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || null);
      };
      try {
        const returned = chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) finish(null);
          else finish(res);
        });
        // 测试桩、Firefox 和部分 Chromium API 包装器使用 Promise 风格。
        if (returned && typeof returned.then === 'function') returned.then(finish, () => finish(null));
      } catch (_) {
        finish(null);
      }
    });
  }

  async function beginSession() {
    return runtimeRequest({ type: 'MCQ_SESSION_BEGIN' });
  }

  async function saveSessionProgress(replace = false) {
    return runtimeRequest({
      type: 'MCQ_SESSION_PROGRESS',
      payload: { done: [...state.done], replace }
    });
  }

  function endSession(manual) {
    // 不 await：stop() 也会在 Esc 和页面生命周期末尾调用，不能卡住 UI。
    runtimeRequest({ type: 'MCQ_SESSION_END', payload: { manual: !!manual } });
  }

  function ask(q) {
    if (answerRequests.has(q.hash)) return answerRequests.get(q.hash);
    const task = askUncached(q).finally(() => { if (answerRequests.get(q.hash) === task) answerRequests.delete(q.hash); });
    answerRequests.set(q.hash, task);
    return task;
  }

  async function askUncached(q) {
    const captureEpoch = {running:state.running, highlight:highlightEpoch, onePick:onePickEpoch};
    const captureCancelled = () => captureEpoch.running && !state.running || captureEpoch.highlight !== highlightEpoch || captureEpoch.onePick !== onePickEpoch;
    let images = [];
    try {
      if (q.visuals?.length) {
        if (!window.__MAS_VISION__) throw new Error('视觉模块未加载，请重新加载扩展并刷新题目页');
        images = await window.__MAS_VISION__.prepare(q);
      }
    } catch (error) { return { ok: false, error: error.message }; }
    const payload = {
      hash: q.hash, stem: q.stem, type: q.type,
      ...(q.type === 'text' ? { blankCount: q.answerInputs.length, blanks: q.blanks } : {}),
      ...(images.length ? { images } : {}),
      options: q.options.filter(o => !o.unavailable).map(o => ({letter:o.letter,text:o.text})), url:location.href
    };
    let response = await runtimeRequest({type:'MCQ_SOLVE',payload});
    if (!response?.ok && response?.imageReadFailed && images.some(image => image.url)) {
      try {
        if (captureCancelled()) throw new Error('作答已取消');
        if (!q.container.isConnected || !liveQuestion(q)) throw new Error('题目已变化，请重新扫描');
        const cropped = await window.__MAS_VISION__.captureFallback(q,images);
        if (captureCancelled()) throw new Error('作答已取消');
        if (!q.container.isConnected || !liveQuestion(q)) throw new Error('截图后题目已变化，已停止求解');
        response = await runtimeRequest({type:'MCQ_SOLVE',payload:{...payload,images:cropped}});
      } catch (error) { return {ok:false,error:response.error + '；' + error.message}; }
    }
    return response || {ok:false,error:'无响应'};
  }

  // ---------------- 单题处理 ----------------

  /** 问模型 + 高亮 + （按模式）点选 + 校验。返回是否成功选上。 */
  async function handleQuestion(q) {
    state.done.add(q.hash);
    if (q.incomplete) {
      state.stats.failed++;
      log({ level: 'err', stem: q.stem, pick: '!', why: '识别不完整：' + q.issues.join('；') });
      return false;
    }
    state.stats.asked++;

    const res = await ask(q);
    if (!state.running) return false;

    const numeric = q.type === 'numeric';
    const text = q.type === 'text';
    const hasAnswer = text ? textValues(q, res.values) !== null : numeric ? numericValue(res.value) !== null : res.letters && res.letters.length &&
      (!(q.answerSelect || q.answerCell) || res.letters.length === 1 && q.options.some(o => o.letter === res.letters[0]));
    if (!res.ok || !hasAnswer) {
      state.stats.failed++;
      log({ level: 'err', stem: q.stem, pick: '×', why: res.error || '模型没有给出可用答案' });
      return false;
    }
    if (text && (!liveQuestion(q) || q.answerInputs.some(input => !input.isConnected))) {
      state.stats.failed++;
      log({ level: 'err', stem: q.stem, pick: '!', why: '填空题或输入框已变化，已跳过填写和提交' });
      return false;
    }

    state.stats.answered++;
    highlightAnswers.set(q.hash, res);
    const low = typeof res.confidence === 'number' && res.confidence < 0.5;
    clearMarks(q);
    mark(q, numeric || text ? [] : res.letters, low, res.values, res.value);
    log({
      level: low ? 'warn' : 'ok',
      stem: q.stem,
      pick: text ? res.values.map((value, index) => (index + 1) + ': ' + value).join(' / ') : numeric ? numericValue(res.value) : res.letters.join(''),
      why: (res.cached ? '[缓存] ' : '') + (res.reason || '')
    });

    if (state.settings.mode === 'highlight') return true;

    const applied = text ? await applyTextAnswer(q, res.values) : numeric ? await applyNumericAnswer(q, res.value) : await applyAnswer(q, res.letters);
    if (applied === false) {
      if (text || q.answerCell || q.answerNumberCell) { state.stats.failed++; state.stats.answered--; }
      log({ level: 'err', stem: q.stem, pick: '!', why: text || q.answerNumberCell ? '填空未全部写入或校验失败，已跳过提交，请手动处理' : '点击没有生效，已跳过提交，请手动处理' });
      return false;
    }
    await sleep(state.settings.actionDelay);
    return true;
  }

  /** 一页多题时的批处理（并发问模型） */
  async function handleBatch(qs) {
    let ok = 0;
    const queue = qs.slice();
    // Connect 分题常有前后依赖，且共用编辑器；按页面顺序完成求解和保存再处理下一空。
    const concurrency=qs.some(q=>q.answerCell||q.answerNumberCell)?1:Math.max(1,state.settings.concurrency);
    const workers = Array.from({ length: concurrency }, async () => {
      while (state.running && queue.length) {
        const q = queue.shift();
        setMeta(`处理中… 已答 ${state.stats.answered} / 失败 ${state.stats.failed} / 第 ${state.stats.rounds} 轮`);
        if (await handleQuestion(q)) ok++;
      }
    });
    await Promise.all(workers);
    return ok;
  }

  // ---------------- 扫描 ----------------

  async function scanOnly() {
    await loadSettings();
    await D.refreshConnectChoices?.();
    const qs = D.collect(document, { includeReadOnly: true });
    qs.forEach((q) => {
      if (q.type === 'text') q.answerInputs.forEach(input => input.classList.add('__mcq_scan'));
      else if (q.answerCell) q.answerCell.classList.add('__mcq_scan');
      else if (q.type === 'numeric') { const control=q.answerNumberCell||q.answerInput;if(control)control.classList.add('__mcq_scan'); }
      else q.options.forEach((o) => o.clickTarget.classList.add('__mcq_scan'));
    });
    setTimeout(() => document.querySelectorAll('.__mcq_scan').forEach((e) => e.classList.remove('__mcq_scan')), 4000);

    const readOnly = qs.length > 0 && qs.every((q) => q.readOnly);
    const btn = readOnly ? null : findAdvanceButton(qs.length === 1 ? qs[0].container : null);
    const matchingOnly = qs.length > 0 && qs.every(q => q.kind === 'matching');
    setMeta(`扫描到 ${qs.length} ${matchingOnly ? '个配对项' : '道题'}${readOnly ? ' · 已提交/只读页面，仅供查看' : qs.length === 1 ? '（一页一题模式）' : ''} · 提交按钮：${btn ? btn.label : '未找到'}`);
    qs.forEach((q) =>
      log({
        level: q.incomplete ? 'warn' : undefined,
        stem: q.stem || '(无题干)',
        pick: q.incomplete ? '缺失' : q.type === 'text' ? '填空' : q.kind === 'matching' ? '配对' : q.type === 'numeric' ? '数字' : q.type === 'multi' ? '多选' : String(q.options.filter((o) => !o.unavailable).length),
        why: (q.incomplete ? '识别不完整：' + q.issues.join('；') + '\n' : '') + (q.type === 'text' ? '文本填空 · ' + q.answerInputs.length + ' 个空' + (q.readOnly ? '（已提交/只读）' : '') : q.type === 'numeric'
          ? (q.questionNumber ? 'Canvas 第 ' + q.questionNumber + ' 题 · ' : '') + '数字填空' + (q.readOnly ? '（已提交/只读）' : '')
          : q.options.map((o) => o.letter + '. ' + (o.unavailable ? '[空选项：网页未提供文字]' : o.text)).join('\n'))
      })
    );
    return qs.length;
  }

  // ---------------- 主循环 ----------------

  async function loadSettings() {
    const { mcqSettings } = await chrome.storage.local.get('mcqSettings');
    state.settings = { ...DEFAULTS, ...(mcqSettings || {}) };
    return state.settings;
  }

  async function start(options) {
    if (D.isDelegatedConnectFrame?.()) return;
    if (state.running || panelHidden) return;
    const startEpoch = highlightEpoch;
    const resumeSession = options && options.resumeSession;
    await loadSettings();
    await D.refreshConnectChoices?.();
    if (state.running || panelHidden || startEpoch !== highlightEpoch) return;
    if (isReadOnlyQuiz()) {
      setMeta('已提交/只读测验页面，请打开可作答的测验页面');
      endSession(false);
      return;
    }
    if (!state.settings.apiKey) {
      setMeta('缺少 API Key —— 请先在插件弹窗里填写');
      log({ level: 'err', stem: '未配置 API Key', pick: '×', why: '点击工具栏图标打开设置' });
      return;
    }

    if (resumeSession) {
      state.done = new Set(Array.isArray(resumeSession.done) ? resumeSession.done : []);
    } else {
      state.done.clear();
      // 顶层 frame 建立标签页会话；实际做题的子 frame 会在保存进度时加入 owners。
      if (IS_TOP) await beginSession();
    }

    if (panelHidden) {
      endSession(true);
      return;
    }

    state.running = true;
    state.stats = { asked: 0, answered: 0, failed: 0, rounds: 0, timeouts: 0 };
    buildPanel();
    setBusy(true);

    const { mode, maxRounds, submitDelay } = state.settings;
    setMeta(`${resumeSession ? '已恢复上一页的运行状态' : '已启动'} · 模式：${MODE_NAME[mode]}`);

    let qs = pendingQuestions();
    let reason = null;

    while (state.running && state.stats.rounds < maxRounds) {
      state.stats.rounds++;
      if (document.querySelector('.worksheet__main iframe.external[title="Assessment Tool iFrame"]')) {
        await D.refreshConnectChoices?.();
        if (!state.running) break;
        qs = pendingQuestions();
      }

      if (!qs.length) {
        if (isReadOnlyQuiz()) {
          reason = '测验已提交，当前是只读结果页面';
          break;
        }
        // 刷新后的对错反馈页通常仍保留刚答过的题目和一个 Next。
        // 看到的题全在 done 里时直接推进，不再白等 3 秒。
        const visible = D.collect();
        const answeredFeedback = visible.length > 0 && visible.every((q) => state.done.has(q.hash));
        const entry = findAdvanceButton(null, { excludeChrome: true, onlyStart: true });
        if (!answeredFeedback && !entry) qs = await waitForNewQuestion(3000);
      }
      if (!qs.length) {
        if (mode !== 'submit' && !findAdvanceButton(null, { excludeChrome: true, onlyStart: true })) {
          reason = '本页没有发现新题目';
          break;
        }
        // 可能停在「开始测验 / 查看结果」这种中间页，试着往前推一步
        const r = await advance(null);
        if (r.navigating) return;
        if (!r.ok) {
          reason = r.reason || '没有更多题目了';
          break;
        }
        qs = r.questions;
        continue;
      }

      const singleQuestion = qs.length === 1;
      setMeta(
        `第 ${state.stats.rounds} 轮 · ${singleQuestion ? '一页一题' : qs.length + (qs.every(q => q.kind === 'matching') ? ' 个配对项' : ' 道题')} · 已答 ${state.stats.answered} / 失败 ${state.stats.failed}`
      );

      let anchor = null;
      let ok;
      if (singleQuestion) {
        anchor = qs[0].container;
        ok = await handleQuestion(qs[0]);
      } else {
        // 页面中存在未正常作答的题目时不能把其它题目的成功当成整页可提交。
        ok = (await handleBatch(qs)) === qs.length;
      }
      if (!state.running) break;

      if (mode !== 'submit') {
        qs = pendingQuestions();
        if (!qs.length) {
          reason = '本页已处理完';
          break;
        }
        continue;
      }

      if (!ok) {
        reason = '本题没能正常作答，已停在这里等你处理';
        break;
      }

      await sleep(submitDelay);
      if (!state.running) break;
      if (qs.some(q => q.type === 'text' && !textAnswerMatches(q, highlightAnswers.get(q.hash)?.values))) {
        reason = '提交前填空内容或控件发生变化，已停止提交';
        break;
      }
      if (qs.some(q => q.answerCell && (!liveQuestion(q) || !verifySelection(q,highlightAnswers.get(q.hash)?.letters || [])))) {
        reason = '提交前表格选择内容发生变化，已停止翻页';
        break;
      }
      if(qs.some(q=>q.answerNumberCell&&(!liveQuestion(q)||connectNumericValue(q.answerNumberCell)!==numericValue(highlightAnswers.get(q.hash)?.value)))){
        reason='翻页前表格数字内容发生变化，已停止翻页';break;
      }

      const r = await advance(anchor);
      if (r.navigating) return;
      if (!r.ok) {
        reason = r.reason || '流程结束';
        break;
      }
      qs = r.questions;
    }

    if (state.running && state.stats.rounds >= state.settings.maxRounds) reason = '达到最大轮数上限';
    if (reason) log({ level: 'warn', stem: reason, pick: '■', why: '已停止' });
    stop(reason || null, false);
  }

  function stop(reason, manual) {
    const was = state.running;
    state.running = false;
    setBusy(false);
    endSession(manual);
    if (was || reason) {
      setMeta(`${reason || '已停止'} · 答出 ${state.stats.answered} 题 / 失败 ${state.stats.failed} / ${state.stats.rounds} 轮`);
    }
  }

  // ---------------- 消息入口 ----------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (D.isDelegatedConnectFrame?.() && ['MCQ_SCAN','MCQ_START','MCQ_STOP','MCQ_RESET'].includes(msg?.type)) return;
    switch (msg && msg.type) {
      case 'MAS_HIGHLIGHTS':
        if (typeof msg.payload?.visible === 'boolean') {
          const visible = msg.payload.visible && !document.hidden;
          showAnswers(visible);
          if (visible) prepareHighlights();
        }
        sendResponse({ ok: true });
        break;
      case 'MCQ_SCAN':
        setPanelHidden(false);
        buildPanel();
        scanOnly().then((n) => sendResponse({ ok: true, count: n }));
        return true;
      case 'MCQ_START':
        cancelOnePick();
        setPanelHidden(false);
        buildPanel();
        start({ resumeSession: null });
        sendResponse({ ok: true });
        break;
      case 'MCQ_STOP':
        cancelOnePick();
        stop('用户手动停止', true);
        sendResponse({ ok: true });
        break;
      case 'MCQ_RESET':
        cancelOnePick();
        onePickCompleted.clear();
        state.done.clear();
        highlightAnswers.clear();
        saveSessionProgress(true);
        setMeta('已清空去重记录，可以重新作答');
        sendResponse({ ok: true });
        break;
      case 'MCQ_PANEL': // background 从子 frame 转发过来的日志
        if (IS_TOP) {
          if (msg.payload.kind === 'meta') setMeta('[iframe] ' + msg.payload.text);
          else log(msg.payload.entry);
        }
        break;
    }
  });

  // 排查用：在控制台里可以看到检测器/按钮识别到了什么
  // 例如 __MCQ_DEBUG__.findAdvanceButton(null) 能确认「提交」按钮有没有被认出来
  window.__MCQ_DEBUG__ = {
    state,
    highlightStatus,
    onePickStatus,
    scanStats,
    pendingQuestions,
    findAdvanceButton,
    isDisabled,
    isHardDisabled,
    waitForProgress,
    advance
  };

  // Submit / Next 造成整页导航时，旧内容脚本会连同页面一起销毁。
  // 新页面在 document_idle 重新注入后，从标签页会话恢复并继续。
  (async () => {
    const res = await runtimeRequest({ type: 'MCQ_SESSION_GET' });
    if (!res || !res.session || !res.session.active || state.running) return;
    if (res.session.kind === 'highlight') {
      setPanelHidden(true);
      highlightEntrySession = true;
      const epoch = highlightEpoch;
      const { mcqSettings } = await chrome.storage.local.get('mcqSettings');
      const deadline = performance.now() + Math.max(1000, Number(mcqSettings?.pageTimeout) || DEFAULTS.pageTimeout);
      while (epoch === highlightEpoch && performance.now() < deadline &&
        !D.collect(document, { includeReadOnly: true }).length &&
        !findAdvanceButton(null, { excludeChrome: true, onlyStart: true })) await sleep(100);
      if (epoch === highlightEpoch) await prepareHighlights();
      return;
    }
    buildPanel();
    setMeta('新页面已载入，正在恢复自动答题…');
    start({ resumeSession: res.session });
  })();

  // Esc 紧急刹车
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        if (D.isDelegatedConnectFrame?.()) {
          // 焦点在工具 iframe 时，Esc 也必须中断实际拥有作答队列的外层。
          window.parent.document.dispatchEvent(new window.parent.KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true}));
        }
        cancelOnePick();
        hideAnswers();
        highlightEpoch++;
        highlightRequested = false;
        highlightStatus.phase = 'idle';
        if (highlightEntrySession) {
          highlightEntrySession = false;
          endSession(true);
        }
        if (state.running) stop('Esc 中断', true);
      }
    },
    true
  );
})();
