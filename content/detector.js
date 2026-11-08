/**
 * MCQ 检测器：把页面上的选择题抽取成结构化数据。
 * 暴露全局 window.__MCQ_DETECTOR__.collect() -> Question[]
 *
 * Question = {
 *   hash: string,
 *   stem: string,
 *   type: 'single' | 'multi' | 'numeric' | 'text',
 *   container: Element,
 *   options: [{ letter, text, input?, clickTarget }]
 * }
 */
(function () {
  'use strict';
  if (window.__MCQ_DETECTOR__) return;

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const MAX_STEM_LEN = 1500;
  const MAX_OPTION_LEN = 400;
  // 选项文本常见的前缀：A. / (B) / 3、 / D：
  const LETTER_PREFIX = /^\s*[（(\[]?\s*([A-Za-z]|\d{1,2})\s*[)）.．、\]:：]\s+?/;

  const elIds = new WeakMap();
  let elIdSeq = 0;
  function idFor(el) {
    if (!el) return 'null';
    if (!elIds.has(el)) elIds.set(el, 'e' + ++elIdSeq);
    return elIds.get(el);
  }

  function norm(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function text(el) {
    if (!el) return '';
    // innerText 会忽略 display:none 的内容，比 textContent 更贴近用户所见
    return norm(el.innerText != null ? el.innerText : el.textContent);
  }

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (_) {
      return { width: 0, height: 0 };
    }
  }

  function labelElementFor(input) {
    if (input.labels && input.labels.length) {
      return Array.from(input.labels).find(label => label.htmlFor === input.id) || input.labels[0];
    }
    const doc = input.ownerDocument || document;
    if (input.id) {
      const esc = window.CSS && CSS.escape ? CSS.escape(input.id) : input.id.replace(/["\\]/g, '\\$&');
      const lab = doc.querySelector('label[for="' + esc + '"]');
      if (lab) return lab;
    }
    return input.closest('label');
  }

  const CANVAS_QUESTION = '.question.multiple_choice_question, .question.multiple_answers_question, .question.true_false_question';
  const CANVAS_NUMERIC_QUESTION = '.question.numerical_question, .question.calculated_question';
  const CANVAS_MATCHING_QUESTION = '.question.matching_question';
  const VISUAL_SELECTOR = 'img, svg, canvas';
  const CONNECT_FRAME = '.worksheet__main iframe.external[title="Assessment Tool iFrame"]';
  const connectChoiceCache = new WeakMap();
  const connectRuntimeChoices = new WeakMap();
  const connectRuntimeIssues = new WeakMap();
  let connectReadTask = null;

  async function refreshConnectChoices() {
    if (connectReadTask) return connectReadTask;
    const frames = Array.from(document.querySelectorAll(CONNECT_FRAME)).filter(isVisible);
    if (!frames.length) return;
    connectReadTask = (async () => {
      const targets = frames.map(frame => {
        const doc = frame.contentDocument;
        return {frame,doc,cells:new Set(doc?.querySelectorAll('#jQuerySheet td.responseCell') || []),token:crypto.randomUUID()};
      });
      targets.forEach(({frame,token}) => frame.setAttribute('data-mas-connect-target',token));
      try {
        const response = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({type:'MCQ_CONNECT_CHOICES',payload:{targets:targets.map(({token})=>({token}))}}, reply =>
              resolve(chrome.runtime.lastError ? null : reply));
          } catch (_) { resolve(null); }
        });
        if (!response?.ok || !Array.isArray(response.frames)) return;
        for (const {frame,doc:originalDocument,cells:originalCells,token} of targets) {
          if (!frame.isConnected || frame.getAttribute('data-mas-connect-target') !== token) continue;
          const record = response.frames.find(item => item.token === token);
          try {
            const doc = frame.contentDocument;
            if (doc !== originalDocument) continue;
            const cells = doc?.querySelectorAll('#jQuerySheet table.jSheet td.dropDownList.responseCell[dropdownid]') || [];
            for (const cell of cells) {
              connectRuntimeChoices.delete(cell);
              connectRuntimeIssues.delete(cell);
              if (!originalCells.has(cell)) continue;
              const item = record?.cells?.find(item => item.id === cell.id && item.dropdownId === cell.getAttribute('dropdownid'));
              if (item?.issue) connectRuntimeIssues.set(cell,String(item.issue));
              if (item && Array.isArray(item.options) && item.options.every(value=>typeof value==='string')) {
                connectRuntimeChoices.set(cell,item.options.map(norm).filter(Boolean).sort((a,b)=>a.localeCompare(b)));
              }
            }
          } catch (_) {}
        }
      } finally {
        targets.forEach(({frame,token}) => {if(frame.getAttribute('data-mas-connect-target')===token)frame.removeAttribute('data-mas-connect-target');});
      }
    })().finally(() => {connectReadTask=null;});
    return connectReadTask;
  }

  function isDelegatedConnectFrame() {
    try { return !!window.frameElement?.matches(CONNECT_FRAME) && !!window.parent.__MCQ_DETECTOR__ && !!document.querySelector('body.accountingtool_baseaccountingtool #jQuerySheet'); }
    catch (_) { return false; }
  }

  function connectCellText(cell) {
    const copy = cell.cloneNode(true);
    copy.querySelectorAll('.__mas_select_hint').forEach(el => el.remove());
    return norm(copy.textContent);
  }

  function connectMenuFor(cell, visibleOnly = false) {
    return Array.from(cell.ownerDocument.querySelectorAll('.listContainer [role="listbox"]')).find(menu =>
      (menu.getAttribute('aria-labelledby') || '').split(/\s+/).includes(cell.id) && (!visibleOnly || isVisible(menu)));
  }

  function connectSentence(cell) {
    const row = cell.parentElement;
    if (!row?.matches('tr') || !cell.classList.contains('aria-element')) return null;
    const fields = Array.from(row.cells).filter(td => td.classList.contains('responseCell'));
    const parts = Array.from(row.cells).map(td => fields.includes(td) ? '[Blank ' + (fields.indexOf(td)+1) + ']' : connectCellText(td));
    if (!parts.some(part => part && !/^\[Blank \d+\]$/.test(part))) return null;
    return {text:norm(parts.join(' ')),index:fields.indexOf(cell)+1};
  }

  // 仅收集题目内容区域，不读取头像、导航、隐藏原文或评分反馈。
  function visualsIn(node) {
    return node ? Array.from(node.querySelectorAll(VISUAL_SELECTOR)).filter(el =>
      visualVisible(el) && !el.closest('[aria-hidden="true"], .original_question_text, .after_answers, .answer_comments, .__mas_select_hint') &&
      (el.tagName.toLowerCase() !== 'svg' || !el.closest('svg svg'))
    ) : [];
  }

  function visualVisible(el) {
    if (isVisible(el)) return true;
    if (el.tagName.toLowerCase() !== 'img' || !el.isConnected || !el.src || el.complete) return false;
    // 无固有尺寸的懒加载图片仍属于题目，不能漏图后当成纯文字题。
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function attachVisuals(q) {
    const probe = q.container.closest('avalon-probe-renderer');
    const mcgrawPrompt = probe && q.container.closest('aa-air-item')?.querySelector('.prompt');
    const stemNode = mcgrawPrompt || (q.groupContainer || q.container.closest('fieldset') || q.container).querySelector('.question_text, .question-area');
    const nodes = new Map();
    const add = (node, label) => visualsIn(node).forEach(el => { if (!nodes.has(el)) nodes.set(el, label); });
    add(stemNode || q.container, 'Question image');
    // Connect 的图表在外层题干，作答格在同源 iframe；各小题必须携带共同图表。
    if (q.connectPrompt) visualsIn(q.connectPrompt).forEach(el => {
      if (el.closest('.worksheet__main') === q.connectPrompt &&
          !el.closest('header,footer,nav,aside,[role="navigation"],.gaspar_audio__container,#goReactSpinner,.loading,.spinner') &&
          !nodes.has(el)) nodes.set(el, 'Question image');
    });
    // McGraw Hill 将图表放在选项容器之外的左侧图片组件中。
    // 仅关联当前 probe 的专用图片区，不能扩大到整页或相邻题目。
    if (probe) probe.querySelectorAll('avalon-image-renderer').forEach(renderer => {
      if (renderer.closest('avalon-probe-renderer') === probe) add(renderer, 'Question image');
    });
    q.options.forEach(o => add(o.clickTarget, 'Option ' + o.letter + ' image'));
    q.visuals = Array.from(nodes, ([element, label]) => ({ element, label,
      source: element.currentSrc || element.src || '',
      signature: visualSignature(element)
    }));
    if (q.visuals.length) q.hash = hashOf(q.hash + '::vision-v1::' + q.visuals.map(v => v.label + v.signature).join('||'));
    return q;
  }

  function visualSignature(element) {
    // currentSrc在懒加载/srcset选源时变化，不应把同一道题误当成新题。
    if (element.tagName.toLowerCase() === 'img') return element.src + '|' + (element.getAttribute('srcset') || '');
    if (element.tagName.toLowerCase() === 'canvas') {
      try { return element.toDataURL(); } catch (_) { return element.outerHTML; }
    }
    return element.outerHTML;
  }

  function isUsableInput(input, includeReadOnly) {
    const locked = input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true';
    if (locked && !(includeReadOnly && input.closest(CANVAS_QUESTION))) return false;
    if (input.closest('[aria-hidden="true"]')) return false;
    if (input.closest('#__mcq_panel_host')) return false;
    const r = rectOf(input);
    if (r.width > 0 && r.height > 0) return true;
    // 很多站点把原生 radio 藏起来，只渲染 label
    const lab = labelElementFor(input);
    if (lab) {
      const lr = rectOf(lab);
      return lr.width > 0 && lr.height > 0;
    }
    return false;
  }

  /**
   * 优先点 label 而不是 input：站点常把原生 input 设成 opacity:0 / 挪到屏幕外，
   * 只渲染自定义的 label（jcf、各种 UI 库都这么干）。点 label 既能原生激活 input，
   * 又能触发站点自己挂在 label 上的处理函数。
   */
  function pickClickTarget(input) {
    const lab = labelElementFor(input);
    if (lab) {
      const lr = rectOf(lab);
      if (lr.width > 0 && lr.height > 0) return lab;
    }
    return input;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('#__mcq_panel_host')) return false;
    const r = rectOf(el);
    return r.width > 0 && r.height > 0;
  }

  /** 拿到某个 input 对应的选项文本 */
  function labelTextFor(input) {
    const lab = labelElementFor(input);
    let t = lab ? text(lab) : '';
    if (!t && visualsIn(lab).length) t = '[Image option]';
    if (!t) {
      // 向上找一个「只包含这一个表单控件」的容器，它的文字通常就是选项
      let node = input.parentElement;
      let depth = 0;
      while (node && depth < 4) {
        if (node.querySelectorAll('input, textarea, select').length > 1) break;
        const t2 = text(node);
        if (t2) {
          t = t2;
          break;
        }
        node = node.parentElement;
        depth++;
      }
    }
    if (!t) t = norm(input.getAttribute('aria-label') || input.getAttribute('title') || input.value);
    return t.slice(0, MAX_OPTION_LEN);
  }

  /** 找到「包含同类型控件 >= 2 个」的最近祖先，用来给未命名的 checkbox 分组 */
  function nearestGroupContainer(input) {
    let node = input.parentElement;
    let depth = 0;
    while (node && depth < 8 && node !== document.body) {
      if (node.querySelectorAll('input[type="' + input.type + '"]').length >= 2) return node;
      node = node.parentElement;
      depth++;
    }
    return input.parentElement;
  }

  function commonAncestor(els) {
    if (!els.length) return document.body;
    let node = els[0].nodeType === 1 ? els[0] : els[0].parentElement;
    for (let i = 1; i < els.length; i++) {
      while (node && !(node === els[i] || node.contains(els[i]))) node = node.parentElement;
      if (!node) return document.body;
    }
    return node;
  }

  const CHOICE_CONTROLS = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"]';

  /**
   * 往上爬的时候不能跨进「含有别的题目的选项控件」的容器，
   * 否则题干会把整页的文字都吸进来（也会让页面上的 UI 开关被误判成题目）。
   */
  function ownsOnly(node, optionEls) {
    const found = node.querySelectorAll(CHOICE_CONTROLS);
    for (const c of found) {
      // c.contains(o)：有些站点用 <label role="radio"> 反过来包着真正的 <input>，
      // 这种「控件包着我们的选项」也算自己人，不能当成别的题目
      if (!optionEls.some((o) => o === c || o.contains(c) || c.contains(o))) return false;
    }
    return true;
  }

  /** 这个节点本身像不像「另一道题的选项区」——用来防止题干兜底时吞掉上一道题 */
  function looksLikeOptionBlock(el) {
    if (el.querySelector(CHOICE_CONTROLS)) return true;
    for (const list of el.querySelectorAll('ul, ol, [class*="option"], [class*="choice"], [class*="answer"]')) {
      const kids = Array.from(list.children);
      if (kids.length >= 2 && kids.every((k) => LETTER_PREFIX.test(text(k)))) return true;
    }
    return false;
  }

  /**
   * 选项容器上的 aria-labelledby 往往直接指着题干（无障碍规范要求），
   * 比「父容器文本减选项」可靠得多，优先用它。
   */
  function ariaStem(common, optionEls) {
    const doc = common.ownerDocument || document;
    let node = common;
    for (let i = 0; i < 3 && node && node !== doc.body; i++) {
      const ref = node.getAttribute && node.getAttribute('aria-labelledby');
      if (ref) {
        const targets = ref
          .split(/\s+/)
          .map((id) => doc.getElementById(id))
          .filter(Boolean)
          // 指向的节点如果把选项也包在里面，那它不是题干而是整块区域
          .filter((el) => !optionEls.some((o) => el.contains(o)));
        const t = norm(targets.map(text).join(' '));
        if (t.length >= 8) return t.length > MAX_STEM_LEN ? t.slice(-MAX_STEM_LEN) : t;
      }
      node = node.parentElement;
    }
    return '';
  }

  /**
   * 优先读取第一组选项之前的内容。对错反馈通常插在选项后面；如果直接拿整块容器文字，
   * "Correct… / More on this topic / Next" 会混进题干，让同一道题提交前后的 hash 不同。
   */
  function precedingStem(common, optionEls) {
    const first = optionEls[0];
    if (!common || !first) return '';
    let node = common;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      let branch = first;
      while (branch && branch.parentElement !== node) branch = branch.parentElement;
      if (branch) {
        let sib = branch.previousElementSibling;
        let guard = 0;
        while (sib && guard++ < 5) {
          if (!looksLikeOptionBlock(sib)) {
            const t = text(sib);
            if (t.length >= 8) return t.length > MAX_STEM_LEN ? t.slice(-MAX_STEM_LEN) : t;
          }
          sib = sib.previousElementSibling;
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  /** 从选项容器往上找题干：父容器文本减去所有选项文本 */
  function findStem(common, optionTexts, optionEls) {
    const aria = ariaStem(common, optionEls);
    if (aria) return aria;
    const before = precedingStem(common, optionEls);
    if (before) return before;

    let node = common;
    for (let i = 0; i < 7 && node && node !== document.documentElement; i++) {
      if (i > 0 && !ownsOnly(node, optionEls)) break;
      let t = text(node);
      for (const ot of optionTexts) {
        if (ot && ot.length > 1) t = t.split(ot).join(' | ');
      }
      t = norm(t.replace(/\|+/g, ' ').replace(/\s+/g, ' '));
      if (t.length >= 8) return t.length > MAX_STEM_LEN ? t.slice(-MAX_STEM_LEN) : t;
      node = node.parentElement;
    }
    // 兜底：往前找兄弟节点的文字
    let sib = common ? common.previousElementSibling : null;
    let guard = 0;
    while (sib && guard++ < 5) {
      if (!looksLikeOptionBlock(sib)) {
        const t = text(sib);
        if (t.length >= 8) return t.slice(-MAX_STEM_LEN);
      }
      sib = sib.previousElementSibling;
    }
    return '';
  }

  function hashOf(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'q' + h.toString(36);
  }

  function stripPrefix(s) {
    const out = s.replace(LETTER_PREFIX, '');
    return out.length >= 1 ? out : s;
  }

  // ---------- 三种候选来源 ----------

  /** 1) 原生 radio / checkbox */
  function inputGroups(root, includeReadOnly) {
    const inputs = Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((input) => isUsableInput(input, includeReadOnly));
    const groups = new Map();
    for (const input of inputs) {
      let key;
      if (input.type === 'radio' && input.name) {
        key = 'r|' + idFor(input.form) + '|' + input.name;
      } else {
        key = 'c|' + input.type + '|' + idFor(nearestGroupContainer(input));
      }
      if (!groups.has(key)) groups.set(key, { type: input.type === 'radio' ? 'single' : 'multi', els: [] });
      groups.get(key).els.push(input);
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.els.length < 2) continue;
      out.push({
        type: g.type,
        optionEls: g.els,
        options: g.els.map((input) => ({
          input,
          clickTarget: pickClickTarget(input),
          raw: labelTextFor(input)
        }))
      });
    }
    return out;
  }

  /** 2) ARIA 自定义控件 */
  function ariaGroups(root) {
    const out = [];
    root.querySelectorAll('[role="radiogroup"], [role="listbox"]').forEach((g) => {
      if (g.closest('body.accountingtool_baseaccountingtool .listContainer')) return; // Connect 的共享菜单不是一道独立题。
      const opts = Array.from(g.querySelectorAll('[role="radio"], [role="option"]')).filter(isVisible);
      if (opts.length < 2) return;
      if (opts.some((o) => o.querySelector('input[type="radio"], input[type="checkbox"]'))) return; // 交给 inputGroups
      out.push({
        type: g.getAttribute('aria-multiselectable') === 'true' ? 'multi' : 'single',
        optionEls: opts,
        options: opts.map((el) => ({ input: null, clickTarget: el, raw: text(el).slice(0, MAX_OPTION_LEN) }))
      });
    });
    return out;
  }

  /** 3) 纯 div/li 列表，靠 "A." "B)" 这样的前缀识别 */
  function letteredGroups(root) {
    const out = [];
    const containers = root.querySelectorAll(
      'ul, ol, [class*="option"], [class*="Option"], [class*="choice"], [class*="Choice"], [class*="answer"], [class*="Answer"]'
    );
    const seen = new Set();
    containers.forEach((c) => {
      if (!isVisible(c) || seen.has(c)) return;
      if (c.closest(CANVAS_NUMERIC_QUESTION + ', ' + CANVAS_MATCHING_QUESTION)) return;
      if (c.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"]')) return;
      const kids = Array.from(c.children).filter(isVisible);
      if (kids.length < 2 || kids.length > 12) return;
      const letters = [];
      for (const k of kids) {
        const m = text(k).match(LETTER_PREFIX);
        if (!m) return;
        letters.push(m[1].toUpperCase());
      }
      if (new Set(letters).size !== letters.length) return;
      kids.forEach((k) => seen.add(k));
      seen.add(c);
      out.push({
        type: 'single',
        optionEls: kids,
        options: kids.map((el) => ({ input: null, clickTarget: el, raw: text(el).slice(0, MAX_OPTION_LEN) }))
      });
    });
    return out;
  }

  // ---------- 汇总 ----------

  /** Canvas 行标签可能只有 a/b/c；完整情境在题干中，必须连同题干一起发出。 */
  function canvasMatchingQuestions(root, includeReadOnly) {
    const containers = Array.from(root.querySelectorAll(CANVAS_MATCHING_QUESTION));
    if (root.matches?.(CANVAS_MATCHING_QUESTION)) containers.unshift(root);
    return containers.flatMap(container => {
      const stemNode = container.querySelector('.question_text');
      if (!isVisible(container) || !isVisible(stemNode)) return [];
      const instruction = text(stemNode); // 不截断末尾的匹配描述
      return Array.from(container.querySelectorAll('.answers select')).filter(isVisible).flatMap((select, index) => {
        const readOnly = select.disabled || select.getAttribute('aria-disabled') === 'true';
        if (readOnly && !includeReadOnly) return [];
        const description = text(labelElementFor(select));
        const options = Array.from(select.options).filter(o => o.value !== '' && !o.disabled && !o.hidden && !o.parentElement.disabled &&
          !/^\[?\s*(?:choose|select)\s*\]?$/i.test(norm(o.textContent))).map((o, i) => ({
            letter: LETTERS[i] || String(i + 1), text: norm(o.textContent), raw: norm(o.textContent),
            input: null, clickTarget: select, selectOption: o, value: o.value
          }));
        const issues = [];
        if (!description || !instruction) issues.push('匹配题缺少题干或行标签');
        if (select.multiple || options.length < 2 || options.some(o => !o.text) || new Set(options.map(o => o.value)).size !== options.length) issues.push('匹配选项不完整或无法唯一映射');
        const stem = instruction + '\nMatch ONLY this row: ' + (description || '[missing label]');
        return [{ hash: hashOf(stem + '::canvas-matching::' + index + '::' + options.map(o => o.text).join('||')),
          stem, type: 'single', kind: 'matching', matchingRow: index + 1, container, groupContainer: container,
          answerSelect: select, options, readOnly, incomplete: issues.length > 0, issues }];
      });
    });
  }

  /** Sage 配对题：每个下拉框是一条独立配对项，选项值在各行之间并不相同。 */
  function sageMatchingQuestions(root, includeReadOnly) {
    const questions = [];
    root.querySelectorAll('.question-area[id^="matchingType"]').forEach(stemNode => {
      const fieldset = stemNode.closest('fieldset');
      if (!fieldset || !isVisible(stemNode)) return;
      const instruction = text(stemNode);
      const selects = Array.from(fieldset.querySelectorAll('.answer-area select'));
      selects.forEach((select, index) => {
        if (!isVisible(select) || select.closest('[aria-hidden="true"]')) return;
        const readOnly = select.disabled || select.getAttribute('aria-disabled') === 'true';
        if (readOnly && !includeReadOnly) return;
        const label = labelElementFor(select);
        const description = text(label);
        const options = Array.from(select.options).filter(option => {
          const value = option.value;
          const labelText = norm(option.textContent);
          return !option.disabled && !option.hidden && !option.parentElement.disabled && value !== '' &&
            !/^(?:select|choose)(?: an?| your)? (?:option|answer|category)[.!…]*$|^please select|^请选择/i.test(labelText);
        }).map((option, i) => ({
          letter: LETTERS[i] || String(i + 1),
          text: norm(option.getAttribute('data-answertext') || option.textContent).slice(0, MAX_OPTION_LEN),
          raw: norm(option.textContent), input: null, clickTarget: select,
          selectOption: option, value: option.value
        }));
        const stem = (instruction + '\nDescription: ' + (description || '[配对描述缺失]')).slice(0, MAX_STEM_LEN);
        const issues = [];
        if (!description) issues.push('下拉框缺少对应的配对描述');
        if (select.multiple) issues.push('配对项为多选下拉框，暂不自动作答');
        if (options.length < 2 || options.some(option => !option.text)) issues.push('配对选项文字不足');
        if (new Set(options.map(option => option.value)).size !== options.length) issues.push('下拉选项值重复，无法确定目标');
        questions.push({
          hash: hashOf(stem + '::matching::' + options.map(option => option.text).join('||')),
          stem, type: 'single', kind: 'matching', matchingRow: index + 1,
          container: select.closest('.choice') || select.parentElement,
          answerSelect: select, groupContainer: fieldset, options,
          readOnly, incomplete: issues.length > 0, issues
        });
      });
    });
    return questions;
  }

  /** Connect Accounting Tool：一行一个自定义下拉单元格，共用浮动候选菜单。 */
  function connectMatchingQuestions(root, includeReadOnly, instruction) {
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const tables = root.querySelectorAll('body.accountingtool_baseaccountingtool #jQuerySheet table.jSheet');
    return Array.from(tables).flatMap(table => {
      let choices = connectChoiceCache.get(table);
      if (!choices) connectChoiceCache.set(table, choices = new Map());
      // 共用菜单即使关闭也保留实际候选，只按同一表内的 dropdownid 复用。
      doc.querySelectorAll('.listContainer [role="listbox"][aria-labelledby]').forEach(menu => {
        const owner = doc.getElementById((menu.getAttribute('aria-labelledby') || '').trim());
        if (!owner || owner.closest('table.jSheet') !== table) return;
        const labels = Array.from(menu.querySelectorAll('[role="option"]')).map(item => norm(item.querySelector('.list_content')?.textContent || '')).filter(Boolean).sort((a,b)=>a.localeCompare(b));
        if (labels.length) choices.set(owner.getAttribute('dropdownid'), labels);
      });
      return Array.from(table.querySelectorAll('td.responseCell')).filter(isVisible).flatMap((cell, index) => {
        const readOnly = cell.classList.contains('td-readOnly') || cell.getAttribute('aria-disabled') === 'true' || cell.getAttribute('aria-readonly') === 'true';
        if (readOnly && !includeReadOnly) return [];
        const headers = (cell.getAttribute('headers') || '').trim().split(/\s+/).map(id => doc.getElementById(id)).filter(node => node && table.contains(node));
        const description = headers.map(text).join(' ');
        const sentence = !description ? connectSentence(cell) : null;
        const dropdown = cell.classList.contains('dropDownList');
        const labels = connectRuntimeChoices.get(cell) || choices.get(cell.getAttribute('dropdownid')) || [];
        const issues = [];
        if (!instruction || (!description && !sentence)) issues.push('缺少共同题干或该行标签');
        if (dropdown) {
          if (cell.getAttribute('dropdowntype') !== 'dropDown') issues.push('暂不支持该类型的表格下拉框');
          if (connectRuntimeIssues.has(cell)) issues.push(connectRuntimeIssues.get(cell));
          if (labels.length < 2) issues.push('候选数据尚未就绪，请稍后重新扫描');
          if (new Set(labels).size !== labels.length) issues.push('候选文字重复，无法唯一选择');
        } else if (!cell.classList.contains('isN')) issues.push('暂不支持该类型的表格填写单元格');
        let stem = (instruction || '[共同题干缺失]') + (sentence
          ? '\nComplete this sentence: ' + sentence.text + '\nAnswer ONLY [Blank ' + sentence.index + '].'
          : '\nMatch ONLY this row: ' + (description || '[行标签缺失]'));
        if (!dropdown && connectCellText(cell.nextElementSibling || cell).startsWith('%')) stem += '\nThe percent sign is already printed after the blank. Return the percentage number without a percent sign.';
        return [{
          hash: hashOf(stem + (dropdown ? '::connect-matching-v1::' + cell.getAttribute('dropdownid') + '::' + labels.join('||') : '::connect-numeric-v1')),
          stem, type:dropdown?'single':'numeric', kind:dropdown?'matching':'connect-numeric', matchingRow:index+1, container:cell, groupContainer:table,
          ...(dropdown?{answerCell:cell}:{answerNumberCell:cell,answerInput:null}), readOnly, incomplete:issues.length>0, issues,
          options:dropdown?labels.map((label,i) => ({letter:LETTERS[i] || String(i+1),text:label,raw:label,value:label,input:null,clickTarget:cell,connectCell:cell})):[]
        }];
      });
    });
  }

  function connectFrameQuestions(root, includeReadOnly) {
    return Array.from(root.querySelectorAll(CONNECT_FRAME)).flatMap(frame => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !isVisible(frame)) return [];
        const prompt = frame.closest('.worksheet__main');
        const copy = prompt.cloneNode(true);
        copy.querySelectorAll('iframe, .gaspar_audio__container, .t-hidden, [aria-hidden="true"], .__mas_select_hint').forEach(el => el.remove());
        return connectMatchingQuestions(doc, includeReadOnly, norm(copy.textContent)).map(q => ({...q, connectPrompt:prompt}));
      } catch (_) { return []; }
    });
  }

  /** Canvas 数字题只有一个文本/数字输入框，结果页中的答案列表是反馈，不是选项。 */
  function canvasNumericQuestions(root, includeReadOnly) {
    const questions = [];
    const containers = Array.from(root.querySelectorAll(CANVAS_NUMERIC_QUESTION));
    if (root.matches && root.matches(CANVAS_NUMERIC_QUESTION)) containers.unshift(root);
    containers.forEach((container) => {
      if (!isVisible(container)) return;
      const stemNode = container.querySelector('.question_text');
      if (!stemNode || !isVisible(stemNode)) return;
      const stem = text(stemNode).slice(0, MAX_STEM_LEN);
      if (stem.length < 8 && !visualsIn(stemNode).length) return;
      const inputs = Array.from(container.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
        .filter((input) => isVisible(input) && !input.closest('[aria-hidden="true"]'));
      if (!inputs.length) return;
      const readOnly = inputs.some((input) => input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true');
      if (readOnly && !includeReadOnly) return;
      const heading = container.querySelector('.header .name, .question_name');
      const number = heading && text(heading).match(/question\s+(\d+)/i);
      questions.push({
        hash: hashOf(stem + '::numeric'), stem, type: 'numeric', container,
        answerInput: inputs.length === 1 ? inputs[0] : null,
        questionNumber: number ? number[1] : null,
        readOnly, incomplete: inputs.length !== 1,
        issues: inputs.length === 1 ? [] : ['发现多个数字输入框，尚无法确定各空的对应关系'],
        options: []
      });
    });
    return questions;
  }

  /** McGraw Hill 将文本空位直接嵌在 .prompt 中；空位位置必须进入题干。 */
  function mcgrawTextQuestions(root, includeReadOnly) {
    return Array.from(root.querySelectorAll('awd-probe .awd-probe-type-fill_in_the_blank .fitb-fieldset')).flatMap(container => {
      const prompt = container.querySelector('.prompt');
      if (!isVisible(container) || !isVisible(prompt)) return [];
      const allInputs = Array.from(prompt.querySelectorAll('input.fitb-input'));
      const answerInputs = allInputs.filter(input => isVisible(input) && !input.closest('[aria-hidden="true"]'));
      if (!answerInputs.length) return [];
      const readOnly = answerInputs.some(input => input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true');
      if (readOnly && !includeReadOnly) return [];
      const copy = prompt.cloneNode(true);
      const clonedInputs = Array.from(copy.querySelectorAll('input.fitb-input'));
      clonedInputs.forEach((input, index) => {
        const blank = answerInputs.indexOf(allInputs[index]);
        input.replaceWith(blank >= 0 ? ' [Blank ' + (blank + 1) + '] ' : '');
      });
      copy.querySelectorAll('._visuallyHidden, [hidden], [aria-hidden="true"], [role="status"], .__mas_select_hint').forEach(el => el.remove());
      const stem = norm(copy.textContent);
      const blanks = answerInputs.map((input, index) => ({
        index: index + 1, label: norm(input.getAttribute('aria-label')) || 'Blank ' + (index + 1),
        maxLength: input.maxLength >= 0 ? input.maxLength : null
      }));
      const issues = [];
      if (answerInputs.some(input => input.type !== 'text')) issues.push('填空含非文本输入框，暂不自动填写');
      if (answerInputs.length > 30) issues.push('填空数量超过30，暂不自动填写');
      if (!stem.replace(/\[Blank \d+\]/g, '').trim()) issues.push('填空题缺少题干');
      return [{
        hash: hashOf(stem + '::text-v1::' + JSON.stringify(blanks)), stem, type: 'text',
        container, answerInputs, blanks, options: [], readOnly,
        incomplete: issues.length > 0, issues
      }];
    });
  }

  /** Canvas Classic 把题干放在独立 .question_text 中，不能从包含分数/反馈的整块区域取文字。 */
  function canvasContent(common, options) {
    const question = common.closest(CANVAS_QUESTION);
    const stemNode = question && question.querySelector('.question_text');
    if (!stemNode || !isVisible(stemNode)) return null;
    const fullStem = text(stemNode);
    let stem = fullStem;
    const issues = [];
    // Canvas 会把老师留下的空答案显示为占位文字。保留其 DOM 顺序供扫描，
    // 但不能把这些文字当成真实的答案送给模型，也不能靠位置猜它对应哪段题干。
    options.forEach((o) => {
      const label = o.input && labelElementFor(o.input);
      o.unavailable = /^no answer text provided[.!]*$/i.test(o.text) || !!(label && !text(label) && !visualsIn(label).length);
    });
    const usable = options.filter((o) => !o.unavailable);
    let incomplete = usable.length < 2;
    if (incomplete) issues.push('网页未提供足够的选项文字，无法确定题干选项对应哪个按钮');
    // label 可为大小写单字母；空白按钮可能在任意位置，映射按原始 label 而非位置进行。
    if (usable.length >= 2 && usable.every((o) => /^[A-Z]$/i.test(o.text))) {
      const lines = stemNode.innerText || stemNode.textContent || '';
      const matches = Array.from(lines.matchAll(/(?:^|\n)\s*([A-Z])[.．)）:：]\s+([\s\S]*?)(?=(?:\n\s*[A-Z][.．)）:：]\s+)|$)/gi));
      const byLetter = new Map(matches.map((m) => [m[1].toUpperCase(), norm(m[2])]));
      if (matches.length === usable.length && byLetter.size === usable.length && usable.every((o) => byLetter.get(o.text.toUpperCase()))) {
        stem = norm(lines.slice(0, matches[0].index));
        usable.forEach((o) => { o.text = byLetter.get(o.text.toUpperCase()).slice(0, MAX_OPTION_LEN); });
      } else {
        incomplete = true;
        issues.push('字母选项与题干中的完整文字无法一一对应');
      }
    }
    return { stem: stem.slice(0, MAX_STEM_LEN), container: question, incomplete, issues };
  }

  function collect(root, opts) {
    root = root || document;
    // 同源 Connect 由外层统一读取和作答，避免 iframe 的第二套求解器重复执行。
    if (root === document && isDelegatedConnectFrame()) return [];
    const raw = [].concat(inputGroups(root, !!(opts && opts.includeReadOnly)), ariaGroups(root), letteredGroups(root));
    const questions = [].concat(connectFrameQuestions(root, !!opts?.includeReadOnly), mcgrawTextQuestions(root, !!(opts && opts.includeReadOnly)), canvasNumericQuestions(root, !!(opts && opts.includeReadOnly)), canvasMatchingQuestions(root, !!(opts && opts.includeReadOnly)), sageMatchingQuestions(root, !!(opts && opts.includeReadOnly)));
    const usedContainers = new Set();

    for (const g of raw) {
      const options = g.options
        .map((o, i) => ({
          letter: LETTERS[i] || String(i + 1),
          text: stripPrefix(o.raw || ''),
          raw: o.raw || '', // 保留原始文本，题干抽取要靠它做减法
          input: o.input,
          clickTarget: o.clickTarget
        }))
        .filter((o) => o.clickTarget && o.clickTarget.isConnected);

      if (options.length < 2) continue;
      if (options.every((o) => !o.text)) continue;

      const common = commonAncestor(g.optionEls);
      const cid = idFor(common);
      if (usedContainers.has(cid)) continue;

      const canvas = canvasContent(common, options);
      const stem = canvas ? canvas.stem : findStem(
        common,
        options.map((o) => o.raw || o.text),
        g.optionEls
      );
      // 过滤掉页面上那些「只是长得像选择题」的 UI 开关
      if (stem.length < 8 && options.length < 3 && !visualsIn(canvas ? canvas.container.querySelector('.question_text') : common).length) continue;

      usedContainers.add(cid);
      questions.push({
        hash: hashOf(stem + '::' + options.map((o) => o.text).join('||')),
        stem,
        type: g.type,
        container: canvas ? canvas.container : common,
        readOnly: options.some((o) => o.input && (o.input.disabled || o.input.readOnly || o.input.getAttribute('aria-disabled') === 'true')),
        incomplete: !!(canvas && canvas.incomplete),
        issues: canvas ? canvas.issues : [],
        options
      });
    }

    // iframe 中的节点属于不同 document，直接 compareDocumentPosition 会返回
    // DISCONNECTED 和实现相关的顺序。先比较外层 iframe，再比较内部控件。
    const paths=new Map(questions.map(q=>{
      let node=q.answerSelect||q.answerCell||q.answerNumberCell||q.answerInput||q.container;
      const path=[node];
      try{
        while(node.ownerDocument!==document){
          const frame=node.ownerDocument.defaultView?.frameElement;
          if(!frame)break;
          path.unshift(frame);node=frame;
        }
      }catch(_){}
      return [q,path];
    }));
    questions.sort((a, b) => {
      const left=paths.get(a),right=paths.get(b);
      for(let i=0;i<Math.min(left.length,right.length);i++){
        if(left[i]===right[i])continue;
        const p=left[i].compareDocumentPosition(right[i]);
        if(p&Node.DOCUMENT_POSITION_DISCONNECTED)return 0;
        if(p&Node.DOCUMENT_POSITION_FOLLOWING)return -1;
        if(p&Node.DOCUMENT_POSITION_PRECEDING)return 1;
        break;
      }
      return 0;
    });
    return questions.map(attachVisuals);
  }

  window.__MCQ_DETECTOR__ = { collect, text, norm, isVisible, LETTERS, connectCellText, connectMenuFor, isDelegatedConnectFrame, refreshConnectChoices };
})();
