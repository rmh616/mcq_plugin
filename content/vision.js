/** 只在实际求解有图题时编码，不对整页截图，不在扫描时下载图片。 */
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
        sourceCache.set(key, result);
        while (sourceCache.size > 8 || [...sourceCache.values()].reduce((n, v) => n + v.dataUrl.length, 0) > 16 * 1024 * 1024) sourceCache.delete(sourceCache.keys().next().value);
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
  window.__MAS_VISION__ = { prepare, stats };
})();
