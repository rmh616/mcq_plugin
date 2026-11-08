/** 仅在求解有图题时读取；原图读取失败才允许后台裁剪可见题图，不在扫描时读取。 */
(function () {
  'use strict';
  if (window.__MAS_VISION__) return;
  const MAX_IMAGES = 8;
  const MAX_SIDE = 1800;
  const MAX_TOTAL = 12 * 1024 * 1024;
  const imageCache = new WeakMap();
  const sourceCache = new Map();
  const sourceJobs = new Map();
  const stats = { encodes: 0, cacheHits: 0, pageFetches: 0 };

  function rememberSource(key, result) {
    sourceCache.set(key, result);
    while (sourceCache.size > 8 || [...sourceCache.values()].reduce((size, value) => size + value.dataUrl.length, 0) > 16 * 1024 * 1024) {
      sourceCache.delete(sourceCache.keys().next().value);
    }
  }

  async function fetchInPage(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      // 使用页面的同源登录环境读取Canvas文件。不给图片请求添加模型API Key。
      stats.pageFetches++;
      const response = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('图片超过8MB');
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024 || !/^image\/(png|jpeg|webp|gif|svg\+xml)(;|$)/i.test(blob.type)) throw new Error('返回的不是可用图片');
      const bitmap = await createImageBitmap(blob);
      try { return { dataUrl: raster(bitmap, bitmap.width, bitmap.height) }; }
      finally { bitmap.close(); }
    } finally { clearTimeout(timer); }
  }

  async function encodeImage(el) {
    if (el.complete && el.naturalWidth) {
      try { return { dataUrl: raster(el, el.naturalWidth, el.naturalHeight) }; } catch (_) {}
    }
    const url = el.currentSrc || el.src;
    if (/^https?:\/\//i.test(url)) {
      // 不先白等8秒decode再下载；直接在页面登录环境读取。
      try { return await fetchInPage(url); }
      catch (_) { return { url }; } // 跨域/CORS失败时再由后台获取。
    }
    await load(el);
    return { dataUrl: raster(el, el.naturalWidth, el.naturalHeight) };
  }

  function raster(source, width, height) {
    if (!width || !height) throw new Error('图片尚未加载或尺寸无效');
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  async function load(image) {
    if (image.complete && image.naturalWidth) return;
    // 已存在的懒加载图只加载自身资源；不滚动页面或改答案。
    image.loading = 'eager';
    let timer;
    try {
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('题目图片加载超时')), 8000); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function encode(visual) {
    const el = visual.element;
    if (!el?.isConnected) throw new Error('题目图片已被页面替换');
    const tag = el.tagName.toLowerCase();
    stats.encodes++;
    if (tag === 'canvas') return { dataUrl: raster(el, el.width, el.height) };
    if (tag === 'svg') {
      // 内联SVG按图形本身栅格化；拒绝嵌入脚本/外部资源，失败时不猜答案。
      const copy = el.cloneNode(true);
      if (copy.querySelector('script, foreignObject, image, use')) throw new Error('此SVG含外部资源，暂不能可靠读取');
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const rect = el.getBoundingClientRect();
      copy.setAttribute('width', rect.width); copy.setAttribute('height', rect.height);
      const originals = [el, ...el.querySelectorAll('*')];
      [copy, ...copy.querySelectorAll('*')].forEach((node, index) => {
        const style = getComputedStyle(originals[index]);
        for (const prop of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'color']) {
          node.style.setProperty(prop, style.getPropertyValue(prop));
        }
      });
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
      await load(image);
      return { dataUrl: raster(image, image.naturalWidth, image.naturalHeight) };
    }
    try { return await encodeImage(el); }
    catch (error) { throw new Error('无法读取题目图片：' + error.message); }
  }

  function cachedEncode(visual) {
    const el = visual.element;
    if (!el?.isConnected) return Promise.reject(new Error('题目图片已被页面替换'));
    if (el.tagName.toLowerCase() !== 'img') return encode(visual);
    const key = (el.currentSrc || el.src) + '|' + (el.getAttribute('srcset') || '');
    const cached = imageCache.get(el);
    if (cached?.key === key) { stats.cacheHits++; return cached.task; }
    // 已成功编码的同源资源可跨题复用；图片文字的字母标签仍由每题单独附加。
    if (sourceCache.has(key)) { stats.cacheHits++; return Promise.resolve(sourceCache.get(key)); }
    if (sourceJobs.has(key)) { stats.cacheHits++; return sourceJobs.get(key); }
    const task = encode(visual).then(result => {
      if (result.dataUrl) {
        rememberSource(key, result);
      } else imageCache.delete(el); // 后台下载失败后，下次按键允许重试页面读取。
      return result;
    }, error => { imageCache.delete(el); throw error; }).finally(() => sourceJobs.delete(key));
    sourceJobs.set(key, task);
    imageCache.set(el, { key, task });
    return task;
  }

  async function prepare(q) {
    const visuals = q.visuals || [];
    if (visuals.length > MAX_IMAGES) throw new Error('该题超过8张图片，请拆分后处理');
    const images = await Promise.all(visuals.map(async visual => ({ label: visual.label, ...await cachedEncode(visual) })));
    let total = 0;
    for (const image of images) {
      total += (image.dataUrl || image.url).length;
      if (total > MAX_TOTAL) throw new Error('该题图片总量过大，请缩小图片');
    }
    return images;
  }

  async function captureFallback(q, images) {
    if (window.top !== window) throw new Error('截图兜底仅支持顶层题目页，请在原页面打开题目');
    const result = images.slice();
    for (let index=0; index<images.length; index++) {
      if (!images[index].url) continue;
      const image = q.visuals[index]?.element;
      if (!image?.isConnected || image.tagName.toLowerCase() !== 'img' || !image.complete || !image.naturalWidth) throw new Error('题图尚未加载，不能用截图代替');
      if ((image.currentSrc || image.src) !== images[index].url) throw new Error('题图已变化，请重试');
      const key = images[index].url + '|' + (image.getAttribute('srcset') || '');
      if (sourceCache.has(key)) {
        result[index] = {label:images[index].label, ...sourceCache.get(key)};
        continue;
      }
      const token = crypto.randomUUID();
      const previous = image.getAttribute('data-mas-capture-target');
      image.setAttribute('data-mas-capture-target',token);
      try {
        const response = await new Promise(resolve => {
          chrome.runtime.sendMessage({type:'MAS_CAPTURE_IMAGE',payload:{token, source:images[index].url, hash:q.hash}}, reply => {
            resolve(chrome.runtime.lastError ? {ok:false,error:chrome.runtime.lastError.message} : reply);
          });
        });
        if (!response?.ok || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(response.dataUrl || '')) throw new Error(response?.error || '未能获取题图截图');
        result[index] = {label:images[index].label,dataUrl:response.dataUrl};
        // 后续小题可能已经滚到图表下方，复用已验证的同一题图裁剪，避免再截残图。
        rememberSource(key, {dataUrl:response.dataUrl});
      } finally {
        if (image.getAttribute('data-mas-capture-target') === token) {
          if (previous === null) image.removeAttribute('data-mas-capture-target');
          else image.setAttribute('data-mas-capture-target',previous);
        }
      }
    }
    if (result.reduce((size,image)=>size+(image.dataUrl || image.url).length,0)>MAX_TOTAL) throw new Error('该题图片总量过大，请缩小图片');
    return result;
  }
  window.__MAS_VISION__ = { prepare, captureFallback, stats };
})();
