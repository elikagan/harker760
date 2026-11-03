const OWNER = 'elikagan';
const REPO = 'harker760';
const SITE = 'https://harker760.com';
const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-12-18';
const SESSION_DAYS = 30;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECS = 300;

const ADMIN_DB_TABLES = {
  events: ['GET'],
  emails: ['GET'],
  discount_codes: ['GET', 'POST', 'PATCH']
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    if (m === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (p === '/checkout' && m === 'POST') return handleCheckout(request, env);
    if (p === '/gift-checkout' && m === 'POST') return handleGiftCheckout(request, env);
    if (p === '/discount' && m === 'POST') return handleDiscountLookup(request, env);
    if (p === '/webhook' && m === 'POST') return handleWebhook(request, env);

    if (p.startsWith('/img/') && (m === 'GET' || m === 'HEAD')) return handleImageProxy(request, url);

    if (p === '/admin/login' && m === 'POST') return handleAdminLogin(request, env);

    const adminRoutes = {
      '/admin/github': handleAdminGitHub,
      '/admin/gemini': handleAdminGemini,
      '/sales': handleSales,
      '/sales-backfill': handleSalesBackfill,
      '/sales-backfill-names': handleSalesBackfillNames,
      '/send-gift-email': handleSendGiftEmail,
      '/admin/webhook-test': handleWebhookTest
    };
    const isAdminDb = p.startsWith('/admin/db/');
    if (adminRoutes[p] || isAdminDb) {
      if (!(await isAdmin(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
      if (isAdminDb) return handleAdminDb(request, env, url);
      if (m !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, request);
      return adminRoutes[p](request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = ['https://harker760.com', 'https://www.harker760.com', 'https://elikagan.github.io'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Admin auth ───────────────────────────────────────────────────

const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return false;
  const exp = parseInt(payload, 36);
  return Number.isFinite(exp) && Date.now() < exp;
}

function loginCacheKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return new Request(`https://login-attempts.internal/${encodeURIComponent(ip)}`);
}

async function handleAdminLogin(request, env) {
  if (!env.ADMIN_PIN_HASH || !env.SESSION_SECRET) {
    return jsonResponse({ error: 'Admin login not configured' }, 500, request);
  }
  const cache = caches.default;
  const key = loginCacheKey(request);
  const prev = await cache.match(key);
  const attempts = prev ? parseInt(await prev.text(), 10) || 0 : 0;
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    return jsonResponse({ error: 'Too many attempts. Try again in 5 minutes.' }, 429, request);
  }

  let pin = '';
  try { pin = String((await request.json()).pin || ''); } catch {}
  if (pin && safeEqual(await sha256Hex(pin), env.ADMIN_PIN_HASH.toLowerCase())) {
    await cache.delete(key);
    const payload = (Date.now() + SESSION_DAYS * 86400000).toString(36);
    return jsonResponse({ token: `${payload}.${await hmac(env.SESSION_SECRET, payload)}` }, 200, request);
  }

  await cache.put(key, new Response(String(attempts + 1), {
    headers: { 'Cache-Control': `max-age=${LOGIN_LOCKOUT_SECS}` }
  }));
  const left = LOGIN_MAX_ATTEMPTS - attempts - 1;
  return jsonResponse({ error: left > 0 ? `Wrong PIN (${left} left)` : 'Too many attempts. Try again in 5 minutes.' }, 401, request);
}

// ─── Supabase helpers (server key stays in the worker) ────────────

function supa(env, path, init = {}) {
  // Until the service key is installed, fall back to the anon key the live site already uses.
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error('Supabase not configured');
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function findDiscount(env, code) {
  if (typeof code !== 'string' || !/^[A-Z0-9-]{2,40}$/.test(code)) return null;
  const res = await supa(env, `discount_codes?code=eq.${encodeURIComponent(code)}&is_active=eq.true&select=id,code,type,value,max_uses,used_count`);
  if (!res.ok) return null;
  const rows = await res.json();
  const dc = rows[0];
  if (!dc) return null;
  if (dc.max_uses && dc.used_count >= dc.max_uses) return null;
  return dc;
}

async function handleDiscountLookup(request, env) {
  try {
    const { code } = await request.json();
    const dc = await findDiscount(env, String(code || '').trim().toUpperCase());
    if (!dc) return jsonResponse({ error: 'Invalid code' }, 404, request);
    return jsonResponse({ code: dc.code, type: dc.type, value: Number(dc.value) }, 200, request);
  } catch (e) {
    console.error('Discount lookup error:', e.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

// ─── Inventory (read fresh from GitHub, never trust the browser) ──

async function fetchInventory(env) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/inventory.json?ref=main`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.raw+json',
      'User-Agent': 'h760-checkout-worker'
    }
  });
  if (!res.ok) throw new Error(`Inventory fetch failed: ${res.status}`);
  return res.json();
}

// ─── Checkout ─────────────────────────────────────────────────────

async function createPaymentLink(env, body) {
  const res = await fetch(`${SQUARE_API}/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ idempotency_key: crypto.randomUUID(), ...body })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Square error:', JSON.stringify(data.errors));
    throw new Error(data.errors?.[0]?.detail || 'Checkout failed');
  }
  const checkoutUrl = data.payment_link?.url || '';
  if (!checkoutUrl.startsWith('https://square.link/') && !checkoutUrl.startsWith('https://checkout.square.site/')) {
    console.error('Unexpected checkout URL:', checkoutUrl);
    throw new Error('Checkout failed');
  }
  return checkoutUrl;
}

async function handleCheckout(request, env) {
  try {
    const { itemId, discountCode } = await request.json();
    if (typeof itemId !== 'string' || !/^\d{1,8}$/.test(itemId)) {
      return jsonResponse({ error: 'Invalid item ID' }, 400, request);
    }

    const items = await fetchInventory(env);
    const item = items.find(i => i.id === itemId);
    const price = Number(item?.price);
    if (!item || item.isSold || item.isHold || !(price > 0) || price > 100000) {
      return jsonResponse({ error: 'This item is not available for purchase.' }, 400, request);
    }
    const title = String(item.title || 'Item').slice(0, 200);

    let discount = null;
    if (discountCode) {
      try { discount = await findDiscount(env, String(discountCode).trim().toUpperCase()); }
      catch (e) { console.error('Discount validation failed:', e.message); }
    }

    const order = {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{
        name: title,
        quantity: '1',
        base_price_money: { amount: Math.round(price * 100), currency: 'USD' }
      }],
      taxes: [{ uid: 'ca-sales-tax', name: 'CA Sales Tax', percentage: '10.25', scope: 'ORDER' }],
      metadata: { item_id: itemId }
    };

    if (discount) {
      order.discounts = [discount.type === 'percent'
        ? { uid: 'promo', name: `Discount (${discount.code})`, percentage: String(discount.value), scope: 'ORDER' }
        : { uid: 'promo', name: `Discount (${discount.code})`, amount_money: { amount: Math.round(Number(discount.value) * 100), currency: 'USD' }, scope: 'ORDER' }];
      order.metadata.discount_code = discount.code;
    }

    const checkoutUrl = await createPaymentLink(env, {
      order,
      checkout_options: {
        redirect_url: `${SITE}/?purchased=1#${itemId}`,
        ask_for_shipping_address: true
      },
      payment_note: `Harker760 | ${title} (${itemId})`
    });
    return jsonResponse({ url: checkoutUrl }, 200, request);
  } catch (err) {
    console.error('Checkout error:', err.message);
    return jsonResponse({ error: 'Checkout unavailable. Please inquire directly.' }, 500, request);
  }
}

function newGiftCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const pick = i => chars[bytes[i] % chars.length];
  return `GIFT-${pick(0)}${pick(1)}${pick(2)}${pick(3)}-${pick(4)}${pick(5)}${pick(6)}${pick(7)}`;
}

async function handleGiftCheckout(request, env) {
  try {
    const { amount, email, purchaserName, recipientName } = await request.json();
    if (typeof amount !== 'number' || !(amount > 0) || amount > 10000) {
      return jsonResponse({ error: 'Invalid amount' }, 400, request);
    }
    const dollars = Math.round(amount * 100) / 100;
    const code = newGiftCode();

    // The code only becomes valid when the webhook sees a completed payment.
    const metadata = { gift_code: code };
    if (typeof purchaserName === 'string' && purchaserName.trim()) metadata.purchaser_name = purchaserName.trim().slice(0, 100);
    if (typeof recipientName === 'string' && recipientName.trim()) metadata.recipient_name = recipientName.trim().slice(0, 100);

    const checkoutUrl = await createPaymentLink(env, {
      order: {
        location_id: env.SQUARE_LOCATION_ID,
        line_items: [{
          name: `Gift Certificate - $${dollars}`,
          quantity: '1',
          base_price_money: { amount: Math.round(dollars * 100), currency: 'USD' }
        }],
        metadata
      },
      checkout_options: {
        redirect_url: `${SITE}/gift/?purchased=1&code=${encodeURIComponent(code)}`,
        ask_for_shipping_address: false
      },
      ...(typeof email === 'string' && email.includes('@') ? { pre_populated_data: { buyer_email: email } } : {}),
      payment_note: `Harker760 | Gift Certificate (${code})`
    });
    return jsonResponse({ url: checkoutUrl }, 200, request);
  } catch (err) {
    console.error('Gift checkout error:', err.message);
    return jsonResponse({ error: 'Unable to process. Please try again.' }, 500, request);
  }
}

// ─── Gift certificate email ───────────────────────────────────────

function giftEmailHtml({ code, amount, purchaserName, recipientName }) {
  const toLine = recipientName ? `<p style="color:#888;font-size:14px;">To: ${escHtml(recipientName)}</p>` : '';
  const fromLine = purchaserName ? `<p style="color:#888;font-size:14px;">From: ${escHtml(purchaserName)}</p>` : '';
  return `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
      <h1 style="font-size:20px;font-weight:500;margin-bottom:24px;">Gift Certificate</h1>
      ${toLine}${fromLine}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-bottom:24px;">
        Here's your Harker760 gift certificate. Give this code to the recipient to use at checkout.
      </p>
      <div style="text-align:center;padding:24px;border:2px solid #1a1a1a;border-radius:12px;margin-bottom:24px;">
        <div style="font-size:14px;color:#888;margin-bottom:8px;">GIFT CERTIFICATE CODE</div>
        <div style="font-size:28px;font-weight:600;letter-spacing:0.06em;">${escHtml(code)}</div>
        <div style="font-size:16px;color:#888;margin-top:8px;">$${escHtml(amount)}</div>
      </div>
      <p style="font-size:14px;color:#888;line-height:1.6;">
        This code can be used at checkout on <a href="${SITE}" style="color:#1a1a1a;">harker760.com</a> or in-store at Harker760 in Pasadena. It does not expire.
      </p>
      <hr style="border:none;border-top:1px solid #ddd;margin:32px 0;">
      <p style="font-size:12px;color:#aaa;">Harker760<br>Pasadena, CA</p>
    </div>`;
}

async function sendGiftEmail(env, { code, amount, email, purchaserName, recipientName }) {
  if (!env.RESEND_API_KEY) throw new Error('Email not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.GIFT_FROM_EMAIL || 'Harker760 <onboarding@resend.dev>',
      to: [email],
      subject: `Your Harker760 Gift Certificate - $${amount}`,
      html: giftEmailHtml({ code, amount, purchaserName, recipientName })
    })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function handleSendGiftEmail(request, env) {
  try {
    const { code, amount, email, purchaserName, recipientName } = await request.json();
    if (!code || !amount || !email) {
      return jsonResponse({ error: 'code, amount, and email required' }, 400, request);
    }
    await sendGiftEmail(env, { code, amount, email, purchaserName, recipientName });
    return jsonResponse({ success: true }, 200, request);
  } catch (err) {
    console.error('Send gift email error:', err.message);
    return jsonResponse({ error: 'Failed to send email' }, 500, request);
  }
}

// ─── Square webhook ───────────────────────────────────────────────

async function verifySquareSignature(request, body, env) {
  const sigKey = env.SQUARE_WEBHOOK_SIG || env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const signature = request.headers.get('x-square-hmacsha256-signature');
  if (!sigKey || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(sigKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const urls = [env.WEBHOOK_URL, request.url].filter(Boolean);
  for (const u of urls) {
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(u + body));
    if (safeEqual(btoa(String.fromCharCode(...new Uint8Array(sig))), signature)) return true;
  }
  return false;
}

async function fetchOrderMetadata(env, orderId) {
  if (!orderId) return {};
  const res = await fetch(`${SQUARE_API}/orders/${encodeURIComponent(orderId)}`, {
    headers: { 'Square-Version': SQUARE_VERSION, 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` }
  });
  if (!res.ok) return {};
  const data = await res.json();
  return data.order?.metadata || {};
}

async function handleWebhook(request, env) {
  const body = await request.text();
  const verified = await verifySquareSignature(request, body, env);
  if (!verified) {
    console.error('Webhook signature did not verify');
    if (env.WEBHOOK_ENFORCE === '1') return new Response('Invalid signature', { status: 401 });
  }

  try {
    const event = JSON.parse(body);
    const payment = event.type === 'payment.updated' ? event.data?.object?.payment : null;
    if (!payment || payment.status !== 'COMPLETED') return new Response('OK', { status: 200 });

    const note = payment.note || '';
    const buyerEmail = payment.buyer_email_address || null;
    const isWebsiteSale = note.startsWith('Harker760 |');
    const amount = (payment.amount_money?.amount || 0) / 100;
    const itemInfo = note.replace('Harker760 | ', '');
    const idMatch = isWebsiteSale ? note.match(/\(([^)]+)\)$/) : null;
    const refId = idMatch ? idMatch[1] : null;
    const isGiftCert = isWebsiteSale && note.includes('Gift Certificate');

    if (buyerEmail) {
      try {
        await supa(env, 'emails', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify({ email: buyerEmail, source: 'purchase', item_id: isGiftCert ? null : refId })
        });
      } catch (e) {
        console.error('Email capture error:', e.message);
      }
    }

    if (!isWebsiteSale) return new Response('OK', { status: 200 });
    const meta = await fetchOrderMetadata(env, payment.order_id);

    if (isGiftCert && !verified) {
      console.error('Unverified gift certificate payment ignored');
    } else if (isGiftCert) {
      const code = meta.gift_code || refId;
      const giftAmount = Number(payment.amount_money?.amount || 0) / 100;
      try {
        const res = await supa(env, 'discount_codes', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify({
            code,
            type: 'fixed',
            value: giftAmount,
            max_uses: 1,
            is_active: true,
            is_gift_certificate: true,
            purchaser_name: meta.purchaser_name || null,
            recipient_name: meta.recipient_name || null,
            purchaser_email: buyerEmail
          })
        });
        if (!res.ok) console.error('Gift cert insert failed:', res.status, await res.text());
      } catch (e) {
        console.error('Gift cert insert error:', e.message);
      }
      if (buyerEmail) {
        try {
          await sendGiftEmail(env, { code, amount: giftAmount, email: buyerEmail, purchaserName: meta.purchaser_name, recipientName: meta.recipient_name });
        } catch (e) {
          console.error('Gift cert email error:', e.message);
        }
      }
    } else if (refId && env.GITHUB_TOKEN) {
      await markAsSold(env, refId);
      if (meta.discount_code && verified) {
        try { await incrementDiscountUse(env, meta.discount_code); }
        catch (e) { console.error('Discount count update failed:', e.message); }
      }
    }

    try {
      let customerName = payment.card_details?.card?.cardholder_name || null;
      if (!customerName && payment.shipping_address) {
        const addr = payment.shipping_address;
        if (addr.first_name || addr.last_name) customerName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
      }
      let postedBy = null;
      if (refId && !isGiftCert) {
        try {
          const found = (await fetchInventory(env)).find(i => i.id === refId);
          if (found?.postedBy) postedBy = found.postedBy;
        } catch (_) {}
      }
      await supa(env, 'sales', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          type: isGiftCert ? 'gift_certificate' : 'item',
          amount,
          customer_email: buyerEmail,
          customer_name: customerName,
          item_id: refId,
          item_title: isGiftCert ? `Gift Certificate - $${amount}` : (itemInfo || null),
          gift_code: isGiftCert ? (meta.gift_code || refId) : null,
          discount_code: meta.discount_code || null,
          posted_by: postedBy,
          square_payment_id: payment.id || null,
          note
        })
      });
    } catch (e) {
      console.error('Sale record error:', e.message);
    }

    // 202 tells Square's test tool the signature didn't verify while enforcement is off.
    return new Response('OK', { status: verified ? 200 : 202 });
  } catch (e) {
    console.error('Webhook error:', e.message, e.stack);
    return new Response('Error', { status: 500 });
  }
}

async function incrementDiscountUse(env, code) {
  const res = await supa(env, `discount_codes?code=eq.${encodeURIComponent(code)}&select=id,used_count`);
  const row = (await res.json())[0];
  if (!row) return;
  await supa(env, `discount_codes?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ used_count: (row.used_count || 0) + 1 })
  });
}

async function markAsSold(env, itemId, attempt = 0) {
  const ghApi = 'https://api.github.com';
  const path = 'inventory.json';
  try {
    const fileRes = await fetch(`${ghApi}/repos/${OWNER}/${REPO}/contents/${path}?ref=main`, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'h760-checkout-worker'
      }
    });
    if (!fileRes.ok) return;

    const fileData = await fileRes.json();
    const items = JSON.parse(decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, '')))));
    const item = items.find(i => i.id === itemId);
    if (!item || item.isSold) return;

    item.isSold = true;
    item.isNew = false;
    item.isHold = false;

    const putRes = await fetch(`${ghApi}/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'h760-checkout-worker'
      },
      body: JSON.stringify({
        message: `Mark ${item.title || itemId} as sold`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(items, null, 2)))),
        sha: fileData.sha,
        branch: 'main'
      })
    });

    if (putRes.status === 409 && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      return markAsSold(env, itemId, attempt + 1);
    }
    if (!putRes.ok) console.error(`[markAsSold] Failed for ${itemId}, status ${putRes.status}`);
  } catch (e) {
    // Admin reconciliation on load catches anything missed here.
    console.error(`[markAsSold] Error for ${itemId}:`, e.message);
  }
}

// ─── Sales (admin only) ───────────────────────────────────────────

async function handleSales(request, env) {
  try {
    const res = await supa(env, 'sales?select=*&order=created_at.desc&limit=500');
    const sales = await res.json();
    if (!res.ok) throw new Error(sales.message || 'Sales query failed');
    return jsonResponse({ sales, count: sales.length }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleSalesBackfill(request, env) {
  if (!env.SQUARE_ACCESS_TOKEN) return jsonResponse({ error: 'Square not configured' }, 500, request);
  try {
    const payments = [];
    let cursor = null;
    let pages = 0;
    do {
      const params = new URLSearchParams({ sort_order: 'DESC', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${SQUARE_API}/payments?${params}`, {
        headers: { 'Square-Version': SQUARE_VERSION, 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` }
      });
      const data = await res.json();
      if (!res.ok) return jsonResponse({ error: data.errors?.[0]?.detail || 'Square API error' }, 500, request);
      if (data.payments) payments.push(...data.payments);
      cursor = data.cursor || null;
      pages++;
    } while (cursor && pages < 3);

    const completed = payments.filter(p => p.status === 'COMPLETED' && p.note && p.note.startsWith('Harker760 |'));
    const records = completed.map(p => {
      const note = p.note || '';
      const amount = (p.amount_money?.amount || 0) / 100;
      const isGiftCert = note.includes('Gift Certificate');
      const idMatch = note.match(/\(([^)]+)\)$/);
      const refId = idMatch ? idMatch[1] : null;
      return {
        type: isGiftCert ? 'gift_certificate' : 'item',
        amount,
        customer_email: p.buyer_email_address || null,
        item_id: refId,
        item_title: isGiftCert ? `Gift Certificate - $${amount}` : (note.replace('Harker760 | ', '') || null),
        gift_code: isGiftCert ? refId : null,
        square_payment_id: p.id,
        note: note || null,
        created_at: p.created_at
      };
    });

    let inserted = 0;
    for (let i = 0; i < records.length; i += 20) {
      const chunk = records.slice(i, i + 20);
      const res = await supa(env, 'sales', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(chunk)
      });
      if (res.ok) inserted += chunk.length;
      else console.error(`Batch ${i} failed:`, res.status, await res.text());
    }
    return jsonResponse({ total_payments: payments.length, completed: completed.length, inserted, records: records.length }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleSalesBackfillNames(request, env) {
  if (!env.SQUARE_ACCESS_TOKEN) return jsonResponse({ error: 'Square not configured' }, 500, request);
  try {
    const res = await supa(env, 'sales?customer_name=is.null&square_payment_id=not.is.null&select=id,square_payment_id');
    const sales = await res.json();
    if (!sales.length) return jsonResponse({ updated: 0, message: 'All sales already have names' }, 200, request);

    let updated = 0;
    for (const sale of sales) {
      const pRes = await fetch(`${SQUARE_API}/payments/${encodeURIComponent(sale.square_payment_id)}`, {
        headers: { 'Square-Version': SQUARE_VERSION, 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` }
      });
      if (!pRes.ok) continue;
      const payment = (await pRes.json()).payment;
      let name = payment?.card_details?.card?.cardholder_name;
      if (!name && payment?.shipping_address) {
        const addr = payment.shipping_address;
        if (addr.first_name || addr.last_name) name = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
      }
      if (!name) continue;
      await supa(env, `sales?id=eq.${sale.id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ customer_name: name })
      });
      updated++;
    }
    return jsonResponse({ total: sales.length, updated }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ─── Image CDN ────────────────────────────────────────────────────

async function handleImageProxy(request, url) {
  const imagePath = url.pathname.slice(5);
  if (!imagePath || imagePath.includes('..') || !imagePath.startsWith('images/products/')) {
    return new Response('Forbidden', { status: 403 });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  let response = await cache.match(cacheKey);
  if (response) return response;

  const originResp = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${imagePath}`);
  if (!originResp.ok) return new Response('Not found', { status: 404 });

  response = new Response(originResp.body, {
    status: 200,
    headers: {
      'Content-Type': originResp.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// ─── Admin proxies (admin only) ───────────────────────────────────

async function handleAdminGitHub(request, env) {
  const { action, path, content, sha, message, branch } = await request.json();
  const repoPrefix = `${OWNER}/${REPO}/contents/`;
  if (typeof path !== 'string' || path.includes('..') || path.includes('%') ||
      !new RegExp(`^${OWNER}/${REPO}/contents/[A-Za-z0-9._/-]+(\\?ref=main)?$`).test(path)) {
    return jsonResponse({ error: 'Forbidden' }, 403, request);
  }
  if (!env.GITHUB_TOKEN) return jsonResponse({ error: 'GitHub token not configured' }, 500, request);
  const ghUrl = `https://api.github.com/repos/${repoPrefix}${path.slice(repoPrefix.length)}`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Harker760-Admin',
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'get') {
      const res = await fetch(ghUrl, { headers });
      if (!res.ok) return jsonResponse({ error: `GitHub ${res.status}` }, res.status, request);
      return jsonResponse(await res.json(), 200, request);
    }
    if (action === 'put' || action === 'delete') {
      const body = action === 'put'
        ? { message: message || 'Update', content, branch: branch || 'main', ...(sha ? { sha } : {}) }
        : { message: message || 'Delete', sha, branch: branch || 'main' };
      const res = await fetch(ghUrl, { method: action === 'put' ? 'PUT' : 'DELETE', headers, body: JSON.stringify(body) });
      if (!res.ok) return jsonResponse({ error: await res.text() }, res.status, request);
      return jsonResponse(await res.json(), 200, request);
    }
    return jsonResponse({ error: 'Invalid action' }, 400, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleAdminGemini(request, env) {
  if (!env.GEMINI_KEY) return jsonResponse({ error: 'Gemini key not configured' }, 500, request);
  const { model, contents, generationConfig } = await request.json();
  if (typeof model !== 'string' || !/^gemini-[a-z0-9.-]+$/.test(model)) {
    return jsonResponse({ error: 'Invalid model' }, 400, request);
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: JSON.stringify({ contents, generationConfig })
      }
    );
    if (!res.ok) return jsonResponse({ error: await res.text() }, res.status, request);
    return jsonResponse(await res.json(), 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleAdminDb(request, env, url) {
  const table = url.pathname.slice('/admin/db/'.length);
  const allowed = ADMIN_DB_TABLES[table];
  if (!allowed || !allowed.includes(request.method)) {
    return jsonResponse({ error: 'Forbidden' }, 403, request);
  }
  try {
    const init = { method: request.method, headers: { 'Prefer': request.headers.get('Prefer') || 'return=minimal' } };
    if (request.method !== 'GET') init.body = await request.text();
    const res = await supa(env, `${table}${url.search}`, init);
    const text = await res.text();
    return new Response(text || (res.ok ? '[]' : '{}'), {
      status: res.status,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleWebhookTest(request, env) {
  const auth = { 'Square-Version': SQUARE_VERSION, 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${SQUARE_API}/webhooks/subscriptions`, { headers: auth });
  const data = await list.json();
  if (!list.ok) return jsonResponse({ error: data.errors?.[0]?.detail || 'Square error' }, 500, request);
  const results = [];
  for (const sub of data.subscriptions || []) {
    if (!sub.enabled || !String(sub.notification_url || '').includes('h760-checkout')) continue;
    const t = await fetch(`${SQUARE_API}/webhooks/subscriptions/${sub.id}/test`, {
      method: 'POST', headers: auth, body: JSON.stringify({ event_type: 'payment.updated' })
    });
    const tr = await t.json();
    results.push({ url: sub.notification_url, events: sub.event_types, status_code: tr.subscription_test_result?.status_code ?? tr.status_code ?? null });
  }
  return jsonResponse({ subscriptions: (data.subscriptions || []).map(s => ({ url: s.notification_url, enabled: s.enabled })), tested: results }, 200, request);
}
