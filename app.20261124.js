/* 绘本网页版电子书 · 逻辑
   StPageFlip 2.0.7 HTML 模式，单实例 usePortrait 自动切换 PC 双页 / 手机单页。
   关键约束：
   - 页内零 id（portrait 翻页会 cloneNode(true)）
   - 懒加载状态用全局 Map 管，不依赖 DOM dataset（克隆页是快照）
   - changeOrientation 里绝不 destroy / turnToPage，库已内置页码补偿
   - 页根 .stf__item 的 cssText 每帧被覆写，样式全在 .page-inner 上
*/
(function () {
  'use strict';

  var BREAK = 720;                 // 与 options.minWidth*2 对齐
  var manifest = null;
  var flip = null;
  var state = new Map();           // index -> { hi, lo, lqip, decoded, pending }
  var useHi = true;
  var lastOrientation = null;
  var resizeTimer = null;
  var updateTimer = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function loadManifest() {
    return fetch('./assets/manifest.v1.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('manifest HTTP ' + r.status);
      return r.json();
    });
  }

  function pageLabel(i) {
    var p = manifest.pages[i];
    if (!p) return '';
    if (p.cover) return '封面';
    if (p.back) return '封底';
    if (p.blank) return '空白页';
    return 'P' + p.num;
  }

  function findSpread(idx, spreads) {
    for (var i = 0; i < spreads.length; i++) {
      if (spreads[i].indexOf(idx) >= 0) return spreads[i];
    }
    return [idx];
  }

  /* ---------- 构建页 DOM ---------- */
  function buildPages() {
    var book = $('book');
    var frag = document.createDocumentFragment();
    manifest.pages.forEach(function (p) {
      var page = document.createElement('div');
      page.className = 'page';
      page.setAttribute('data-page', String(p.index));
      if (p.cover) page.setAttribute('data-cover', '1');
      if (p.back) page.setAttribute('data-back', '1');
      // setDensity() 不改 classList，封面/封底必须显式声明 hard
      if (p.cover || p.back) page.setAttribute('data-density', 'hard');

      var inner = document.createElement('div');
      inner.className = 'page-inner';
      inner.style.backgroundImage = 'url("' + p.lqip + '")';

      var img = document.createElement('img');
      img.className = 'page-img';
      img.alt = p.cover ? '封面' : (p.back ? '封底' : (p.blank ? '空白页' : '第 ' + p.num + ' 页'));
      img.decoding = 'async';
      img.draggable = false;
      // 确定的字符串：cloneNode 复制后仍是它，克隆页不会变成空白
      img.src = p.lqip;
      inner.appendChild(img);

      var gr = document.createElement('i'); gr.className = 'gutter gutter--right';
      var gl = document.createElement('i'); gl.className = 'gutter gutter--left';
      inner.appendChild(gr); inner.appendChild(gl);

      // 页内不叠页码：本页是满版设计，页码由工具栏的「P4 – P5 · 5/86」承担
      page.appendChild(inner);
      frag.appendChild(page);
      state.set(p.index, { hi: p.hi, lo: p.lo, lqip: p.lqip, decoded: false, pending: null });
    });
    book.appendChild(frag);
    return book.querySelectorAll('.page');
  }

  /* ---------- 懒加载：LQIP -> 真实图，先 decode 再翻页 ---------- */
  function ensure(index) {
    var s = state.get(index);
    if (!s || s.decoded) return Promise.resolve();
    if (s.pending) return s.pending;

    var url = useHi ? s.hi : s.lo;
    var im = new Image();
    s.pending = new Promise(function (resolve) {
      function finish() {
        // 同时更新原页与可能存在的克隆页
        var nodes = document.querySelectorAll(
          '.page[data-page="' + index + '"] > .page-inner > .page-img');
        for (var k = 0; k < nodes.length; k++) {
          nodes[k].src = url;
          nodes[k].classList.add('is-loaded');
        }
        s.decoded = true;
        resolve();
        // 淡入结束后撤掉 LQIP 底图，避免过渡期出现"两层字"
        setTimeout(function () {
          var inners = document.querySelectorAll('.page[data-page="' + index + '"] > .page-inner');
          for (var j = 0; j < inners.length; j++) inners[j].style.backgroundImage = 'none';
        }, 340);
      }
      im.onload = function () {
        if (typeof im.decode === 'function') {
          im.decode().then(finish, finish);
        } else { finish(); }
      };
      im.onerror = function () { s.pending = null; resolve(); };  // 保留 LQIP，不白屏
      im.src = url;
    });
    return s.pending;
  }

  function ensureAround(center) {
    var jobs = [];
    for (var d = -2; d <= 3; d++) {
      var i = center + d;
      if (i >= 0 && i < manifest.count) jobs.push(ensure(i));
    }
    return Promise.all(jobs);
  }

  /* ---------- 方向 / 文案 ---------- */
  function readOrientation() {
    if (flip) {
      try { return flip.getOrientation(); } catch (e) { /* noop */ }
    }
    return $('stage').getBoundingClientRect().width < BREAK ? 'portrait' : 'landscape';
  }

  function applyOrientation(o) {
    $('stage').setAttribute('data-orientation', o);
    $('stage').style.setProperty('--h-factor',
      String(o === 'portrait' ? manifest.ratio : 2 * manifest.ratio));
    fitStage(o);
    updateLabel();
  }

/* 按 topbar / toolbar 的真实占用算可用高度，避免书压住标题栏。
   注意：不能用 .app 的 clientHeight —— 书会把它撑大，形成循环。
   #book 的宽高必须显式写成 px：库用 element.offsetWidth/Height 当块宽高，
   交给 CSS 自适应时块宽会缩到内容宽度，书只有屏幕的一半大。 */
function fitStage(o) {
  var stage = $('stage');
  var book = $('book');
  var topbar = document.querySelector('.topbar');
  var toolbar = document.querySelector('.toolbar');
  var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  var availH = vh - topbar.offsetHeight - toolbar.offsetHeight - 28;
  var availW = Math.min(window.innerWidth - 24, 1600);
  var factor = o === 'portrait' ? manifest.ratio : 2 * manifest.ratio;
  var w = Math.max(300, Math.min(availW, availH * factor));
  var h = Math.round(w / factor);
  w = Math.round(w);
  stage.style.width = w + 'px';
  book.style.width = w + 'px';
  book.style.height = h + 'px';
}

  function updateLabel() {
    if (!flip || !manifest) return;
    var idx = flip.getCurrentPageIndex();
    var o = readOrientation();
    var txt;
    if (o === 'portrait') {
      txt = pageLabel(idx);
    } else {
      var sp = findSpread(idx, manifest.spreads.landscape);
      txt = sp.length === 2
        ? 'P' + (sp[0] + 1) + ' – P' + (sp[1] + 1)
        : pageLabel(sp[0]);
    }
    els.label.textContent = txt + '   ·   ' + (idx + 1) + '/' + manifest.count;
  }

  function updateButtons() {
    if (!flip) return;
    var idx = flip.getCurrentPageIndex();
    els.prev.disabled = idx <= 0;
    els.next.disabled = idx >= manifest.count - 1;
  }

  /* ---------- 页码持久化 ---------- */
  function readSavedPage() {
    var m = location.hash.match(/p=(\d+)/);
    if (m) return parseInt(m[1], 10);
    try {
      var s = sessionStorage.getItem('book-page');
      if (s !== null) return parseInt(s, 10);
    } catch (e) { /* noop */ }
    return 0;
  }

  function savePage(i) {
    try { sessionStorage.setItem('book-page', String(i)); } catch (e) { /* noop */ }
    try { history.replaceState(null, '', '#p=' + i); } catch (e) { /* noop */ }
  }

  /* ---------- 初始化翻页实例 ---------- */
  function initFlip() {
    var pageEls = buildPages();
    var W = 900;
    var H = Math.round(W / manifest.ratio);   // 单张竖版页的比例
    var saved = Math.max(0, Math.min(readSavedPage(), manifest.count - 1));

    flip = new St.PageFlip($('book'), {
      width: W, height: H,
      size: 'stretch',
      minWidth: BREAK / 2, minHeight: 480,
      maxWidth: 1000, maxHeight: 1600,
      usePortrait: true,        // 单实例自动切单/双页，不 destroy 不重建
      showCover: true,          // 封面/封底单独 + HARD，配对 [[0],[1,2],...,[M-1]]
      autoSize: true,
      startPage: saved,
      drawShadow: true, maxShadowOpacity: 0.6, flippingTime: 900,
      useMouseEvents: true, showPageCorners: true, disableFlipByClick: false,
      mobileScrollSupport: true, clickEventForward: true, swipeDistance: 30
    });

    // 必须先注册再 loadFromHTML：库用 setTimeout(...,1) 触发 init
    flip.on('init', function () {
      var o = readOrientation();
      lastOrientation = o;
      applyOrientation(o);
      updateButtons();
      ensureAround(flip.getCurrentPageIndex());
      $('loading').hidden = true;
      // 按最终方向收尾一次尺寸重算
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 80);
      diag();
      // QA 钩子：?open=toc / ?open=zoom，便于无头浏览器截图核对覆盖层
      var open = (location.search.match(/open=(\w+)/) || [])[1];
      if (open === 'toc') openToc();
      if (open === 'zoom') openZoom();
    });

    flip.on('flip', function () {
      var idx = flip.getCurrentPageIndex();
      savePage(idx);
      ensureAround(idx);
      updateLabel();
      updateButtons();
    });

    flip.on('changeOrientation', function () {
      var o = readOrientation();
      if (o === lastOrientation) return;
      lastOrientation = o;
      applyOrientation(o);   // 只改文案与容器比例，不 destroy、不 turnToPage
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 80);
    });

    flip.loadFromHTML(pageEls);
  }

  /* ---------- 诊断：访问 ?diag 时把关键尺寸写进 title，便于无头浏览器核对 ---------- */
  /* ---------- 诊断：访问 ?diag 时把关键尺寸写进 title（开发者自查用，正常阅读无影响） ---------- */
  function diag() {
    if (location.search.indexOf('diag') < 0) return;
    var st = $('stage').getBoundingClientRect();
    var bk = $('book').getBoundingClientRect();
    document.title = 'DIAG vw' + window.innerWidth + ' vh' + window.innerHeight +
      ' stage' + Math.round(st.width) + 'x' + Math.round(st.height) +
      ' book' + Math.round(bk.width) + 'x' + Math.round(bk.height) +
      ' top' + Math.round(bk.top) + ' tb' + Math.round(document.querySelector('.toolbar').getBoundingClientRect().top) +
      ' ' + $('stage').getAttribute('data-orientation');
  }

  /* ---------- 交互 ---------- */
  function canFlip() {
    if (!flip) return false;
    try { return flip.getState() === 'read'; } catch (e) { return true; }
  }

  function goPrev() { if (canFlip() && flip.getCurrentPageIndex() > 0) flip.flipPrev(); }
  function goNext() { if (canFlip() && flip.getCurrentPageIndex() < manifest.count - 1) flip.flipNext(); }

  function closeOverlays() {
    $('zoom-overlay').hidden = true;
    $('toc-panel').hidden = true;
  }

  function openZoom() {
    if (!flip) return;
    var p = manifest.pages[flip.getCurrentPageIndex()];
    $('zoom-img').src = p.hi;
    $('zoom-overlay').hidden = false;
  }

  function buildToc() {
    var grid = $('toc-grid');
    if (grid.childElementCount) {
      var cur = flip.getCurrentPageIndex();
      var items = grid.querySelectorAll('.toc-item');
      for (var k = 0; k < items.length; k++) {
        items[k].classList.toggle('is-current',
          Number(items[k].getAttribute('data-index')) === cur);
      }
      return;
    }
    var frag = document.createDocumentFragment();
    manifest.pages.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toc-item';
      b.setAttribute('data-action', 'goto');
      b.setAttribute('data-index', String(p.index));
      var im = document.createElement('img');
      im.src = p.lo;
      im.alt = pageLabel(p.index);
      im.loading = 'lazy';
      var s = document.createElement('span');
      s.textContent = pageLabel(p.index);
      b.appendChild(im); b.appendChild(s);
      frag.appendChild(b);
    });
    grid.appendChild(frag);
  }

  function openToc() { buildToc(); $('toc-panel').hidden = false; }

  function toggleFullscreen() {
    var d = document;
    if (!d.fullscreenElement) {
      if (d.documentElement.requestFullscreen) {
        d.documentElement.requestFullscreen().catch(function () {});
      }
    } else if (d.exitFullscreen) {
      d.exitFullscreen().catch(function () {});
    }
  }

  function bindUI() {
    els.label = $('page-label');
    els.prev = document.querySelector('[data-action="prev"]');
    els.next = document.querySelector('[data-action="next"]');

    // iOS Safari 没有元素级全屏 API，直接隐藏按钮而不是留个点了没反应的键
    if (!document.documentElement.requestFullscreen) {
      var fsBtn = document.querySelector('[data-action="fullscreen"]');
      if (fsBtn) fsBtn.hidden = true;
    }

    document.querySelector('.toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.getAttribute('data-action')) {
        case 'prev': goPrev(); break;
        case 'next': goNext(); break;
        case 'toc': openToc(); break;
        case 'zoom': openZoom(); break;
        case 'fullscreen': toggleFullscreen(); break;
      }
    });

    $('zoom-overlay').addEventListener('click', function (e) {
      if (e.target.closest('[data-action="close"]') || e.target === $('zoom-img')) closeOverlays();
    });
    $('toc-panel').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.getAttribute('data-action') === 'close') { closeOverlays(); return; }
      if (btn.getAttribute('data-action') === 'goto') {
        var i = Number(btn.getAttribute('data-index'));
        closeOverlays();
        if (canFlip()) flip.turnToPage(i);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeOverlays(); return; }
      if (e.key === 'ArrowLeft') { goPrev(); return; }
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext(); }
    });

    // 外层 resize 只做 UI 重排 + 一次收尾重算；方向切换由库内置的 window.resize 监听负责
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var o = readOrientation();
        if (o !== lastOrientation) { lastOrientation = o; applyOrientation(o); }
        else { fitStage(o); updateLabel(); }
        clearTimeout(updateTimer);
        updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 60);
        diag();
      }, 180);
    });
  }

  /* ---------- 启动 ---------- */
  loadManifest().then(function (m) {
    manifest = m;
    if (m.count % 2 !== 0) throw new Error('manifest 页数必须为偶数');
    if (m.spreads.landscape[m.spreads.landscape.length - 1].length !== 1) {
      throw new Error('封底必须单独成页');
    }
    if (m.title) { $('book-title').textContent = m.title; document.title = m.title + ' · 网页版电子书'; }
    if (m.author) $('book-author').textContent = m.author;
    // 目录缩略图与书页共用同一比例，改可画画布比例时只需改 manifest
    document.documentElement.style.setProperty('--page-ratio', String(m.ratio));
    // 手机 / DPR1 平板用 lo 档，桌面 Retina 用 hi 档
    useHi = !(window.matchMedia && window.matchMedia('(max-width: 720px) and (max-resolution: 2dppx)').matches);
    bindUI();
    initFlip();
  }).catch(function (err) {
    $('loading').textContent = '载入失败：' + err.message + '（请用本地 http 服务打开，见 README）';
    console.error('[book]', err);
  });
})();
