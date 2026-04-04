(function () {
  const PHONE = '7605868800';
  const EMAIL = 'info@harker760.com';
  const CHECKOUT_URL = 'https://h760-checkout.harker760.workers.dev/checkout';

  // Detect return from Square checkout
  const urlParams = new URLSearchParams(location.search);
  let justPurchased = urlParams.get('purchased') === '1' ? location.hash.slice(1) : null;
  if (justPurchased) {
    // Clean URL but keep hash
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // --- Analytics (Supabase) ---
  const SUPA_URL = 'https://vklgcykwaurxkqiwopqg.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrbGdjeWt3YXVyeGtxaXdvcHFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNDE5MjEsImV4cCI6MjA5MDkxNzkyMX0.uisYg-0efD6F_de6ATBzw49kgE1lTT4Di-94tNO265M';

  function getSessionId() {
    let sid = sessionStorage.getItem('h760_sid');
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('h760_sid', sid);
    }
    return sid;
  }

  function getUtmSource() {
    try {
      const params = new URLSearchParams(location.search);
      return params.get('utm_source') || null;
    } catch { return null; }
  }

  const _utmSource = getUtmSource();
  const _sessionStart = Date.now();
  let _durationSent = false;

  function trackEvent(event, itemId, extra) {
    if (!SUPA_URL || !SUPA_ANON) return;
    if (/bot|crawl|spider|slurp/i.test(navigator.userAgent)) return;
    const body = {
      event,
      item_id: itemId || null,
      session_id: getSessionId(),
      referrer: document.referrer || null,
      utm_source: _utmSource,
      ua_mobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
      path: location.hash || '/',
      ...extra
    };
    return fetch(`${SUPA_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_ANON,
        'Authorization': 'Bearer ' + SUPA_ANON,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => {});
  }

  // Auto-expire "New" badge after 7 days based on createdAt
  const NEW_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
  function isItemNew(item) {
    if (!item.isNew) return false;
    if (!item.createdAt) return true; // no date = trust the flag
    return (Date.now() - new Date(item.createdAt).getTime()) < NEW_DURATION_MS;
  }

  // Track time on site — fires when user leaves or hides page
  function sendSessionDuration() {
    if (_durationSent) return;
    _durationSent = true;
    const secs = Math.round((Date.now() - _sessionStart) / 1000);
    if (secs < 2) return; // ignore instant bounces
    trackEvent('session_end', null, { duration: secs });
    // Allow re-send if user comes back (mobile tab switch)
    setTimeout(() => { _durationSent = false; }, 5000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sendSessionDuration();
  });
  window.addEventListener('pagehide', sendSessionDuration);

  let items = [];
  let activeCategory = 'all';
  let detailImages = [];
  let detailIndex = 0;
  let appliedDiscount = null; // { code, type, value }

  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty');
  const loadingEl = document.getElementById('loading');
  const gridView = document.getElementById('view-grid');
  const detailView = document.getElementById('view-detail');
  const notfoundView = document.getElementById('view-notfound');
  const aboutView = document.getElementById('view-about');
  const filterBtn = document.getElementById('filter-btn');
  const filterLabel = document.getElementById('filter-label');
  const filterDropdown = document.getElementById('filter-dropdown');

  const categoryLabels = {
    'all': 'All', 'under-400': 'Under $400', 'wall-art': 'Wall Art',
    'object': 'Object', 'ceramic': 'Ceramic', 'furniture': 'Furniture',
    'light': 'Light', 'sculpture': 'Sculpture', 'misc': 'Misc'
  };

  // --- Load inventory ---

  async function load() {
    try {
      // Fetch from GitHub raw (updates instantly) with Pages fallback
      const raw = `https://raw.githubusercontent.com/elikagan/harker760/main/inventory.json?t=${Date.now()}`;
      let res = await fetch(raw);
      if (!res.ok) res = await fetch('inventory.json?t=' + Date.now());
      items = await res.json();
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      if (!items.length) items = [];
    }
    loadingEl.classList.add('hidden');
    initMosaic();
    renderGrid();
    handleHash();
    trackEvent('page_view');
  }

  // --- Grid render ---

  function renderGrid() {
    loadingEl.classList.add('hidden');

    let filtered;
    if (activeCategory === 'all') {
      // In "All": show everything, sold items pushed to end
      const available = items.filter(i => !i.isSold);
      const sold = items.filter(i => i.isSold);
      filtered = [...available, ...sold];
    } else if (activeCategory === 'under-400') {
      filtered = items.filter(i => !i.isSold && Number(i.price) > 0 && Number(i.price) < 400);
    } else {
      filtered = items.filter(i => !i.isSold && i.category === activeCategory);
    }

    grid.innerHTML = '';

    if (filtered.length === 0) {
      empty.classList.add('show');
      return;
    }

    empty.classList.remove('show');

    filtered.forEach((item, i) => {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = '#' + item.id;
      card.style.animationDelay = (i * 0.04) + 's';

      const isSold = !!item.isSold;
      if (isSold) card.classList.add('card--sold');

      const imgSrc = thumbUrl(item.heroImage || (item.images && item.images[0]) || '');
      const imgHtml = imgSrc
        ? `<img src="${imgSrc}" alt="${esc(item.title)}" loading="lazy">`
        : '';

      const newBadge = isItemNew(item) && !isSold ? '<span class="card-new">New</span>' : '';
      const holdBadge = item.isHold && !isSold ? '<span class="card-hold">On Hold</span>' : '';
      const soldBadge = isSold ? '<span class="card-sold">Sold</span>' : '';

      card.innerHTML = `
        <div class="card-image">${imgHtml}${newBadge}${holdBadge}${soldBadge}</div>
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-price">$${Number(item.price).toLocaleString()}</div>
      `;

      grid.appendChild(card);
    });
  }

  // --- Detail view (sliding carousel) ---

  const track = document.getElementById('detail-track');

  function slideTo(index, animate) {
    detailIndex = index;
    if (animate) {
      track.classList.add('animating');
    } else {
      track.classList.remove('animating');
    }
    track.style.transform = `translateX(${-index * 100}%)`;

    // Update thumbnails
    const thumbStrip = document.getElementById('detail-thumbs');
    thumbStrip.querySelector('.active')?.classList.remove('active');
    const thumbs = thumbStrip.querySelectorAll('.detail-thumb');
    if (thumbs[index]) thumbs[index].classList.add('active');
  }

  function showDetail(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;

    trackEvent('item_view', id);

    // Show scroll hint, hide on scroll
    const scrollHint = document.getElementById('detail-scroll-hint');
    scrollHint.classList.remove('hidden');
    function onScroll() {
      if (window.scrollY > 50) {
        scrollHint.classList.add('hidden');
        window.removeEventListener('scroll', onScroll);
      }
    }
    window.addEventListener('scroll', onScroll);
    scrollHint.onclick = () => window.scrollBy({ top: 300, behavior: 'smooth' });

    detailImages = (item.images || []).map(imgUrl);
    const hero = imgUrl(item.heroImage) || detailImages[0] || '';
    detailIndex = detailImages.indexOf(hero);
    if (detailIndex < 0) detailIndex = 0;

    // Build carousel slides
    track.innerHTML = detailImages.map((img, i) =>
      `<div class="detail-slide"><img src="${img}" alt="${esc(item.title)}${i > 0 ? ' — detail ' + (i + 1) : ''}" draggable="false"></div>`
    ).join('');
    slideTo(detailIndex, false);

    document.getElementById('detail-title').textContent = item.title;
    document.getElementById('detail-price').textContent = '$' + Number(item.price).toLocaleString();
    const sizeEl = document.getElementById('detail-size');
    sizeEl.textContent = item.size || '';
    sizeEl.style.display = item.size ? '' : 'none';
    document.getElementById('detail-desc').textContent = item.description || '';

    // Maker & Condition
    const metaEl = document.getElementById('detail-meta');
    const makerEl = document.getElementById('detail-maker');
    const condEl = document.getElementById('detail-condition');
    const hasMaker = !!item.maker;
    const hasCond = !!item.condition;
    metaEl.style.display = (hasMaker || hasCond) ? '' : 'none';
    makerEl.textContent = item.maker || '';
    makerEl.style.display = hasMaker ? '' : 'none';
    condEl.textContent = item.condition || '';
    condEl.style.display = hasCond ? '' : 'none';

    document.getElementById('detail-id').textContent = formatId(item.id);

    // Sold / Hold / Buy Now state
    const soldEl = document.getElementById('detail-sold');
    const holdEl = document.getElementById('detail-hold');
    const inquireEl = document.getElementById('detail-inquire');
    const buyEl = document.getElementById('detail-buy');
    const shippingEl = document.getElementById('detail-shipping');
    const purchasedEl = document.getElementById('detail-purchased');
    const hasPrice = Number(item.price) > 0;
    const wasPurchased = justPurchased === id;
    if (wasPurchased) justPurchased = null; // clear so it doesn't persist on hash nav

    // Reset discount and email gate state on new detail view
    appliedDiscount = null;
    const priceEl = document.getElementById('detail-price');
    priceEl.classList.remove('discounted');
    discountPriceEl.style.display = 'none';
    discountInput.value = '';
    discountInputWrap.style.display = '';
    discountApplied.style.display = 'none';
    discountApplyBtn.disabled = false;
    discountApplyBtn.textContent = 'Apply';
    document.getElementById('detail-actions').style.display = '';
    document.getElementById('detail-email-gate').style.display = 'none';

    if (wasPurchased || item.isSold) {
      soldEl.style.display = '';
      holdEl.style.display = 'none';
      inquireEl.style.display = 'none';
      buyEl.style.display = 'none';
      shippingEl.style.display = 'none';
      discountEl.style.display = 'none';
      if (wasPurchased) {
        purchasedEl.style.display = '';
        const smsBody = encodeURIComponent(`Hi! I just purchased "${item.title}" from Harker760.`);
        document.getElementById('purchased-sms').href = `sms:${PHONE}?body=${smsBody}`;
      } else {
        purchasedEl.style.display = 'none';
      }
    } else if (item.isHold) {
      soldEl.style.display = 'none';
      holdEl.style.display = '';
      buyEl.style.display = 'none';
      shippingEl.style.display = 'none';
      purchasedEl.style.display = 'none';
      discountEl.style.display = 'none';
      inquireEl.style.display = '';
      inquireEl.href = buyLink(item);
      inquireEl.onclick = () => trackEvent('inquire', id);
    } else {
      soldEl.style.display = 'none';
      holdEl.style.display = 'none';
      purchasedEl.style.display = 'none';
      inquireEl.style.display = '';
      inquireEl.href = buyLink(item);
      inquireEl.onclick = () => trackEvent('inquire', id);

      if (hasPrice) {
        buyEl.style.display = '';
        shippingEl.style.display = '';
        discountEl.style.display = '';
        buyEl.textContent = 'Buy Now';
        buyEl.disabled = false;

        const emailGate = document.getElementById('detail-email-gate');
        const emailGateInput = document.getElementById('email-gate-input');
        const emailGateBtn = document.getElementById('email-gate-btn');
        emailGate.style.display = 'none';
        emailGateInput.value = '';
        emailGateBtn.disabled = false;
        emailGateBtn.textContent = 'Continue to Checkout';

        async function proceedToCheckout() {
          buyEl.textContent = 'Processing...';
          buyEl.disabled = true;
          trackEvent('buy_now', id);
          try {
            const body = {
              title: item.title,
              price: Number(item.price),
              itemId: item.id
            };
            if (appliedDiscount) body.discountCode = appliedDiscount.code;
            const res = await fetch(CHECKOUT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.url) {
              window.location.href = data.url;
            } else {
              alert(data.error || 'Checkout unavailable. Please inquire directly.');
              buyEl.textContent = 'Buy Now';
              buyEl.disabled = false;
            }
          } catch {
            alert('Checkout unavailable. Please inquire directly.');
            buyEl.textContent = 'Buy Now';
            buyEl.disabled = false;
          }
        }

        const actionsEl = document.getElementById('detail-actions');
        buyEl.onclick = () => {
          if (localStorage.getItem('h760_email_collected')) {
            proceedToCheckout();
          } else {
            actionsEl.style.display = 'none';
            emailGate.style.display = '';
            emailGate.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        };

        emailGateBtn.onclick = async () => {
          const email = emailGateInput.value.trim();
          if (!email || !emailGateInput.checkValidity()) {
            emailGateInput.reportValidity();
            return;
          }
          emailGateBtn.disabled = true;
          emailGateBtn.textContent = '...';
          try {
            await fetch(`${SUPA_URL}/rest/v1/emails`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPA_ANON,
                'Authorization': 'Bearer ' + SUPA_ANON,
                'Prefer': 'return=minimal,resolution=ignore-duplicates'
              },
              body: JSON.stringify({ email, source: 'abandoned_cart', item_id: id })
            });
          } catch {}
          localStorage.setItem('h760_email_collected', '1');
          localStorage.setItem('h760_email_dismissed', '1');
          emailGateBtn.textContent = 'Processing...';
          proceedToCheckout();
        };

        emailGateInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); emailGateBtn.click(); }
        });
      } else {
        buyEl.style.display = 'none';
        shippingEl.style.display = 'none';
        discountEl.style.display = 'none';
      }
    }

    // Share button
    document.getElementById('detail-share').onclick = async () => {
      const shareUrl = location.origin + location.pathname + '#' + id;
      const shareData = { title: item.title, text: `${item.title} — $${Number(item.price).toLocaleString()}`, url: shareUrl };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch {}
      } else {
        try {
          await navigator.clipboard.writeText(shareUrl);
          const btn = document.getElementById('detail-share');
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        } catch {}
      }
    };

    // New badge (don't show on sold or hold items)
    const newEl = document.getElementById('detail-new');
    newEl.style.display = isItemNew(item) && !item.isSold && !item.isHold ? '' : 'none';

    // Thumbnails
    const thumbStrip = document.getElementById('detail-thumbs');
    if (detailImages.length > 1) {
      thumbStrip.innerHTML = detailImages.map((img, i) =>
        `<img src="${img}" alt="" class="detail-thumb${i === detailIndex ? ' active' : ''}" data-index="${i}">`
      ).join('');
      thumbStrip.style.display = '';
      thumbStrip.querySelectorAll('.detail-thumb').forEach(th => {
        th.addEventListener('click', () => {
          slideTo(parseInt(th.dataset.index, 10), true);
        });
      });
    } else {
      thumbStrip.innerHTML = '';
      thumbStrip.style.display = 'none';
    }

    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = '';
    aboutView.style.display = 'none';
    notfoundView.style.display = 'none';
    window.scrollTo(0, 0);
  }

  function showGrid() {
    detailView.style.display = 'none';
    aboutView.style.display = 'none';
    notfoundView.style.display = 'none';
    gridView.style.display = '';
    if (mosaicCells.length) startMosaic();
  }

  function showAbout() {
    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = 'none';
    notfoundView.style.display = 'none';
    aboutView.style.display = '';
    window.scrollTo(0, 0);
  }

  function showNotFound() {
    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = 'none';
    aboutView.style.display = 'none';
    notfoundView.style.display = '';
    window.scrollTo(0, 0);
  }

  // --- Buy link (#2: SMS text) ---

  function buyLink(item) {
    const msg = `Hi, I'm interested in ${item.title} for $${Number(item.price).toLocaleString()}. (item ${formatId(item.id)})`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobile) {
      return `sms:${PHONE}&body=${encodeURIComponent(msg)}`;
    }
    return `mailto:${EMAIL}?subject=${encodeURIComponent('Inquiry: ' + item.title)}&body=${encodeURIComponent(msg)}`;
  }

  // --- Filter (#10: single active filter, click to change) ---

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });

  filterDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-category]');
    if (!opt) return;
    activeCategory = opt.dataset.category;
    filterLabel.textContent = categoryLabels[activeCategory];
    // Update active state
    filterDropdown.querySelector('.active')?.classList.remove('active');
    opt.classList.add('active');
    filterDropdown.classList.remove('open');
    trackEvent('filter');
    renderGrid();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-wrap')) {
      filterDropdown.classList.remove('open');
    }
  });

  // --- Hash routing ---

  function handleHash() {
    const hash = location.hash.slice(1);
    if (hash === 'about') {
      showAbout();
    } else if (hash && items.length) {
      const item = items.find(i => i.id === hash);
      if (item) {
        showDetail(hash);
      } else {
        showNotFound();
      }
    } else {
      showGrid();
    }
  }

  window.addEventListener('hashchange', handleHash);

  document.getElementById('btn-detail-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('btn-about-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('btn-notfound-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('notfound-browse').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  // --- Swipe carousel with real-time drag ---

  (function () {
    const carousel = document.getElementById('detail-carousel');
    let startX = 0, startY = 0, dragging = false, locked = false;
    let carouselW = 0;

    carousel.addEventListener('touchstart', (e) => {
      if (detailImages.length < 2) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dragging = true;
      locked = false;
      carouselW = carousel.offsetWidth;
      track.classList.remove('animating');
    }, { passive: true });

    carousel.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      // Determine direction lock on first significant move
      if (!locked && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        locked = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical scroll — abort drag
          dragging = false;
          return;
        }
      }

      if (locked) {
        e.preventDefault();
        // Add resistance at edges
        let offset = dx;
        if ((detailIndex === 0 && dx > 0) || (detailIndex === detailImages.length - 1 && dx < 0)) {
          offset = dx * 0.3;
        }
        const pct = (-detailIndex * carouselW + offset) / carouselW * 100;
        track.style.transform = `translateX(${pct}%)`;
      }
    }, { passive: false });

    carousel.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      const threshold = carouselW * 0.2; // 20% of width

      let target = detailIndex;
      if (dx < -threshold && detailIndex < detailImages.length - 1) {
        target = detailIndex + 1;
      } else if (dx > threshold && detailIndex > 0) {
        target = detailIndex - 1;
      }
      slideTo(target, true);
    }, { passive: true });
  })();

  // --- Helpers ---

  // Serve images through Cloudflare CDN (edge-cached, 1-year TTL)
  const CDN_BASE = 'https://h760-checkout.harker760.workers.dev/img/';
  function imgUrl(path) {
    if (!path || path.startsWith('http')) return path;
    return CDN_BASE + path;
  }

  // Thumbnail URL for grid/mosaic (400px, ~30-50KB vs full ~300KB)
  function thumbUrl(path) {
    if (!path) return '';
    // Convert "images/products/id/file.jpg" → "images/products/id/thumb_file.jpg"
    const thumbPath = path.replace(/([^/]+)$/, 'thumb_$1');
    return imgUrl(thumbPath);
  }

  function formatId(id) {
    const n = parseInt(id, 10);
    return !isNaN(n) ? 'A' + String(n).padStart(6, '0') : 'A' + id;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // --- Mosaic ---

  const mosaic = document.getElementById('mosaic');
  const MOSAIC_CELLS = 18;
  const MOSAIC_INTERVAL = 1000;
  const MOSAIC_FLIP_MS = 700;
  const DESKTOP_FLIPS = 4;   // 4-5
  const MOBILE_FLIPS = 2;    // 2-3

  let mosaicCells = [];
  let mosaicTimer = null;
  let mosaicItems = [];
  let mosaicDeck = [];   // items waiting to be shown (never overlaps with cells)
  let mosaicGen = 0;     // generation counter — invalidates stale animation callbacks

  function isMobile() { return window.innerWidth <= 559; }
  function isTablet() { return window.innerWidth > 559 && window.innerWidth <= 959; }
  function visibleCells() { return isMobile() ? 6 : isTablet() ? 12 : 18; }
  function flipBase() { return isMobile() ? MOBILE_FLIPS : DESKTOP_FLIPS; }

  function initMosaic() {
    mosaicItems = items.filter(i => !i.isSold && (i.heroImage || (i.images && i.images.length > 0)));
    if (mosaicItems.length < 4) { mosaic.style.display = 'none'; return; }

    mosaic.style.display = '';
    mosaic.innerHTML = '';
    mosaicCells = [];
    mosaicDeck = [];
    mosaicGen++;

    const shuffled = [...mosaicItems].sort(() => Math.random() - 0.5);
    const cellCount = Math.min(MOSAIC_CELLS, shuffled.length);

    for (let i = 0; i < cellCount; i++) {
      const item = shuffled[i];
      const cell = document.createElement('a');
      cell.className = 'mosaic-cell';
      cell.href = '#' + item.id;
      cell.innerHTML = `
        <div class="mosaic-inner">
          <div class="mosaic-face mosaic-front">
            <img src="${thumbUrl(item.heroImage || item.images[0])}" alt="" loading="lazy">
          </div>
          <div class="mosaic-face mosaic-back">
            <img src="${thumbUrl(item.heroImage || item.images[0])}" alt="" loading="lazy">
          </div>
        </div>
      `;
      mosaic.appendChild(cell);
      mosaicCells.push({ el: cell, flipped: false, currentItem: item, animating: false });
    }
    for (let i = cellCount; i < shuffled.length; i++) {
      mosaicDeck.push(shuffled[i]);
    }

    startMosaic();
  }

  function startMosaic() {
    if (mosaicTimer) clearInterval(mosaicTimer);
    mosaicTimer = setInterval(flipMosaicTiles, MOSAIC_INTERVAL);
  }

  function stopMosaic() {
    if (mosaicTimer) { clearInterval(mosaicTimer); mosaicTimer = null; }
  }

  function flipMosaicTiles() {
    if (mosaicItems.length < 2) return;

    const vis = visibleCells();
    const available = mosaicCells.filter((c, i) => i < vis && !c.animating);
    if (available.length < 2) return;

    const base = flipBase();
    // Never flip more cells than we have deck items for
    const count = Math.min(
      Math.random() < 0.5 ? base : base + 1,
      available.length,
      mosaicDeck.length
    );
    if (count === 0) return;

    const toFlip = [...available].sort(() => Math.random() - 0.5).slice(0, count);
    const gen = mosaicGen;

    toFlip.forEach(cell => {
      // Pull next item from deck (deck never contains on-screen items)
      const newItem = mosaicDeck.shift();
      if (!newItem) return;

      const oldItem = cell.currentItem;

      // Load new image into hidden face
      const inner = cell.el.querySelector('.mosaic-inner');
      const hiddenImg = cell.flipped
        ? inner.querySelector('.mosaic-front img')
        : inner.querySelector('.mosaic-back img');
      hiddenImg.src = thumbUrl(newItem.heroImage || newItem.images[0]);

      // Flip
      cell.animating = true;
      cell.flipped = !cell.flipped;
      cell.currentItem = newItem;
      inner.classList.toggle('flipped');

      // Return old item to deck AFTER animation completes (not before)
      setTimeout(() => {
        if (gen !== mosaicGen) return;  // mosaic was re-initialized, discard
        cell.el.href = '#' + newItem.id;
        cell.animating = false;
        mosaicDeck.push(oldItem);
      }, MOSAIC_FLIP_MS + 50);
    });
  }

  // Pause mosaic when on detail view or tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopMosaic();
    else if (gridView.style.display !== 'none') startMosaic();
  });

  // --- Email capture bar ---

  (function () {
    const bar = document.getElementById('email-bar');
    const closeBtn = document.getElementById('email-bar-close');
    const form = document.getElementById('email-bar-form');
    const input = document.getElementById('email-bar-input');
    const success = document.getElementById('email-bar-success');

    function showBar() {
      bar.style.display = '';
      setTimeout(() => bar.classList.add('show'), 50);
    }

    function hideBar() {
      bar.classList.remove('show');
      setTimeout(() => { bar.style.display = 'none'; }, 400);
    }

    const justPurchasedParam = new URLSearchParams(window.location.search).has('purchased');
    if (!localStorage.getItem('h760_email_dismissed') && !justPurchasedParam) {
      showBar();
    }

    closeBtn.addEventListener('click', () => {
      localStorage.setItem('h760_email_dismissed', '1');
      hideBar();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!email) return;

      const btn = form.querySelector('.email-bar-btn');
      btn.disabled = true;
      btn.textContent = '...';

      try {
        await fetch(`${SUPA_URL}/rest/v1/emails`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPA_ANON,
            'Authorization': 'Bearer ' + SUPA_ANON,
            'Prefer': 'return=minimal,resolution=ignore-duplicates'
          },
          body: JSON.stringify({ email, source: 'newsletter', discount_code: 'WELCOME10' })
        });
      } catch {}

      trackEvent('email_signup');
      form.style.display = 'none';
      success.style.display = '';
      localStorage.setItem('h760_email_collected', '1');
      localStorage.setItem('h760_email_dismissed', '1');

      setTimeout(hideBar, 6000);
    });
  })();

  // --- Discount code logic ---

  const discountEl = document.getElementById('detail-discount');
  const discountInputWrap = document.getElementById('discount-input-wrap');
  const discountApplied = document.getElementById('discount-applied');
  const discountInput = document.getElementById('discount-input');
  const discountApplyBtn = document.getElementById('discount-apply');
  const discountBadge = document.getElementById('discount-badge');
  const discountRemoveBtn = document.getElementById('discount-remove');
  const discountPriceEl = document.getElementById('detail-discount-price');

  function getDiscountedPrice(originalPrice) {
    if (!appliedDiscount) return null;
    if (appliedDiscount.type === 'percent') {
      return originalPrice * (1 - appliedDiscount.value / 100);
    }
    return Math.max(0, originalPrice - appliedDiscount.value);
  }

  function updatePriceDisplay(item) {
    const priceEl = document.getElementById('detail-price');
    const originalPrice = Number(item.price);

    if (appliedDiscount && originalPrice > 0) {
      const discounted = getDiscountedPrice(originalPrice);
      priceEl.classList.add('discounted');
      discountPriceEl.textContent = '$' + discounted.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0});
      discountPriceEl.style.display = '';
    } else {
      priceEl.classList.remove('discounted');
      discountPriceEl.style.display = 'none';
    }
  }

  discountApplyBtn.addEventListener('click', async () => {
    const code = discountInput.value.trim().toUpperCase();
    if (!code) return;

    discountApplyBtn.disabled = true;
    discountApplyBtn.textContent = '...';

    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/discount_codes?code=eq.${encodeURIComponent(code)}&is_active=eq.true&select=code,type,value,max_uses,used_count`, {
        headers: {
          'apikey': SUPA_ANON,
          'Authorization': 'Bearer ' + SUPA_ANON
        }
      });
      const data = await res.json();

      if (data.length === 0) {
        discountInput.style.borderColor = '#c00';
        setTimeout(() => { discountInput.style.borderColor = ''; }, 2000);
        discountApplyBtn.disabled = false;
        discountApplyBtn.textContent = 'Apply';
        return;
      }

      const disc = data[0];
      if (disc.max_uses && disc.used_count >= disc.max_uses) {
        discountInput.style.borderColor = '#c00';
        setTimeout(() => { discountInput.style.borderColor = ''; }, 2000);
        discountApplyBtn.disabled = false;
        discountApplyBtn.textContent = 'Apply';
        return;
      }

      appliedDiscount = { code: disc.code, type: disc.type, value: Number(disc.value) };
      const label = disc.type === 'percent' ? `${disc.code} — ${disc.value}% off` : `${disc.code} — $${disc.value} off`;
      discountBadge.textContent = label;
      discountInputWrap.style.display = 'none';
      discountApplied.style.display = '';

      // Get current item from hash
      const itemId = location.hash.slice(1);
      const item = items.find(i => i.id === itemId);
      if (item) updatePriceDisplay(item);

      trackEvent('discount_applied', itemId);
    } catch {
      discountApplyBtn.disabled = false;
      discountApplyBtn.textContent = 'Apply';
    }
  });

  discountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); discountApplyBtn.click(); }
  });

  discountRemoveBtn.addEventListener('click', () => {
    appliedDiscount = null;
    discountInput.value = '';
    discountApplied.style.display = 'none';
    discountInputWrap.style.display = '';
    discountApplyBtn.disabled = false;
    discountApplyBtn.textContent = 'Apply';

    const itemId = location.hash.slice(1);
    const item = items.find(i => i.id === itemId);
    if (item) updatePriceDisplay(item);
  });

  // --- Init ---
  // Render preloaded items instantly (above-the-fold), then load full inventory async
  if (window.__PRELOAD && window.__PRELOAD.length) {
    items = window.__PRELOAD;
    loadingEl.classList.add('hidden');
    renderGrid();
  }
  load();
})();
