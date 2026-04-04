(function () {
  'use strict';

  // --- Config ---
  const APP_VERSION = 'v57';
  const REPO = 'harker760';
  const OWNER = 'elikagan';
  const BRANCH = 'main';
  // GitHub API calls routed through worker (no client-side token)
  const PIN_HASH = '7f6257b880b51353e620ab9224907e72348e8d2c3c1f6e0ba9866661acbc05e9';

  // --- IndexedDB persistent storage ---
  const DB_NAME = 'h760_admin';
  const DB_STORE = 'kv';
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function store(key, val) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function load(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? '');
      req.onerror = () => reject(req.error);
    });
  }

  // --- State ---
  // All API keys are server-side in Cloudflare Worker secrets
  const supaUrl = 'https://gjlwoibtdgxlhtfswdkk.supabase.co';
  const supaKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqbHdvaWJ0ZGd4bGh0ZnN3ZGtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNTYzODgsImV4cCI6MjA4NzczMjM4OH0.4QSS1BBMBuqbMtLjo_Tr0_WVTS48YYNsNYvtEMTf33U';
  let currentPin = null;
  let items = [];
  let inventorySha = '';
  let editingId = null;
  let photos = []; // { file, dataUrl, processed, remotePath? }
  let sortable = null;
  let photoSortable = null;
  let analyticsRange = 1;

  // --- Encrypted config (keys stored in repo, decrypted with PIN) ---

  function xorCipher(key, text) {
    return text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('');
  }

  async function encryptConfig(pin, data) {
    const json = JSON.stringify(data);
    if (!crypto.subtle) return 'X' + btoa(xorCipher(pin, json));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
    const buf = new Uint8Array(28 + ct.byteLength);
    buf.set(salt, 0);
    buf.set(iv, 16);
    buf.set(new Uint8Array(ct), 28);
    return 'A' + btoa(String.fromCharCode(...buf));
  }

  async function decryptConfig(pin, encoded) {
    if (encoded[0] === 'X') return JSON.parse(xorCipher(pin, atob(encoded.slice(1))));
    const buf = Uint8Array.from(atob(encoded.slice(1)), c => c.charCodeAt(0));
    const salt = buf.slice(0, 16);
    const iv = buf.slice(16, 28);
    const ct = buf.slice(28);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(dec));
  }

  // Config backup removed — all keys are server-side worker secrets now

  // --- DOM refs ---
  const viewLock = document.getElementById('view-lock');
  const viewSetup = document.getElementById('view-setup');
  const viewList = document.getElementById('view-list');
  const viewEditor = document.getElementById('view-editor');
  const viewAnalytics = document.getElementById('view-analytics');
  const viewMarketing = document.getElementById('view-marketing');
  const viewGiftcerts = document.getElementById('view-giftcerts');
  const viewSales = document.getElementById('view-sales');
  const itemList = document.getElementById('item-list');
  const photoGrid = document.getElementById('photo-grid');
  const photoInput = document.getElementById('photo-input');
  const status = document.getElementById('processing-status');
  const toastEl = document.getElementById('toast');

  // --- Version label ---
  const versionLabel = document.getElementById('version-label');
  if (versionLabel) versionLabel.textContent = APP_VERSION;

  // --- PIN Lock ---

  async function hashPin(pin) {
    const data = new TextEncoder().encode(pin);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Rate limiting for PIN attempts
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
  let pinAttempts = 0;
  let lockoutUntil = 0;

  document.getElementById('form-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();

    // Check lockout
    if (Date.now() < lockoutUntil) {
      const mins = Math.ceil((lockoutUntil - Date.now()) / 60000);
      toast(`Locked out. Try again in ${mins}m`);
      return;
    }

    const pin = document.getElementById('input-pin').value;
    const hash = await hashPin(pin);
    if (hash === PIN_HASH) {
      pinAttempts = 0;
      currentPin = pin;
      await store('h760_unlocked', '1');
      await boot(pin);
    } else {
      pinAttempts++;
      if (pinAttempts >= MAX_ATTEMPTS) {
        lockoutUntil = Date.now() + LOCKOUT_MS;
        pinAttempts = 0;
        toast('Too many attempts. Locked for 5 minutes');
      } else {
        toast(`Wrong PIN (${MAX_ATTEMPTS - pinAttempts} left)`);
      }
      document.getElementById('input-pin').value = '';
    }
  });

  // --- Init ---

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }

  // One-time: clear old cookies and localStorage from previous versions
  ['ol_unlocked', 'ol_gh_token', 'ol_gemini_key', 'ol_dealer_code'].forEach(k => {
    try { localStorage.removeItem(k); } catch {}
    document.cookie = k + '=;path=/admin;max-age=0';
  });

  // Boot: PIN unlocks admin, all API keys are server-side
  async function boot(pin) {
    if (pin) currentPin = pin;
    const unlocked = await load('h760_unlocked');

    if (!unlocked && !currentPin) {
      showView('lock');
      return;
    }

    // Go straight to inventory — no key setup needed
    loadInventory();
    const hash = location.hash.slice(1);
    if (hash === 'analytics') { showView('analytics'); loadAnalytics(); }
    else if (hash === 'giftcerts') { showView('giftcerts'); loadGiftCertificates(); }
    else if (hash === 'marketing') { showView('marketing'); loadMarketing(); }
    else if (hash === 'sales') { showView('sales'); loadSales(); }
    else { showView('list'); }
  }

  boot();

  // --- Setup ---

  document.getElementById('btn-save-setup').addEventListener('click', async () => {
    showView('list');
    loadInventory();
  });

  // --- Hamburger menu ---
  const menuDropdown = document.getElementById('menu-dropdown');

  document.getElementById('btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) menuDropdown.classList.add('hidden');
  });

  document.getElementById('menu-settings').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    document.getElementById('setup-topbar').style.display = '';
    document.getElementById('setup-logo').style.display = 'none';
    document.getElementById('setup-text').style.display = 'none';
    showView('setup');
  });

  document.getElementById('menu-analytics').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'analytics';
    showView('analytics');
    loadAnalytics();
  });

  document.getElementById('menu-sales').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'sales';
    showView('sales');
    loadSales();
  });

  document.getElementById('menu-giftcerts').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'giftcerts';
    showView('giftcerts');
    loadGiftCertificates();
  });

  document.getElementById('menu-marketing').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'marketing';
    showView('marketing');
    loadMarketing();
  });

  document.getElementById('btn-analytics-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  document.getElementById('btn-sales-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  // Date range toggle
  document.getElementById('range-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    analyticsRange = parseInt(btn.dataset.range, 10);
    document.getElementById('range-toggle').querySelector('.active')?.classList.remove('active');
    btn.classList.add('active');
    loadAnalytics();
  });

  // Pull-to-refresh on analytics view
  (function () {
    const av = document.getElementById('view-analytics');
    let ptrY = 0, ptrOn = false;
    av.addEventListener('touchstart', (e) => {
      if (window.scrollY === 0) { ptrY = e.touches[0].clientY; ptrOn = true; }
    }, { passive: true });
    av.addEventListener('touchmove', (e) => {
      if (!ptrOn) return;
      if (e.touches[0].clientY - ptrY > 80 && window.scrollY === 0) { ptrOn = false; loadAnalytics(); }
    }, { passive: true });
    av.addEventListener('touchend', () => { ptrOn = false; }, { passive: true });
  })();

  document.getElementById('btn-cancel-setup').addEventListener('click', () => {
    showView('list');
  });

  // --- Navigation ---

  function showView(name) {
    [viewLock, viewSetup, viewList, viewEditor, viewAnalytics, viewMarketing, viewGiftcerts, viewSales].forEach(v => v.classList.add('hidden'));
    const v = { lock: viewLock, setup: viewSetup, list: viewList, editor: viewEditor, analytics: viewAnalytics, marketing: viewMarketing, giftcerts: viewGiftcerts, sales: viewSales }[name];
    if (v) v.classList.remove('hidden');
  }

  // --- GitHub API helpers ---

  // All GitHub API calls go through worker (token stays server-side)
  async function ghProxy(action, path, opts = {}) {
    const res = await fetch(WORKER_URL + '/admin/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, path: `${OWNER}/${REPO}/contents/${opts.filePath || path}`, ...opts })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function getFile(path) {
    return ghProxy('get', path, { filePath: path + '?ref=' + BRANCH });
  }

  async function putFile(path, content, sha, message) {
    return ghProxy('put', path, {
      filePath: path,
      content: btoa(unescape(encodeURIComponent(content))),
      sha, message, branch: BRANCH
    });
  }

  async function putFileBinary(path, base64, sha, message) {
    return ghProxy('put', path, {
      filePath: path,
      content: base64, sha, message, branch: BRANCH
    });
  }

  async function uploadWithRetry(path, base64, message) {
    let sha = null;
    try { sha = (await getFile(path)).sha; } catch (_) {}
    try {
      await putFileBinary(path, base64, sha, message);
    } catch (e) {
      if (e.message && (e.message.includes('does not match') || e.message.includes('409'))) {
        // SHA conflict — re-fetch SHA and retry once
        try { sha = (await getFile(path)).sha; } catch (_) {}
        await putFileBinary(path, base64, sha, message);
      } else {
        throw e;
      }
    }
  }

  async function deleteFile(path, sha, message) {
    return ghProxy('delete', path, { filePath: path, sha, message, branch: BRANCH });
  }

  // --- Load inventory ---

  async function loadInventory() {
    try {
      const file = await getFile('inventory.json');
      inventorySha = file.sha;
      if (file.content) {
        items = JSON.parse(atob(file.content.replace(/\n/g, '')));
      } else {
        // File >1MB — Contents API omits content; fetch raw instead
        const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/inventory.json?t=${Date.now()}`);
        items = await res.json();
      }
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      items = [];
      inventorySha = '';
    }
    renderList();
    // Reconcile sales — catch any items the webhook failed to mark sold
    reconcileSales();
  }

  async function reconcileSales() {
    try {
      const resp = await fetch(`${WORKER_URL}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!resp.ok) return;
      const data = await resp.json();
      const sales = data.sales || [];
      // Find item sales (not gift certs) where the item is still not marked sold
      let fixed = 0;
      for (const sale of sales) {
        if (sale.type === 'gift_certificate' || !sale.item_id) continue;
        const item = items.find(i => i.id === sale.item_id);
        if (item && !item.isSold) {
          item.isSold = true;
          item.isNew = false;
          item.isHold = false;
          fixed++;
        }
      }
      if (fixed > 0) {
        await saveInventory(`Reconcile ${fixed} missed sale${fixed > 1 ? 's' : ''}`);
        renderList();
        console.log(`[Reconcile] Fixed ${fixed} items not marked sold`);
      }
    } catch (e) {
      console.warn('[Reconcile] Failed:', e.message);
    }
  }

  // --- Render list ---

  function renderList() {
    if (items.length === 0) {
      itemList.innerHTML = '<div class="list-empty">No items yet. Tap + to add one.</div>';
      return;
    }

    const active = items.filter(i => !i.isSold);
    const sold = items.filter(i => i.isSold);

    function itemRowHtml(item) {
      const thumb = item.heroImage || (item.images && item.images[0]) || '';
      const imgHtml = thumb ? `<img src="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${thumb}" alt="">` : '';
      let badge = '';
      if (item.isSold) badge = '<span class="item-sold">Sold</span>';
      else if (item.isHold) badge = '<span class="item-hold">Hold</span>';
      else if (item.isNew) badge = '<span class="item-new">New</span>';
      return `
        <div class="swipe-wrap" data-id="${item.id}">
          <div class="swipe-behind">
            <button class="swipe-delete" data-id="${item.id}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>
          </div>
          <div class="item-row" data-id="${item.id}">
            <div class="item-drag">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
            </div>
            <div class="item-thumb">${imgHtml}</div>
            <div class="item-info">
              <div class="item-name">${esc(item.title || 'Untitled')}</div>
              <div class="item-meta"><span class="item-id">${formatId(item.id)}</span> · $${Number(item.price || 0).toLocaleString()}</div>
            </div>
            ${badge}${item.postedBy ? `<span class="item-poster">${esc(item.postedBy)}</span>` : ''}
            <span class="item-category">${esc(item.category || '')}</span>
          </div>
        </div>
      `;
    }

    let html = active.map(itemRowHtml).join('');
    if (sold.length) {
      html += `<div class="archive-header" id="archive-header">
        <span>Archive</span>
        <span class="archive-count">${sold.length}</span>
        <svg class="archive-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>`;
      html += `<div class="archive-items" id="archive-items">${sold.map(itemRowHtml).join('')}</div>`;
    }
    itemList.innerHTML = html;

    // Archive toggle
    const archiveHeader = document.getElementById('archive-header');
    if (archiveHeader) {
      archiveHeader.addEventListener('click', () => {
        archiveHeader.classList.toggle('collapsed');
        document.getElementById('archive-items').classList.toggle('collapsed');
      });
    }

    // Sortable
    if (sortable) sortable.destroy();
    sortable = new Sortable(itemList, {
      handle: '.item-drag',
      ghostClass: 'sortable-ghost',
      animation: 200,
      filter: '.archive-header, .archive-items',
      onMove(evt) { return !evt.related.classList.contains('archive-header') && !evt.related.classList.contains('archive-items'); },
      onEnd: handleReorder
    });

    // Swipe-to-reveal delete
    initSwipeRows();

    // Click to edit
    itemList.querySelectorAll('.item-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.item-drag')) return;
        openEditor(row.dataset.id);
      });
    });

    // Delete from list (swipe-revealed button)
    itemList.querySelectorAll('.swipe-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = items.find(i => i.id === id);
        if (!item) return;
        confirm('Delete ' + (item.title || 'this item') + '?', async () => {
          const imagesToDelete = [...(item.images || [])];
          items = items.filter(i => i.id !== id);
          await saveInventory('Delete ' + (item.title || 'item'));
          toast('Deleted');
          renderList();
          // Delete images in background
          for (const img of imagesToDelete) {
            try {
              const f = await getFile(img);
              await deleteFile(img, f.sha, 'Delete image');
            } catch (e) { /* ignore */ }
          }
        });
      });
    });
  }

  // --- Swipe-to-reveal ---
  const SWIPE_THRESHOLD = 70;
  let openSwipeWrap = null;

  function closeOpenSwipe() {
    if (openSwipeWrap) {
      openSwipeWrap.querySelector('.item-row').style.transform = '';
      openSwipeWrap = null;
    }
  }

  function initSwipeRows() {
    itemList.querySelectorAll('.swipe-wrap').forEach(wrap => {
      const row = wrap.querySelector('.item-row');
      let startX = 0, startY = 0, dx = 0, swiping = false;

      row.addEventListener('touchstart', e => {
        if (e.target.closest('.item-drag')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0;
        swiping = false;
        row.style.transition = 'none';
      }, { passive: true });

      row.addEventListener('touchmove', e => {
        const mx = e.touches[0].clientX - startX;
        const my = e.touches[0].clientY - startY;
        // Only swipe if horizontal movement > vertical
        if (!swiping && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) {
          swiping = true;
          if (openSwipeWrap && openSwipeWrap !== wrap) closeOpenSwipe();
        }
        if (!swiping) return;
        e.preventDefault();
        dx = Math.min(0, Math.max(-SWIPE_THRESHOLD, mx));
        row.style.transform = `translateX(${dx}px)`;
      }, { passive: false });

      row.addEventListener('touchend', () => {
        row.style.transition = 'transform 0.2s ease';
        if (dx < -SWIPE_THRESHOLD / 2) {
          row.style.transform = `translateX(-${SWIPE_THRESHOLD}px)`;
          openSwipeWrap = wrap;
        } else {
          row.style.transform = '';
          if (openSwipeWrap === wrap) openSwipeWrap = null;
        }
      }, { passive: true });
    });
  }

  // Close swipe when tapping elsewhere
  document.addEventListener('touchstart', e => {
    if (openSwipeWrap && !openSwipeWrap.contains(e.target)) {
      closeOpenSwipe();
    }
  }, { passive: true });

  async function handleReorder() {
    // Only reorder active (non-sold) items — exclude archive section
    const rows = itemList.querySelectorAll(':scope > .swipe-wrap > .item-row');
    const newOrder = Array.from(rows).map(r => r.dataset.id);
    const activeItems = newOrder.map((id, i) => {
      const item = items.find(it => it.id === id);
      return { ...item, order: i };
    });
    const soldItems = items.filter(i => i.isSold);
    items = [...activeItems, ...soldItems];
    await saveInventory('Reorder items');
  }

  // --- Save inventory ---

  async function saveInventory(message, _retried) {
    try {
      const json = JSON.stringify(items, null, 2);
      const result = await putFile('inventory.json', json, inventorySha, message || 'Update inventory');
      inventorySha = result.content.sha;
    } catch (e) {
      // SHA conflict (409) — merge remote changes and retry once
      if (!_retried && e.message && (e.message.includes('does not match') || e.message.includes('409'))) {
        try {
          const file = await getFile('inventory.json');
          inventorySha = file.sha;
          // Merge remote changes into local items (webhook may have marked items sold/hold)
          const remoteItems = JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, '')))));
          for (const ri of remoteItems) {
            const li = items.find(i => i.id === ri.id);
            if (!li) continue;
            // If remote marked sold/hold and local didn't, adopt remote state
            if (ri.isSold && !li.isSold) { li.isSold = true; li.isNew = false; li.isHold = false; }
            if (ri.isHold && !li.isHold) li.isHold = true;
            // Adopt any new fields from remote that local doesn't have
            for (const k of Object.keys(ri)) {
              if (!(k in li)) li[k] = ri[k];
            }
          }
          return saveInventory(message, true);
        } catch (retryErr) {
          toast('Save failed: ' + retryErr.message);
          throw retryErr;
        }
      }
      toast('Save failed: ' + e.message);
      throw e;
    }
  }

  // --- Editor ---

  document.getElementById('btn-add').addEventListener('click', () => openEditor(null));
  document.getElementById('btn-back').addEventListener('click', () => {
    showView('list');
    loadInventory();
  });

  function openEditor(id) {
    editingId = id;
    photos = [];

    const deleteBtn = document.getElementById('btn-delete-item');
    const titleEl = document.getElementById('editor-title');

    if (id) {
      const item = items.find(i => i.id === id);
      if (!item) return;
      titleEl.textContent = 'Edit Item';
      deleteBtn.style.display = '';
      document.getElementById('field-title').value = item.title || '';
      document.getElementById('field-desc').value = item.description || '';
      document.getElementById('field-price').value = item.price != null ? item.price : '';
      document.getElementById('field-size').value = item.size || '';
      document.getElementById('field-category').value = item.category || '';
      document.getElementById('field-maker').value = item.maker || '';
      document.getElementById('field-condition').value = item.condition || '';
      document.getElementById('field-dealer').value = item.dealerCode || '';
      document.getElementById('field-posted-by').value = item.postedBy || '';
      document.getElementById('field-new').checked = !!item.isNew;
      document.getElementById('field-hold').checked = !!item.isHold;
      document.getElementById('field-sold').checked = !!item.isSold;

      // Load existing images — hero is first, so put it first
      if (item.images) {
        const sorted = [...item.images].sort((a, b) => (a === item.heroImage ? -1 : b === item.heroImage ? 1 : 0));
        photos = sorted.map(img => ({
          file: null,
          dataUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${img}`,
          processed: true,
          remotePath: img
        }));
      }
    } else {
      titleEl.textContent = 'New Item';
      deleteBtn.style.display = 'none';
      document.getElementById('field-title').value = '';
      document.getElementById('field-desc').value = '';
      document.getElementById('field-price').value = '';
      document.getElementById('field-size').value = '';
      document.getElementById('field-category').value = '';
      document.getElementById('field-maker').value = '';
      document.getElementById('field-condition').value = '';
      document.getElementById('field-dealer').value = '';
      document.getElementById('field-posted-by').value = localStorage.getItem('h760_posted_by') || '';
      document.getElementById('field-new').checked = true;
      document.getElementById('field-hold').checked = false;
      document.getElementById('field-sold').checked = false;
    }

    renderPhotos();
    status.textContent = '';
    showView('editor');
  }

  // --- Delete item ---

  document.getElementById('btn-delete-item').addEventListener('click', () => {
    confirm('Delete this item?', async () => {
      const item = items.find(i => i.id === editingId);
      if (!item) return;

      // Remove from inventory immediately for instant feedback
      const imagesToDelete = [...(item.images || [])];
      items = items.filter(i => i.id !== editingId);
      await saveInventory('Delete ' + (item.title || 'item'));
      toast('Deleted');
      showView('list');
      renderList();

      // Delete images from repo in background (fire and forget)
      for (const img of imagesToDelete) {
        try {
          const f = await getFile(img);
          await deleteFile(img, f.sha, 'Delete image');
        } catch (e) { /* ignore */ }
      }
    });
  });

  // --- Photos ---

  photoInput.addEventListener('change', e => {
    for (const file of e.target.files) {
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = ev.target.result;
        photos.push({
          file,
          dataUrl,
          blobUrl: toBlobUrl(dataUrl),
          processed: false,
          aiProcess: true
        });
        renderPhotos();
      };
      reader.readAsDataURL(file);
    }
    photoInput.value = '';
  });

  let photoSortableGen = 0;

  function renderPhotos() {
    const gen = ++photoSortableGen;

    if (photoSortable) { photoSortable.destroy(); photoSortable = null; }

    if (photos.length === 0) {
      photoGrid.innerHTML = '';
      return;
    }

    // Use blob URLs for display (avoids embedding MB of base64 in DOM)
    photoGrid.innerHTML = photos.map((p, i) => `
      <div class="photo-cell" data-index="${i}">
        <img src="${p.blobUrl || p.dataUrl}" draggable="false">
        ${i === 0 ? '<span class="photo-hero-dot"></span>' : ''}
        <button class="photo-remove" data-index="${i}">&times;</button>
        ${!p.processed ? `<button class="photo-ai ${p.aiProcess !== false ? 'active' : ''}" data-index="${i}" title="AI processing">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
        </button>` : `<button class="photo-reprocess" data-index="${i}" title="Reprocess">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <div class="photo-reprocess-menu hidden" data-index="${i}">
          <button class="reprocess-opt" data-index="${i}" data-mode="lighting">Better lighting</button>
          <button class="reprocess-opt" data-index="${i}" data-mode="background">Better background removal</button>
          <button class="reprocess-opt" data-index="${i}" data-mode="shadow">Better shadow</button>
        </div>`}
      </div>
    `).join('');

    photoGrid.querySelectorAll('.photo-remove').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +b.dataset.index;
        // Revoke blob URL to free memory
        if (photos[idx] && photos[idx].blobUrl) URL.revokeObjectURL(photos[idx].blobUrl);
        photos.splice(idx, 1);
        renderPhotos();
      });
    });

    photoGrid.querySelectorAll('.photo-reprocess').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const menu = b.nextElementSibling;
        // Close any other open menus
        photoGrid.querySelectorAll('.photo-reprocess-menu').forEach(m => {
          if (m !== menu) m.classList.add('hidden');
        });
        menu.classList.toggle('hidden');
      });
    });

    photoGrid.querySelectorAll('.reprocess-opt').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        const idx = +b.dataset.index;
        const mode = b.dataset.mode;
        b.closest('.photo-reprocess-menu').classList.add('hidden');
        await reprocessImage(idx, mode);
      });
    });

    photoGrid.querySelectorAll('.photo-ai').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +b.dataset.index;
        photos[idx].aiProcess = !photos[idx].aiProcess;
        b.classList.toggle('active');
      });
    });

    // Close reprocess menus when clicking outside
    document.addEventListener('click', () => {
      photoGrid.querySelectorAll('.photo-reprocess-menu').forEach(m => m.classList.add('hidden'));
    }, { once: true });

    // Defer Sortable init until images have rendered
    requestAnimationFrame(() => {
      if (gen !== photoSortableGen) return; // stale call
      if (!photoGrid.children.length) return;
      photoSortable = new Sortable(photoGrid, {
        animation: 200,
        ghostClass: 'photo-ghost',
        delay: 150,
        delayOnTouchOnly: true,
        filter: '.photo-remove, .photo-reprocess, .photo-reprocess-menu, .reprocess-opt, .photo-ai',
        onEnd: (evt) => {
          const moved = photos.splice(evt.oldIndex, 1)[0];
          photos.splice(evt.newIndex, 0, moved);
          renderPhotos();
        }
      });
    });
  }

  // --- AI Processing ---

  document.getElementById('btn-process').addEventListener('click', processWithAI);

  async function processWithAI() {
    if (photos.length === 0) { toast('Add photos first'); return; }
    // Gemini key is now a worker secret — no local check needed

    const btn = document.getElementById('btn-process');
    btn.disabled = true;

    try {
      // 1. Auto-detect price tag, OCR it, remove it from photos
      if (photos.some(p => !p.processed)) {
        setStatus('Scanning for price tag...');
        const tagIndex = await geminiDetectTag(photos.map(p => p.dataUrl));
        if (tagIndex >= 0 && tagIndex < photos.length) {
          setStatus('Reading price tag...');
          const ocrResult = await geminiOCR(photos[tagIndex].dataUrl);
          if (ocrResult.price) document.getElementById('field-price').value = ocrResult.price;
          if (ocrResult.dealerCode) document.getElementById('field-dealer').value = ocrResult.dealerCode;
          if (ocrResult.itemName) document.getElementById('field-title').value = toTitleCase(ocrResult.itemName);
          // Remove tag photo from product photos
          photos.splice(tagIndex, 1);
          renderPhotos();
        }
      }

      // 2. Auto-detect tape measure and estimate dimensions
      const unprocessedForTape = photos.filter(p => !p.processed);
      if (unprocessedForTape.length > 0 && !document.getElementById('field-size').value) {
        setStatus('Checking for tape measure...');
        const tapeResult = await geminiDetectTapeMeasure(unprocessedForTape.map(p => p.dataUrl));
        if (tapeResult.size) {
          document.getElementById('field-size').value = tapeResult.size;
        }
        // Skip AI processing on the tape measure photo — leave it as-is
        if (tapeResult.tapeIndex >= 0 && tapeResult.tapeIndex < unprocessedForTape.length) {
          unprocessedForTape[tapeResult.tapeIndex].aiProcess = false;
          renderPhotos();
        }
      }

      // 3. Background removal on unprocessed product photos (skip ai-exempt)
      const unprocessed = photos.filter(p => !p.processed && p.aiProcess !== false);
      if (unprocessed.length > 0) {
        let failed = 0;
        for (let i = 0; i < unprocessed.length; i++) {
          setStatus(`Processing image ${i + 1} of ${unprocessed.length}...`);
          const cleaned = await geminiRemoveBackground(unprocessed[i].dataUrl);
          if (cleaned) {
            if (unprocessed[i].blobUrl) URL.revokeObjectURL(unprocessed[i].blobUrl);
            unprocessed[i].dataUrl = cleaned;
            unprocessed[i].blobUrl = toBlobUrl(cleaned);
            unprocessed[i].processed = true;
          } else {
            failed++;
            console.error(`Image ${i + 1} failed background removal after retries`);
          }
        }
        renderPhotos();
        if (failed > 0) {
          toast(`${failed} image${failed > 1 ? 's' : ''} failed processing — try again`);
        }
      }

      // 4. Suggest title, description, category, maker, condition
      if (photos.length > 0) {
        setStatus('Analyzing item...');
        const suggestions = await geminiSuggest(photos.map(p => p.dataUrl));
        if (suggestions.title && !document.getElementById('field-title').value) {
          document.getElementById('field-title').value = suggestions.title;
        }
        if (suggestions.description && !document.getElementById('field-desc').value) {
          document.getElementById('field-desc').value = suggestions.description;
        }
        if (suggestions.maker && !document.getElementById('field-maker').value) {
          document.getElementById('field-maker').value = suggestions.maker;
        }
        if (suggestions.condition && !document.getElementById('field-condition').value) {
          document.getElementById('field-condition').value = suggestions.condition;
        }
        if (suggestions.category && !document.getElementById('field-category').value) {
          document.getElementById('field-category').value = suggestions.category;
        }
      }

      setStatus('Done.');
      setTimeout(() => setStatus(''), 2000);
    } catch (e) {
      setStatus('Error: ' + e.message);
    }

    btn.disabled = false;
  }

  function setStatus(msg) {
    status.innerHTML = msg
      ? '<span class="spinner"></span>' + esc(msg)
      : '';
  }

  // --- Reprocess single image ---

  const reprocessPrompts = {
    lighting: 'This product photo has been processed but the lighting needs improvement. Significantly improve the lighting and color balance — make it look bright, clean, and professionally lit. Keep the pure white background, the exact same composition and crop, and any existing shadows. Only change the lighting on the object itself. Return only the edited image.',
    background: 'This product photo has been processed but still has background artifacts or an imperfect background. Completely remove all background elements and replace with pure white (#FFFFFF). Keep the exact same composition, crop, angle, scale, lighting, and shadows on the object. Only fix the background. Return only the edited image.',
    shadow: 'This product photo has been processed but the shadow needs improvement. Add a more natural, subtle shadow: for objects that sit on a surface, add a soft contact shadow directly beneath; for wall art or flat items, add a faint drop shadow behind as if wall-mounted. Remove any existing harsh, unnatural, or misplaced shadows first. Keep the white background and exact same composition. Return only the edited image.'
  };

  async function reprocessImage(idx, mode) {
    const photo = photos[idx];
    if (!photo) return;

    const prompt = reprocessPrompts[mode];
    if (!prompt) return;

    // Show spinner overlay on the photo
    const cell = photoGrid.querySelector(`.photo-cell[data-index="${idx}"]`);
    if (cell) {
      const overlay = document.createElement('div');
      overlay.className = 'photo-processing-overlay';
      overlay.innerHTML = '<span class="photo-spinner"></span>';
      cell.appendChild(overlay);
    }

    const btn = document.getElementById('btn-process');
    btn.disabled = true;

    try {
      const resized = await resizeImage(photo.dataUrl, 1536);
      const base64 = dataUrlToBase64(resized);
      const result = await geminiCall('gemini-2.5-flash-image', [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/jpeg', data: base64 } }
        ]
      }], { responseModalities: ['IMAGE', 'TEXT'] });

      const parts = result.candidates[0].content.parts;
      const imgPart = parts.find(p => p.inlineData);
      if (imgPart) {
        if (photo.blobUrl) URL.revokeObjectURL(photo.blobUrl);
        photo.dataUrl = `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
        photo.blobUrl = toBlobUrl(photo.dataUrl);
        photo.remotePath = null; // force re-upload on save
        renderPhotos();
        toast('Reprocessed.');
      } else {
        const textPart = result.candidates[0].content.parts.find(p => p.text);
        console.warn('Reprocess: no image returned. Response:', textPart?.text || '(none)');
        toast('Reprocess failed — try again');
        // Remove overlay
        if (cell) { const o = cell.querySelector('.photo-processing-overlay'); if (o) o.remove(); }
      }
    } catch (e) {
      console.error('Reprocess error:', e.message);
      toast('Reprocess error — try again');
      if (cell) { const o = cell.querySelector('.photo-processing-overlay'); if (o) o.remove(); }
    }

    btn.disabled = false;
  }

  // --- Gemini API ---

  async function geminiCall(model, contents, config = {}) {
    const res = await fetch(WORKER_URL + '/admin/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, contents, generationConfig: config })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    return res.json();
  }

  function dataUrlToBase64(dataUrl) {
    return dataUrl.split(',')[1];
  }

  function dataUrlMimeType(dataUrl) {
    return dataUrl.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  }

  // Resize image to max dimension for lighter API calls
  function resizeImage(dataUrl, maxDim, quality = 0.82) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = dataUrl;
    });
  }

  async function geminiOCR(dataUrl) {
    const resized = await resizeImage(dataUrl, 1024);
    const result = await geminiCall('gemini-2.5-flash', [{
      parts: [
        { text: 'Read all text on this price tag or label from an antique store. Extract: the price (number without $ symbol), the dealer code (alphanumeric, usually 2-5 characters like "14EK"), and the item name or description (e.g. "Lauterback Encaustic" or "Studio Vase"). Return ONLY valid JSON: {"price": number_or_null, "dealerCode": "string_or_null", "itemName": "string_or_null", "text": "all visible text"}' },
        { inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(resized) } }
      ]
    }], { responseMimeType: 'application/json' });

    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function geminiDetectTag(dataUrls) {
    // Resize to small thumbnails — only need to identify which is a price tag
    const thumbs = await Promise.all(dataUrls.map(url => resizeImage(url, 512)));
    const parts = [
      { text: `I have ${thumbs.length} photos of an antique/vintage item for sale. One of them might be a photo of a price tag or label (handwritten or printed text on a small card/sticker). Which image index (0-based) is the price tag? If none is a price tag, return -1. Return ONLY valid JSON: {"tagIndex": number}` }
    ];
    for (const url of thumbs) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(url) } });
    }
    const result = await geminiCall('gemini-2.5-flash', [{ parts }], {
      responseMimeType: 'application/json'
    });
    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text).tagIndex ?? -1;
    } catch {
      return -1;
    }
  }

  async function geminiDetectTapeMeasure(dataUrls) {
    // Use higher resolution so tape markings are legible
    const imgs = await Promise.all(dataUrls.slice(0, 4).map(url => resizeImage(url, 1536)));
    const parts = [
      { text: `These are ${imgs.length} photos of an item for sale. Check if any photo contains a tape measure, ruler, or measuring tool. If yes, READ THE ACTUAL NUMBERS AND MARKINGS on the measuring tool — do NOT estimate or guess. Look at where the tape measure starts and ends against the object, read the inch/cm markings at those points, and calculate the exact measurement shown. Report the dimensions you READ from the tool. Format as a concise size string, e.g.: 9.5" L × 4" W or 14" H or 12" diameter. Also return the 0-based image index of the photo containing the measuring tool. If no measuring tool is visible, return empty string and -1. Return ONLY valid JSON: {"size": "string", "tapeIndex": number}` }
    ];
    for (const url of imgs) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(url) } });
    }
    const result = await geminiCall('gemini-2.5-flash', [{ parts }], {
      responseMimeType: 'application/json'
    });
    try {
      const text = result.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(text);
      return { size: parsed.size || '', tapeIndex: parsed.tapeIndex ?? -1 };
    } catch {
      return { size: '', tapeIndex: -1 };
    }
  }

  async function geminiRemoveBackground(dataUrl) {
    const resized = await resizeImage(dataUrl, 1536);
    const base64 = dataUrlToBase64(resized);

    // Retry up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await geminiCall('gemini-2.5-flash-image', [{
          parts: [
            { text: 'Edit this photo. Output the edited image. Remove everything except the main object. Set the background to solid white. Keep the object in the same position and size. Improve the lighting on the object. Add a small soft shadow under the object.' },
            { inlineData: { mimeType: 'image/jpeg', data: base64 } }
          ]
        }], { responseModalities: ['IMAGE', 'TEXT'] });

        const parts = result.candidates[0].content.parts;
        const imgPart = parts.find(p => p.inlineData);
        if (imgPart) {
          return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
        }
        const textPart = parts.find(p => p.text);
        console.warn(`BG removal attempt ${attempt + 1}: no image. Response:`, textPart?.text || '(none)');
      } catch (e) {
        console.warn(`BG removal attempt ${attempt + 1} failed:`, e.message);
      }
    }
    return null;
  }

  const WORKER_URL = 'https://h760-checkout.harker760.workers.dev';

  // Gemini lighting enhancement on already-cutout image
  async function geminiEnhanceLighting(dataUrl) {
    const base64 = dataUrlToBase64(dataUrl);
    try {
      const result = await geminiCall('gemini-2.5-flash-image', [{
        parts: [
          { text: 'This is a product photo on a white background. Improve the lighting to look like professional product photography — bright, clean, even lighting. Keep the white background pure white. Keep the exact same composition and object. Add a small soft natural shadow. Output the edited image.' },
          { inlineData: { mimeType: 'image/jpeg', data: base64 } }
        ]
      }], { responseModalities: ['IMAGE', 'TEXT'] });

      const parts = result.candidates[0].content.parts;
      const imgPart = parts.find(p => p.inlineData);
      if (imgPart) {
        return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function geminiSuggest(dataUrls) {
    const thumbs = await Promise.all(dataUrls.slice(0, 4).map(url => resizeImage(url, 768)));
    const parts = [
      { text: 'You are cataloging items for a vintage/antique shop. Based on these photos, provide: a short title (2-5 words, title case, just what the object is), a description (one short factual sentence — material, color, era, style. Write it like a search-friendly label, e.g. "Small red ceramic vase" or "Mid-century walnut side table with tapered legs." Do NOT start with "This" or "A" or "An" or "Looks like" or "Features" or "Appears to be". No AI-sounding language. No marketing.), a category (exactly one of: wall-art, object, ceramic, furniture, light, sculpture, misc), a maker or brand if identifiable (empty string if unknown), and condition (brief description of visible wear — e.g. "Excellent", "Good, minor wear to edges" — empty string if can\'t tell). Return ONLY valid JSON: {"title": "string", "description": "string", "category": "string", "maker": "string", "condition": "string"}' }
    ];
    for (const url of thumbs) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(url) } });
    }

    const result = await geminiCall('gemini-2.5-flash', [{ parts }], {
      responseMimeType: 'application/json'
    });

    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  // --- SEO: static item pages, sitemap, Google/IndexNow notification ---

  const SITE_URL = 'https://harker760.com';
  const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
  const INDEXNOW_KEY = 'a1b2c3d4e5f6g7h8harker760';

  function seoImgUrl(path) {
    if (!path || path.startsWith('http')) return path;
    return `${RAW_URL}/${path}`;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escXml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function generateItemPageHtml(item) {
    const url = `${SITE_URL}/item/${item.id}/`;
    const heroImg = seoImgUrl(item.heroImage || (item.images && item.images[0]) || '');
    const allImages = (item.images || []).map(seoImgUrl);
    const desc = item.description || `${item.title} — available at Harker760.`;
    const availability = item.isSold ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock';
    const soldLabel = item.isSold ? ' (Sold)' : '';
    const price = Number(item.price) || 0;
    const sd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product',
      name: item.title, description: desc, image: allImages,
      brand: { '@type': 'Brand', name: 'Harker760' },
      ...(item.maker ? { manufacturer: { '@type': 'Organization', name: item.maker } } : {}),
      ...(item.condition ? { itemCondition: 'https://schema.org/UsedCondition' } : {}),
      offers: { '@type': 'Offer', price: price.toString(), priceCurrency: 'USD', availability, url,
        seller: { '@type': 'Organization', name: 'Harker760', url: SITE_URL } }
    });
    const addlImgs = allImages.slice(1);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(item.title)}${soldLabel} | Harker760</title>
  <meta name="description" content="${escHtml(desc.slice(0, 160))}">
  <link rel="canonical" href="${url}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta property="og:title" content="${escHtml(item.title)}">
  <meta property="og:description" content="${escHtml(desc.slice(0, 200))}">
  <meta property="og:type" content="product">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${escHtml(heroImg)}">
  <meta property="og:site_name" content="Harker760">
  <meta property="product:price:amount" content="${price}">
  <meta property="product:price:currency" content="USD">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(item.title)}">
  <meta name="twitter:description" content="${escHtml(desc.slice(0, 200))}">
  <meta name="twitter:image" content="${escHtml(heroImg)}">
  <script type="application/ld+json">${sd}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111;background:#fff;-webkit-font-smoothing:antialiased}
    header{padding:20px;text-align:center;border-bottom:1px solid #eee}
    header img{height:22px}
    header a{text-decoration:none}
    main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
    .hero{width:100%;aspect-ratio:1;object-fit:contain;background:#f5f5f5;border-radius:8px;display:block}
    .thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-top:12px}
    .thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px}
    h1{font-size:20px;font-weight:500;margin-top:20px;line-height:1.3}
    .price{font-size:18px;color:#333;margin-top:8px}
    .sold-badge{display:inline-block;background:#111;color:#fff;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border-radius:3px;margin-top:8px}
    .desc{color:#555;margin-top:12px;line-height:1.6;font-size:15px}
    .meta{color:#888;margin-top:8px;font-size:14px}
    .cta{display:inline-block;margin-top:24px;padding:14px 36px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;letter-spacing:0.3px}
    .cta:hover{background:#333}
    footer{text-align:center;padding:32px 16px;color:#999;font-size:13px;border-top:1px solid #eee;margin-top:32px}
    footer a{color:#666;text-decoration:none}
  </style>
</head>
<body>
  <header><a href="${SITE_URL}/" style="font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;font-size:18px;text-decoration:none;color:#111">HARKER760</a></header>
  <main>
    ${heroImg ? `<img class="hero" src="${escHtml(heroImg)}" alt="${escHtml(item.title)}" width="1536" height="1536">` : ''}
    ${addlImgs.length > 0 ? `<div class="thumbs">${addlImgs.map((img, i) =>
      `<img src="${escHtml(img)}" alt="${escHtml(item.title)} — detail ${i + 2}" width="1536" height="1536" loading="lazy">`
    ).join('')}</div>` : ''}
    <h1>${escHtml(item.title)}</h1>
    ${item.isSold ? '<span class="sold-badge">Sold</span>' : `<p class="price">$${price.toLocaleString()}</p>`}
    ${desc ? `<p class="desc">${escHtml(desc)}</p>` : ''}
    ${item.size ? `<p class="meta">${escHtml(item.size)}</p>` : ''}
    ${item.maker ? `<p class="meta">${escHtml(item.maker)}</p>` : ''}
    ${item.condition ? `<p class="meta">Condition: ${escHtml(item.condition)}</p>` : ''}
    <a class="cta" href="${SITE_URL}/#${item.id}">${item.isSold ? 'Browse Collection' : 'View Item'} &rarr;</a>
  </main>
  <footer><a href="${SITE_URL}/">Harker760</a></footer>
</body>
</html>`;
  }

  function generateSitemapXml(allItems) {
    const now = new Date().toISOString().slice(0, 10);
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>\n`;
    for (const item of allItems) {
      const lm = item.createdAt ? new Date(item.createdAt).toISOString().slice(0, 10) : now;
      xml += `  <url>\n    <loc>${SITE_URL}/item/${item.id}/</loc>\n    <lastmod>${lm}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n`;
      for (const img of (item.images || []).map(seoImgUrl)) {
        xml += `    <image:image>\n      <image:loc>${escXml(img)}</image:loc>\n      <image:title>${escXml(item.title)}</image:title>\n    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }
    xml += `</urlset>`;
    return xml;
  }

  async function updateSEO(savedItem) {
    try {
      // 1. Push/update the item's static HTML page
      const pagePath = `item/${savedItem.id}/index.html`;
      const pageHtml = generateItemPageHtml(savedItem);
      let pageSha = null;
      try { pageSha = (await getFile(pagePath)).sha; } catch (_) {}
      await putFile(pagePath, pageHtml, pageSha, `SEO: update ${savedItem.title}`);

      // 2. Regenerate and push sitemap.xml
      const sitemapXml = generateSitemapXml(items);
      let smSha = null;
      try { smSha = (await getFile('sitemap.xml')).sha; } catch (_) {}
      await putFile('sitemap.xml', sitemapXml, smSha, 'Update sitemap');

      // 3. Notify IndexNow (Bing, Yandex) — fire and forget
      const itemUrl = `${SITE_URL}/item/${savedItem.id}/`;
      fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'harker760.com',
          key: INDEXNOW_KEY,
          urlList: [itemUrl]
        })
      }).catch(() => {});

      // 4. Ping Google sitemap (simple GET)
      fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(SITE_URL + '/sitemap.xml')}`).catch(() => {});

      console.log('[SEO] Updated page + sitemap + pinged search engines for', savedItem.id);
    } catch (e) {
      console.warn('[SEO] Failed:', e.message);
      // Non-critical — don't block the save flow
    }
  }

  // --- Save item ---

  let saveInProgress = false;
  document.getElementById('btn-save').addEventListener('click', saveItem);

  async function saveItem() {
    // Prevent double-tap race condition
    if (saveInProgress) return;
    saveInProgress = true;

    const title = document.getElementById('field-title').value.trim();
    const description = document.getElementById('field-desc').value.trim();
    const priceVal = document.getElementById('field-price').value.trim();
    const price = priceVal === '' ? 0 : parseFloat(priceVal);
    if (isNaN(price) || price < 0) { toast('Enter a valid price'); saveInProgress = false; return; }
    const size = document.getElementById('field-size').value.trim();
    const category = document.getElementById('field-category').value;
    const maker = document.getElementById('field-maker').value.trim();
    const condition = document.getElementById('field-condition').value;
    const dc = document.getElementById('field-dealer').value.trim();
    const postedBy = document.getElementById('field-posted-by').value.trim();
    if (postedBy) localStorage.setItem('h760_posted_by', postedBy);
    const isNew = document.getElementById('field-new').checked;
    const isHold = document.getElementById('field-hold').checked;
    const isSold = document.getElementById('field-sold').checked;

    if (!title) { toast('Title is required'); saveInProgress = false; return; }
    if (!category) { toast('Category is required'); saveInProgress = false; return; }

    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';

    try {
      const id = editingId || nextId();
      const imgDir = `images/products/${id}`;
      const uploadedImages = [];

      // SEO-friendly slug from title
      const slug = title.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

      // Upload photos (first = hero)
      const newPhotos = photos.filter(p => !p.remotePath);
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];

        if (p.remotePath) {
          uploadedImages.push(p.remotePath);
          continue;
        }

        const photoNum = newPhotos.indexOf(p) + 1;
        btn.innerHTML = `<span class="spinner"></span> Uploading photo ${photoNum}/${newPhotos.length}...`;

        const fname = `${slug}_${i + 1}.jpg`;
        const path = `${imgDir}/${fname}`;
        const thumbPath = `${imgDir}/thumb_${fname}`;

        // Optimize: resize to 1200px max, JPEG quality 82
        const optimized = await resizeImage(p.dataUrl, 1200, 0.82);
        const base64 = dataUrlToBase64(optimized);

        // Generate 400px thumbnail for grid view
        const thumb = await resizeImage(p.dataUrl, 400, 0.75);
        const thumbBase64 = dataUrlToBase64(thumb);

        // Upload full image (with SHA conflict retry)
        await uploadWithRetry(path, base64, 'Add product image');

        // Upload thumbnail
        await uploadWithRetry(thumbPath, thumbBase64, 'Add thumbnail');

        uploadedImages.push(path);
      }

      // Build item — first image is always the hero
      const prevItem = editingId ? items.find(i => i.id === editingId) : null;
      const itemData = {
        id,
        title,
        description,
        price,
        size,
        category,
        maker,
        condition,
        dealerCode: dc,
        postedBy: postedBy || (prevItem?.postedBy || ''),
        isNew: isSold ? false : isNew,
        isHold: isSold ? false : isHold,
        isSold,
        images: uploadedImages,
        heroImage: uploadedImages[0] || '',
        order: editingId ? (prevItem?.order ?? 0) : 0,
        createdAt: editingId ? prevItem?.createdAt : new Date().toISOString()
      };

      if (editingId) {
        items = items.map(i => i.id === editingId ? itemData : i);
      } else {
        // Push existing items down so the new one appears first
        items.forEach(i => { i.order = (i.order ?? 0) + 1; });
        items.push(itemData);
      }

      // Sort so new item (order 0) appears at top immediately
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      await saveInventory((editingId ? 'Update ' : 'Add ') + title);

      // Update SEO files (item page + sitemap + ping search engines) — fire and forget
      updateSEO(itemData).catch(() => {});

      toast('Saved');
      showView('list');
      renderList();
    } catch (e) {
      toast('Error: ' + e.message);
    }

    btn.disabled = false;
    btn.innerHTML = 'Save';
    saveInProgress = false;
  }

  // --- Analytics ---

  const catLabels = {
    'wall-art': 'Wall Art', 'object': 'Object', 'ceramic': 'Ceramic',
    'furniture': 'Furniture', 'light': 'Light', 'sculpture': 'Sculpture', 'misc': 'Misc'
  };

  async function supaSelect(params) {
    if (!supaUrl || !supaKey) return [];
    const url = `${supaUrl}/rest/v1/events?${params}`;
    const res = await fetch(url, {
      headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
    });
    if (!res.ok) return [];
    return res.json();
  }

  function daysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10) + 'T00:00:00Z';
  }

  function pctChange(cur, prev) {
    if (prev === 0 && cur === 0) return { t: '—', c: 'flat' };
    if (prev === 0) return { t: '\u2191 new', c: 'up' };
    const p = Math.round((cur - prev) / prev * 100);
    if (p === 0) return { t: '—', c: 'flat' };
    if (p > 0) return { t: '\u2191 ' + p + '%', c: 'up' };
    return { t: '\u2193 ' + Math.abs(p) + '%', c: 'down' };
  }

  async function loadAnalytics() {
    const body = document.getElementById('analytics-body');

    if (!supaUrl || !supaKey) {
      body.innerHTML = '<div class="analytics-empty">Add your Supabase URL and Service Key in Settings to enable analytics.</div>';
      return;
    }

    body.innerHTML = '<div class="analytics-loading"><span class="spinner"></span> Loading...</div>';

    try {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const yest = new Date(now); yest.setDate(now.getDate() - 1);
      const yesterdayStr = yest.toISOString().slice(0, 10);
      const dow = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekStr = mon.toISOString().slice(0, 10);
      const lastMon = new Date(mon); lastMon.setDate(mon.getDate() - 7);
      const lastWeekStr = lastMon.toISOString().slice(0, 10);

      const range = analyticsRange;
      const pvDays = Math.max(14, range);

      // 4 efficient parallel queries (includes sales)
      const [pageViews, itemEvents, sessionEnds, salesResp] = await Promise.all([
        supaSelect(`select=session_id,created_at,referrer,utm_source,ua_mobile&event=eq.page_view&created_at=gte.${daysAgoStr(pvDays)}&order=created_at.asc&limit=50000`),
        supaSelect(`select=item_id,event&event=in.(item_view,inquire)&created_at=gte.${daysAgoStr(range)}&item_id=not.is.null&limit=50000`),
        supaSelect(`select=duration,created_at&event=eq.session_end&created_at=gte.${daysAgoStr(range)}&duration=not.is.null&limit=50000`),
        fetch(`${WORKER_URL}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).catch(() => ({ sales: [] }))
      ]);
      const allSales = salesResp.sales || [];

      // Pre-process timestamps
      pageViews.forEach(r => { r._ts = new Date(r.created_at).getTime(); });

      const msOf = s => new Date(s + 'T00:00:00Z').getTime();
      const todayMs = msOf(todayStr), yesterdayMs = msOf(yesterdayStr);
      const weekMs = msOf(weekStr), lastWeekMs = msOf(lastWeekStr);
      const rangeMs = range === 1 ? todayMs : new Date(daysAgoStr(range)).getTime();

      const pvBetween = (s, e) => pageViews.filter(r => r._ts >= s && (!e || r._ts < e));

      const todayPV = pvBetween(todayMs);
      const yesterdayPV = pvBetween(yesterdayMs, todayMs);
      const weekPV = pvBetween(weekMs);
      const lastWeekPV = pvBetween(lastWeekMs, weekMs);
      const rangePV = pvBetween(rangeMs);

      // Summary cards — responsive to range
      const rangeViews = rangePV.length;
      const rangeUniques = new Set(rangePV.map(r => r.session_id)).size;

      // Compare to previous period of same length
      const prevRangeMs = new Date(daysAgoStr(range * 2)).getTime();
      const prevRangePV = pageViews.filter(r => r._ts >= prevRangeMs && r._ts < rangeMs);
      const rangeDelta = pctChange(rangeViews, prevRangePV.length);

      // Also keep today stats for the secondary card
      const todayViews = todayPV.length;
      const todayUniques = new Set(todayPV.map(r => r.session_id)).size;
      const todayDelta = pctChange(todayViews, yesterdayPV.length);

      // Avg time on site
      const rangeSE = sessionEnds.filter(r => new Date(r.created_at).getTime() >= rangeMs);
      const durations = rangeSE.map(r => r.duration).filter(d => d > 0 && d < 3600);
      const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
      const fmtDur = (s) => s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';

      // Range label
      const rangeLabels = { 1: 'Today', 7: 'This Week', 30: 'This Month', 90: 'Last 90 Days' };
      const rangeLabel = rangeLabels[range] || range + 'd';

      // Sparkline — adapt to range
      const sparkCount = range === 1 ? 24 : Math.min(range, 14);
      const sparkDays = [];
      if (range === 1) {
        // Hourly breakdown for 1d
        for (let i = 23; i >= 0; i--) {
          const h = new Date(now); h.setHours(now.getHours() - i, 0, 0, 0);
          const s = h.getTime(), e = s + 3600000;
          sparkDays.push({
            day: h.getHours() % 6 === 0 ? h.toLocaleTimeString('en', { hour: 'numeric', hour12: true }).replace(' ', '') : '',
            count: pageViews.filter(r => r._ts >= s && r._ts < e).length,
            isToday: i === 0
          });
        }
      } else {
        for (let i = sparkCount - 1; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          const ds = d.toISOString().slice(0, 10);
          const s = msOf(ds), e = s + 86400000;
          sparkDays.push({
            day: d.toLocaleDateString('en', { weekday: 'narrow' }),
            count: pageViews.filter(r => r._ts >= s && r._ts < e).length,
            isToday: i === 0
          });
        }
      }
      const sparkMax = Math.max(1, ...sparkDays.map(d => d.count));

      // Conversion funnel
      const funnelVisitors = new Set(rangePV.map(r => r.session_id)).size;
      const funnelViews = itemEvents.filter(r => r.event === 'item_view').length;
      const funnelInquiries = itemEvents.filter(r => r.event === 'inquire').length;
      const fvMax = Math.max(1, funnelVisitors);

      // Top items
      const ivCounts = {}, iqCounts = {};
      itemEvents.forEach(r => {
        if (r.event === 'item_view') ivCounts[r.item_id] = (ivCounts[r.item_id] || 0) + 1;
        if (r.event === 'inquire') iqCounts[r.item_id] = (iqCounts[r.item_id] || 0) + 1;
      });
      const topList = Object.entries(ivCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([id, v]) => ({ id, views: v, inq: iqCounts[id] || 0, item: items.find(i => i.id === id) }));

      // Category popularity
      const catCounts = {};
      itemEvents.filter(r => r.event === 'item_view').forEach(r => {
        const it = items.find(i => i.id === r.item_id);
        if (it && it.category) {
          const lbl = catLabels[it.category] || it.category;
          catCounts[lbl] = (catCounts[lbl] || 0) + 1;
        }
      });
      const totalCat = Object.values(catCounts).reduce((a, b) => a + b, 0) || 1;
      const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

      // Traffic sources
      const sources = {};
      rangePV.forEach(r => {
        let src = 'Direct';
        if (r.utm_source) {
          src = r.utm_source.charAt(0).toUpperCase() + r.utm_source.slice(1);
        } else if (r.referrer) {
          try {
            const h = new URL(r.referrer).hostname.replace('www.', '');
            src = h.split('.')[0].charAt(0).toUpperCase() + h.split('.')[0].slice(1);
          } catch { src = 'Other'; }
        }
        sources[src] = (sources[src] || 0) + 1;
      });
      const totalSrc = rangePV.length || 1;
      const sortedSrc = Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Devices
      const mob = rangePV.filter(r => r.ua_mobile).length;
      const desk = rangePV.length - mob;
      const totalDev = rangePV.length || 1;

      const rl = range + 'd';
      const sparkLabel = range === 1 ? 'Hourly Views <span class="analytics-dim">today</span>' : `Daily Views <span class="analytics-dim">${rl}</span>`;

      // Revenue data from sales table
      const rangeSales = allSales.filter(s => new Date(s.created_at).getTime() >= rangeMs);
      const rangeRevenue = rangeSales.reduce((sum, s) => sum + Number(s.amount), 0);
      const rangeGiftCerts = rangeSales.filter(s => s.type === 'gift_certificate');
      const rangeGiftRevenue = rangeGiftCerts.reduce((sum, s) => sum + Number(s.amount), 0);
      const fmtMoney = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      // --- Render ---
      body.innerHTML = `
        <div class="analytics-cards">
          <div class="analytics-card">
            <div class="analytics-card-label">${rangeLabel}</div>
            <div class="analytics-card-value">${rangeViews}</div>
            <div class="analytics-card-sub">${rangeUniques} unique${rangeUniques !== 1 ? 's' : ''}</div>
            <div class="analytics-card-change change-${rangeDelta.c}">${rangeDelta.t}</div>
          </div>
          <div class="analytics-card">
            <div class="analytics-card-label">Avg. Time</div>
            <div class="analytics-card-value">${avgDuration ? fmtDur(avgDuration) : '—'}</div>
            <div class="analytics-card-sub">${durations.length} session${durations.length !== 1 ? 's' : ''}</div>
          </div>
          ${range !== 1 ? `
          <div class="analytics-card">
            <div class="analytics-card-label">Today</div>
            <div class="analytics-card-value">${todayViews}</div>
            <div class="analytics-card-sub">${todayUniques} unique${todayUniques !== 1 ? 's' : ''}</div>
            <div class="analytics-card-change change-${todayDelta.c}">${todayDelta.t}</div>
          </div>
          ` : ''}
        </div>

        <div class="analytics-cards">
          <div class="analytics-card">
            <div class="analytics-card-label">Revenue ${rangeLabel}</div>
            <div class="analytics-card-value">${fmtMoney(rangeRevenue)}</div>
            <div class="analytics-card-sub">${rangeSales.length} sale${rangeSales.length !== 1 ? 's' : ''}${rangeGiftCerts.length > 0 ? ' (' + rangeGiftCerts.length + ' gift cert' + (rangeGiftCerts.length !== 1 ? 's' : '') + ')' : ''}</div>
          </div>
        </div>

        <div class="analytics-section">
          <div class="analytics-section-title">${sparkLabel}</div>
          <div class="sparkline">
            ${sparkDays.map(d => `
              <div class="sparkline-col">
                <div class="sparkline-bar${d.isToday ? ' today' : ''}" style="height:${Math.max(4, Math.round(d.count / sparkMax * 100))}%"></div>
                <span class="sparkline-day">${d.day}</span>
              </div>
            `).join('')}
          </div>
        </div>

        ${funnelVisitors > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Conversion Funnel <span class="analytics-dim">${rl}</span></div>
          <div class="funnel">
            <div class="funnel-row">
              <div class="funnel-bar" style="width:100%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelVisitors}</span> visitors</span>
            </div>
            <div class="funnel-row">
              <div class="funnel-bar" style="width:${Math.max(3, Math.round(funnelViews / fvMax * 100))}%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelViews}</span> item views <span class="funnel-pct">${Math.round(funnelViews / fvMax * 100)}%</span></span>
            </div>
            <div class="funnel-row">
              <div class="funnel-bar funnel-accent" style="width:${Math.max(3, Math.round(funnelInquiries / fvMax * 100))}%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelInquiries}</span> inquiries <span class="funnel-pct">${funnelVisitors > 0 ? Math.round(funnelInquiries / funnelVisitors * 100) : 0}%</span></span>
            </div>
          </div>
        </div>
        ` : ''}

        <div class="analytics-card analytics-card-full">
          <div class="analytics-card-label">Inquiries</div>
          <div class="analytics-card-value">${funnelInquiries}</div>
          <div class="analytics-card-sub">last ${rl}</div>
        </div>

        ${topList.length > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Most Viewed <span class="analytics-dim">${rl}</span></div>
          ${topList.map(t => {
            const thumb = t.item ? (t.item.heroImage || (t.item.images && t.item.images[0]) || '') : '';
            const imgHtml = thumb ? `<img src="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${thumb}" alt="">` : '';
            const title = t.item ? esc(t.item.title || 'Untitled') : formatId(t.id);
            return `
              <div class="analytics-item">
                <div class="item-thumb">${imgHtml}</div>
                <div class="analytics-item-info">
                  <div class="analytics-item-title">${title}</div>
                  <div class="analytics-item-stats">${t.views} view${t.views !== 1 ? 's' : ''}${t.inq > 0 ? ` \u00b7 ${t.inq} inq` : ''}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ` : ''}

        ${sortedCats.length > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Popular Categories <span class="analytics-dim">${rl}</span></div>
          ${sortedCats.map(([cat, count]) => `
            <div class="analytics-bar-row">
              <span class="analytics-bar-label">${esc(cat)}</span>
              <div class="analytics-bar-track">
                <div class="analytics-bar-fill" style="width:${Math.round(count / totalCat * 100)}%"></div>
              </div>
              <span class="analytics-bar-pct">${Math.round(count / totalCat * 100)}%</span>
            </div>
          `).join('')}
        </div>
        ` : ''}

        <div class="analytics-section">
          <div class="analytics-section-title">Traffic Sources <span class="analytics-dim">${rl}</span></div>
          ${sortedSrc.length > 0 ? sortedSrc.map(([src, count]) => `
            <div class="analytics-bar-row">
              <span class="analytics-bar-label">${esc(src)}</span>
              <div class="analytics-bar-track">
                <div class="analytics-bar-fill" style="width:${Math.round(count / totalSrc * 100)}%"></div>
              </div>
              <span class="analytics-bar-pct">${Math.round(count / totalSrc * 100)}%</span>
            </div>
          `).join('') : '<div class="analytics-empty-small">No data yet</div>'}
        </div>

        <div class="analytics-section">
          <div class="analytics-section-title">Devices <span class="analytics-dim">${rl}</span></div>
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">Mobile</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round(mob / totalDev * 100)}%"></div>
            </div>
            <span class="analytics-bar-pct">${Math.round(mob / totalDev * 100)}%</span>
          </div>
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">Desktop</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round(desk / totalDev * 100)}%"></div>
            </div>
            <span class="analytics-bar-pct">${Math.round(desk / totalDev * 100)}%</span>
          </div>
        </div>

      `;
    } catch (e) {
      body.innerHTML = `<div class="analytics-empty">Error loading analytics: ${esc(e.message)}</div>`;
    }
  }

  // --- Utils ---

  function nextId() {
    let max = 0;
    for (const item of items) {
      const n = parseInt(item.id, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1).padStart(6, '0');
  }

  function formatId(id) {
    const n = parseInt(id, 10);
    return !isNaN(n) ? 'A' + String(n).padStart(6, '0') : 'A' + id;
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  // Convert data URL to lightweight blob URL for display (avoids MB of base64 in DOM)
  function toBlobUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    try {
      const parts = dataUrl.split(',');
      const mime = parts[0].match(/:(.*?);/)[1];
      const binary = atob(parts[1]);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([array], { type: mime }));
    } catch {
      return null;
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2200);
  }

  // --- Marketing ---

  document.getElementById('btn-marketing-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  document.getElementById('btn-giftcerts-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  async function loadMarketing() {
    if (!supaUrl || !supaKey) {
      document.getElementById('email-empty').style.display = '';
      document.getElementById('dc-empty').style.display = '';
      return;
    }
    loadEmails();
    loadDiscountCodes();
  }

  async function loadEmails() {
    try {
      const res = await fetch(`${supaUrl}/rest/v1/emails?select=email,source,discount_code,created_at&order=created_at.desc&limit=500`, {
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
      });
      const emails = await res.json();
      const tbody = document.getElementById('email-tbody');
      const countEl = document.getElementById('email-count');
      const emptyEl = document.getElementById('email-empty');
      const tableWrap = document.getElementById('email-table-wrap');

      if (!emails.length) {
        emptyEl.style.display = '';
        tableWrap.style.display = 'none';
        countEl.textContent = '';
        return;
      }

      emptyEl.style.display = 'none';
      tableWrap.style.display = '';
      countEl.textContent = `${emails.length} subscriber${emails.length !== 1 ? 's' : ''}`;

      tbody.innerHTML = emails.map(e => {
        const date = new Date(e.created_at).toLocaleDateString();
        return `<tr><td>${esc(e.email)}</td><td>${esc(e.source)}</td><td>${date}</td></tr>`;
      }).join('');

      // CSV export
      document.getElementById('btn-export-csv').onclick = () => {
        const rows = [['Email', 'Source', 'Discount Code', 'Date']];
        emails.forEach(e => {
          rows.push([e.email, e.source, e.discount_code || '', new Date(e.created_at).toLocaleDateString()]);
        });
        const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ol-emails-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
      };
    } catch (e) {
      document.getElementById('email-empty').style.display = '';
      document.getElementById('email-empty').textContent = 'Failed to load emails.';
    }
  }

  async function loadDiscountCodes() {
    try {
      const res = await fetch(`${supaUrl}/rest/v1/discount_codes?select=id,code,type,value,is_active,max_uses,used_count,created_at&is_gift_certificate=is.false&order=created_at.desc`, {
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
      });
      const codes = await res.json();
      const listEl = document.getElementById('dc-list');
      const emptyEl = document.getElementById('dc-empty');

      if (!codes.length) {
        emptyEl.style.display = '';
        listEl.innerHTML = '';
        return;
      }

      emptyEl.style.display = 'none';
      listEl.innerHTML = codes.map(dc => {
        const discountLabel = dc.type === 'percent' ? `${dc.value}% off` : `$${dc.value} off`;
        const usesLabel = dc.max_uses ? `${dc.used_count}/${dc.max_uses} uses` : `${dc.used_count} uses`;
        return `
          <div class="dc-row">
            <span class="dc-code">${esc(dc.code)}</span>
            <span class="dc-info">${discountLabel} &middot; ${usesLabel}</span>
            <button class="dc-toggle ${dc.is_active ? 'active' : ''}" data-id="${dc.id}" data-active="${dc.is_active}"></button>
          </div>`;
      }).join('');

      // Toggle active/inactive
      listEl.querySelectorAll('.dc-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const newActive = btn.dataset.active !== 'true';
          btn.disabled = true;
          try {
            await fetch(`${supaUrl}/rest/v1/discount_codes?id=eq.${id}`, {
              method: 'PATCH',
              headers: {
                'apikey': supaKey,
                'Authorization': 'Bearer ' + supaKey,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ is_active: newActive })
            });
            btn.dataset.active = String(newActive);
            btn.classList.toggle('active', newActive);
          } catch {
            toast('Failed to update');
          }
          btn.disabled = false;
        });
      });
    } catch {
      document.getElementById('dc-empty').style.display = '';
      document.getElementById('dc-empty').textContent = 'Failed to load codes.';
    }
  }

  // Create discount code
  document.getElementById('dc-random').addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('dc-code').value = code;
  });

  document.getElementById('dc-create').addEventListener('click', async () => {
    const code = document.getElementById('dc-code').value.trim().toUpperCase();
    const type = document.getElementById('dc-type').value;
    const value = parseFloat(document.getElementById('dc-value').value);
    const maxUses = document.getElementById('dc-max').value ? parseInt(document.getElementById('dc-max').value) : null;

    if (!code || !value || value <= 0) { toast('Code and value required'); return; }
    if (!supaUrl || !supaKey) { toast('Supabase not configured'); return; }

    const btn = document.getElementById('dc-create');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const res = await fetch(`${supaUrl}/rest/v1/discount_codes`, {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': 'Bearer ' + supaKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ code, type, value, max_uses: maxUses })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Create failed');
      }

      toast('Code created');
      document.getElementById('dc-code').value = '';
      document.getElementById('dc-value').value = '';
      document.getElementById('dc-max').value = '';
      loadDiscountCodes();
    } catch (e) {
      toast(e.message || 'Failed to create code');
    }

    btn.disabled = false;
    btn.textContent = 'Create Code';
  });

  // --- Gift Certificates ---
  async function loadGiftCertificates() {
    try {
      const res = await fetch(`${supaUrl}/rest/v1/discount_codes?select=id,code,type,value,is_active,max_uses,used_count,purchaser_name,recipient_name,purchaser_email,created_at&is_gift_certificate=is.true&order=created_at.desc`, {
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
      });
      const certs = await res.json();
      const listEl = document.getElementById('gc-list');
      const emptyEl = document.getElementById('gc-empty');

      if (!certs.length) {
        emptyEl.style.display = '';
        listEl.innerHTML = '';
        return;
      }

      emptyEl.style.display = 'none';
      listEl.innerHTML = certs.map(gc => {
        const redeemed = gc.used_count >= (gc.max_uses || 1);
        const status = !gc.is_active ? 'Voided' : redeemed ? 'Redeemed' : 'Active';
        const statusClass = !gc.is_active ? 'gc-voided' : redeemed ? 'gc-redeemed' : 'gc-active';
        const names = [gc.purchaser_name, gc.recipient_name].filter(Boolean);
        const nameLabel = names.length ? names.join(' → ') : '';
        const date = new Date(gc.created_at).toLocaleDateString();
        return `
          <div class="dc-row">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px">
                <span class="dc-code">${esc(gc.code)}</span>
                <span class="gc-status ${statusClass}">${status}</span>
              </div>
              <div class="dc-info">$${gc.value}${nameLabel ? ' · ' + esc(nameLabel) : ''}${gc.purchaser_email ? ' · ' + esc(gc.purchaser_email) : ''} · ${date}</div>
            </div>
            ${gc.is_active && !redeemed ? `<button class="btn-small gc-void" data-id="${gc.id}">Void</button>` : ''}
          </div>`;
      }).join('');

      listEl.querySelectorAll('.gc-void').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await fetch(`${supaUrl}/rest/v1/discount_codes?id=eq.${btn.dataset.id}`, {
              method: 'PATCH',
              headers: {
                'apikey': supaKey,
                'Authorization': 'Bearer ' + supaKey,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ is_active: false })
            });
            loadGiftCertificates();
          } catch {
            toast('Failed to void');
            btn.disabled = false;
          }
        });
      });
    } catch {
      document.getElementById('gc-empty').style.display = '';
      document.getElementById('gc-empty').textContent = 'Failed to load gift certificates.';
    }
  }

  document.getElementById('gc-create-btn').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('gc-amount').value);
    const purchaser = document.getElementById('gc-purchaser').value.trim();
    const recipient = document.getElementById('gc-recipient').value.trim();
    const email = document.getElementById('gc-email').value.trim();

    if (!amount || amount <= 0) { toast('Amount required'); return; }
    if (!supaUrl || !supaKey) { toast('Supabase not configured'); return; }

    // Generate GIFT-XXXX-XXXX code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'GIFT-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    code += '-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];

    const btn = document.getElementById('gc-create-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const body = {
        code,
        type: 'fixed',
        value: amount,
        max_uses: 1,
        is_gift_certificate: true
      };
      if (purchaser) body.purchaser_name = purchaser;
      if (recipient) body.recipient_name = recipient;
      if (email) body.purchaser_email = email;

      const res = await fetch(`${supaUrl}/rest/v1/discount_codes`, {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': 'Bearer ' + supaKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Create failed');
      }

      // Send email with gift code if email provided
      if (email) {
        try {
          await fetch('https://h760-checkout.harker760.workers.dev/send-gift-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, amount, email, purchaserName: purchaser, recipientName: recipient })
          });
          toast(`Gift certificate created & emailed: ${code}`);
        } catch {
          toast(`Gift certificate created: ${code} (email failed)`);
        }
      } else {
        toast(`Gift certificate created: ${code}`);
      }

      document.getElementById('gc-amount').value = '';
      document.getElementById('gc-purchaser').value = '';
      document.getElementById('gc-recipient').value = '';
      document.getElementById('gc-email').value = '';
      loadGiftCertificates();
    } catch (e) {
      toast(e.message || 'Failed to create gift certificate');
    }

    btn.disabled = false;
    btn.textContent = 'Create Gift Certificate';
  });

  function confirm(msg, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <p>${esc(msg)}</p>
        <div class="dialog-actions">
          <button class="dialog-cancel">Cancel</button>
          <button class="dialog-confirm">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => {
      overlay.remove();
      onConfirm();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ─── Sales View ─────────────────────────────────────────────────

  async function loadSales() {
    const body = document.getElementById('sales-body');
    const loading = document.getElementById('sales-loading');
    loading.style.display = '';

    try {
      const resp = await fetch(`${WORKER_URL}/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to load sales');

      const sales = data.sales || [];
      loading.style.display = 'none';

      // Summary stats
      const totalRevenue = sales.reduce((s, r) => s + Number(r.amount), 0);
      const itemSales = sales.filter(r => r.type === 'item');
      const giftSales = sales.filter(r => r.type === 'gift_certificate');
      const itemRevenue = itemSales.reduce((s, r) => s + Number(r.amount), 0);
      const giftRevenue = giftSales.reduce((s, r) => s + Number(r.amount), 0);

      // Today's sales
      const today = new Date().toISOString().slice(0, 10);
      const todaySales = sales.filter(r => r.created_at.slice(0, 10) === today);
      const todayRevenue = todaySales.reduce((s, r) => s + Number(r.amount), 0);

      // This month's sales
      const thisMonth = new Date().toISOString().slice(0, 7);
      const monthSales = sales.filter(r => r.created_at.slice(0, 7) === thisMonth);
      const monthRevenue = monthSales.reduce((s, r) => s + Number(r.amount), 0);

      let html = `
        <section class="marketing-section">
          <div class="sales-summary">
            <div class="sales-stat">
              <div class="sales-stat-value">$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              <div class="sales-stat-label">All Time</div>
            </div>
            <div class="sales-stat">
              <div class="sales-stat-value">$${monthRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              <div class="sales-stat-label">This Month</div>
            </div>
            <div class="sales-stat">
              <div class="sales-stat-value">$${todayRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              <div class="sales-stat-label">Today</div>
            </div>
          </div>
          <div class="sales-meta">
            ${sales.length} total transactions &middot; ${itemSales.length} items ($${itemRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}) &middot; ${giftSales.length} gift certs ($${giftRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })})
          </div>
        </section>
        <section class="marketing-section">
          <h2 class="marketing-section-title">Transaction History</h2>
          <div class="sales-list">`;

      if (sales.length === 0) {
        html += '<p class="marketing-empty">No sales recorded yet.</p>';
      } else {
        for (const sale of sales) {
          const date = new Date(sale.created_at);
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const amount = Number(sale.amount).toLocaleString('en-US', { minimumFractionDigits: 2 });
          const isGift = sale.type === 'gift_certificate';
          const typeLabel = isGift ? 'Gift Cert' : 'Item';
          const typeCls = isGift ? 'sale-type-gift' : 'sale-type-item';

          // Title: use item_title, fall back to note parsing, or generic
          let title = sale.item_title || '';
          if (!title && sale.note) {
            title = sale.note.replace('Harker760 | ', '').replace(/\s*\([^)]*\)$/, '');
          }
          if (!title) title = isGift ? `Gift Certificate` : 'In-store sale';

          // Customer info
          const customerName = sale.customer_name || '';
          const customer = sale.customer_email || '';
          const giftCode = sale.gift_code ? `Code: ${sale.gift_code}` : '';
          const discount = sale.discount_code ? `Discount: ${sale.discount_code}` : '';

          html += `
            <div class="sale-row">
              <div class="sale-row-left">
                <span class="sale-type ${typeCls}">${typeLabel}</span>
                <div class="sale-info">
                  <div class="sale-title">${title}</div>
                  ${customerName ? `<div class="sale-customer">${customerName}</div>` : ''}
                  <div class="sale-detail">${dateStr} ${timeStr}${customer ? ' &middot; ' + customer : ''}${sale.posted_by ? ' &middot; Posted by ' + sale.posted_by : ''}${giftCode ? ' &middot; ' + giftCode : ''}${discount ? ' &middot; ' + discount : ''}</div>
                </div>
              </div>
              <div class="sale-amount">$${amount}</div>
            </div>`;
        }
      }

      html += '</div></section>';
      body.innerHTML = html;
    } catch (e) {
      loading.style.display = 'none';
      body.innerHTML = `<div class="analytics-empty">Error loading sales: ${e.message}</div>`;
    }
  }

})();
