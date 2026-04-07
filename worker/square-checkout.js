export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/checkout' && request.method === 'POST') {
      return handleCheckout(request, env);
    }

    if (url.pathname === '/gift-checkout' && request.method === 'POST') {
      return handleGiftCheckout(request, env);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    if (url.pathname === '/removebg' && request.method === 'POST') {
      return handleRemoveBg(request, env);
    }

    if (url.pathname === '/send-gift-email' && request.method === 'POST') {
      return handleSendGiftEmail(request, env);
    }

    if (url.pathname === '/sales' && request.method === 'POST') {
      return handleSales(request, env);
    }

    if (url.pathname === '/sales-backfill' && request.method === 'POST') {
      return handleSalesBackfill(request, env);
    }

    if (url.pathname === '/sales-backfill-names' && request.method === 'POST') {
      return handleSalesBackfillNames(request, env);
    }

    // Image CDN proxy — cache images at Cloudflare edge with long TTL
    if (url.pathname.startsWith('/img/') && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleImageProxy(request, url);
    }

    // Admin API proxies — keys stay server-side
    if (url.pathname.startsWith('/admin/github') && request.method === 'POST') {
      return handleAdminGitHub(request, env);
    }

    if (url.pathname === '/admin/gemini' && request.method === 'POST') {
      return handleAdminGemini(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = ['https://harker760.com', 'https://www.harker760.com', 'https://elikagan.github.io'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

async function handleCheckout(request, env) {
  try {
    const { title, price, itemId, discountCode } = await request.json();

    // Input validation
    if (typeof price !== 'number' || price <= 0 || price > 100000) {
      return jsonResponse({ error: 'Invalid price' }, 400, request);
    }
    if (typeof itemId !== 'string' || !/^\d{1,8}$/.test(itemId)) {
      return jsonResponse({ error: 'Invalid item ID' }, 400, request);
    }
    if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
      return jsonResponse({ error: 'Invalid title' }, 400, request);
    }

    let amountCents = Math.round(price * 100);
    let discountApplied = null;

    // Validate and apply discount code
    if (discountCode && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        const dcRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/discount_codes?code=eq.${encodeURIComponent(discountCode.toUpperCase())}&is_active=eq.true&select=code,type,value,max_uses,used_count,id`,
          {
            headers: {
              'apikey': env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
            }
          }
        );
        const dcData = await dcRes.json();

        if (dcData.length > 0) {
          const dc = dcData[0];
          if (!dc.max_uses || dc.used_count < dc.max_uses) {
            discountApplied = dc;
          }
        }
      } catch (e) {
        console.error('Discount validation failed:', e.message);
      }
    }

    // Build order
    const orderBody = {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{
        name: title,
        quantity: '1',
        base_price_money: { amount: amountCents, currency: 'USD' }
      }],
      taxes: [{
        uid: 'ca-sales-tax',
        name: 'CA Sales Tax',
        percentage: '10.25',
        scope: 'ORDER'
      }]
    };

    // Add discount to order if validated
    if (discountApplied) {
      if (discountApplied.type === 'percent') {
        orderBody.discounts = [{
          uid: 'promo',
          name: `Discount (${discountApplied.code})`,
          percentage: String(discountApplied.value),
          scope: 'ORDER'
        }];
      } else {
        const discountCents = Math.round(Number(discountApplied.value) * 100);
        orderBody.discounts = [{
          uid: 'promo',
          name: `Discount (${discountApplied.code})`,
          amount_money: { amount: discountCents, currency: 'USD' },
          scope: 'ORDER'
        }];
      }
    }

    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-12-18',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: orderBody,
        checkout_options: {
          redirect_url: `https://harker760.com/?purchased=1#${itemId}`,
          ask_for_shipping_address: true
        },
        payment_note: `Harker760 | ${title} (${itemId})`
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Square error:', JSON.stringify(data.errors));
      return jsonResponse({ error: data.errors?.[0]?.detail || 'Checkout failed' }, 500, request);
    }

    // Validate checkout URL
    const checkoutUrl = data.payment_link?.url || '';
    if (!checkoutUrl.startsWith('https://square.link/') && !checkoutUrl.startsWith('https://checkout.square.site/')) {
      console.error('Unexpected checkout URL:', checkoutUrl);
      return jsonResponse({ error: 'Checkout failed' }, 500, request);
    }

    // Increment discount used_count
    if (discountApplied && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/discount_codes?id=eq.${discountApplied.id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ used_count: discountApplied.used_count + 1 })
          }
        );
      } catch (e) {
        console.error('Discount count update failed:', e.message);
      }
    }

    return jsonResponse({ url: checkoutUrl }, 200, request);
  } catch (err) {
    console.error('Checkout error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleGiftCheckout(request, env) {
  try {
    const { amount, email, purchaserName, recipientName } = await request.json();

    if (typeof amount !== 'number' || amount <= 0 || amount > 10000) {
      return jsonResponse({ error: 'Invalid amount' }, 400, request);
    }

    // Generate GIFT-XXXX-XXXX code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'GIFT-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    code += '-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];

    const amountCents = Math.round(amount * 100);

    const orderBody = {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{
        name: `Gift Certificate - $${amount}`,
        quantity: '1',
        base_price_money: { amount: amountCents, currency: 'USD' }
      }]
      // No taxes — gift certificates are not taxable
    };

    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-12-18',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: orderBody,
        checkout_options: {
          redirect_url: `https://harker760.com/gift/?purchased=1&code=${encodeURIComponent(code)}`,
          ask_for_shipping_address: false
        },
        ...(email ? { pre_populated_data: { buyer_email: email } } : {}),
        payment_note: `Harker760 | Gift Certificate (${code})`
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Square error:', JSON.stringify(data.errors));
      return jsonResponse({ error: data.errors?.[0]?.detail || 'Checkout failed' }, 500, request);
    }

    const checkoutUrl = data.payment_link?.url || '';
    if (!checkoutUrl.startsWith('https://square.link/') && !checkoutUrl.startsWith('https://checkout.square.site/')) {
      console.error('Unexpected checkout URL:', checkoutUrl);
      return jsonResponse({ error: 'Checkout failed' }, 500, request);
    }

    // Create the gift certificate in Supabase
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        const gcBody = {
          code,
          type: 'fixed',
          value: amount,
          max_uses: 1,
          is_gift_certificate: true,
          is_active: true
        };
        if (email) gcBody.purchaser_email = email;
        if (purchaserName) gcBody.purchaser_name = purchaserName;
        if (recipientName) gcBody.recipient_name = recipientName;

        await fetch(`${env.SUPABASE_URL}/rest/v1/discount_codes`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(gcBody)
        });
      } catch (e) {
        console.error('Gift cert Supabase insert failed:', e.message);
      }
    }

    // Confirmation email is sent after payment completes (via webhook)
    return jsonResponse({ url: checkoutUrl, code }, 200, request);
  } catch (err) {
    console.error('Gift checkout error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleSendGiftEmail(request, env) {
  try {
    const { code, amount, email, purchaserName, recipientName } = await request.json();

    if (!code || !amount || !email) {
      return jsonResponse({ error: 'code, amount, and email required' }, 400, request);
    }

    if (!env.RESEND_API_KEY) {
      return jsonResponse({ error: 'Email not configured' }, 500, request);
    }

    const toName = recipientName || 'someone special';
    const fromName = purchaserName || '';
    const fromLine = fromName ? `<p style="color:#888;font-size:14px;">From: ${fromName}</p>` : '';
    const toLine = recipientName ? `<p style="color:#888;font-size:14px;">To: ${toName}</p>` : '';

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Harker760 <onboarding@resend.dev>',
        to: [email],
        subject: `Your Harker760 Gift Certificate - $${amount}`,
        html: `
          <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
            <h1 style="font-size:20px;font-weight:500;margin-bottom:24px;">Gift Certificate</h1>
            ${toLine}${fromLine}
            <p style="font-size:15px;color:#555;line-height:1.6;margin-bottom:24px;">
              Here's your Harker760 gift certificate. Give this code to the recipient to use at checkout.
            </p>
            <div style="text-align:center;padding:24px;border:2px solid #1a1a1a;border-radius:12px;margin-bottom:24px;">
              <div style="font-size:14px;color:#888;margin-bottom:8px;">GIFT CERTIFICATE CODE</div>
              <div style="font-size:28px;font-weight:600;letter-spacing:0.06em;">${code}</div>
              <div style="font-size:16px;color:#888;margin-top:8px;">$${amount}</div>
            </div>
            <p style="font-size:14px;color:#888;line-height:1.6;">
              This code can be used at checkout on <a href="https://harker760.com" style="color:#1a1a1a;">harker760.com</a> or in-store at Harker760 in Pasadena. It does not expire.
            </p>
            <hr style="border:none;border-top:1px solid #ddd;margin:32px 0;">
            <p style="font-size:12px;color:#aaa;">Harker760<br>Pasadena, CA</p>
          </div>
        `
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
      return jsonResponse({ error: 'Failed to send email' }, 500, request);
    }

    return jsonResponse({ success: true }, 200, request);
  } catch (err) {
    console.error('Send gift email error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleWebhook(request, env) {
  try {
    const body = await request.text();
    console.log('🚨 STEP 1: WEBHOOK HIT — received POST to /webhook');
    console.log('🚨 STEP 1: Request URL:', request.url);
    console.log('🚨 STEP 1: Body length:', body.length);

    // Validate webhook signature if key is configured
    const signature = request.headers.get('x-square-hmacsha256-signature');
    if (env.SQUARE_WEBHOOK_SIGNATURE_KEY && signature) {
      console.log('🚨 STEP 1b: Validating webhook signature...');
      try {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );

        const signPayload = request.url + body;
        const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signPayload));
        const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

        if (expected !== signature) {
          console.error('🚨🚨🚨 STEP 1b FAILED: Webhook signature MISMATCH — URL:', request.url);
          console.error('🚨🚨🚨 Expected:', expected);
          console.error('🚨🚨🚨 Got:', signature);
        } else {
          console.log('🚨 STEP 1b: Signature valid ✓');
        }
      } catch (e) {
        console.error('🚨🚨🚨 STEP 1b FAILED: Signature validation error:', e.message);
      }
    } else {
      console.log('🚨 STEP 1b: No signature key configured or no signature header — skipping validation');
    }

    const event = JSON.parse(body);
    console.log('🚨 STEP 2: PARSED EVENT — type:', event.type);

    if (event.type === 'payment.updated') {
      console.log('🚨 STEP 3: EVENT IS payment.updated ✓');
      const payment = event.data?.object?.payment;
      console.log('🚨 STEP 3: Payment status:', payment?.status);
      console.log('🚨 STEP 3: Payment note:', payment?.note);
      console.log('🚨 STEP 3: Payment amount:', payment?.amount_money);

      if (payment?.status === 'COMPLETED') {
        console.log('🚨 STEP 4: PAYMENT IS COMPLETED ✓');
        const note = payment.note || '';
        const amount = (payment.amount_money?.amount || 0) / 100;

        // Try to extract item info from our payment note
        let itemId = null;
        let itemInfo = '';
        if (note.startsWith('Harker760 |')) {
          itemInfo = note.replace('Harker760 | ', '');
          const idMatch = note.match(/\(([^)]+)\)$/);
          itemId = idMatch ? idMatch[1] : null;
          console.log('🚨 STEP 4: Extracted itemId:', itemId, 'itemInfo:', itemInfo);
        } else {
          console.log('🚨 STEP 4: Note does not start with "Harker760 |" — note was:', JSON.stringify(note));
        }

        // Auto-mark as sold if we can identify the item (skip for gift certificates)
        const isGiftCert = note.includes('Gift Certificate');
        if (itemId && env.GITHUB_TOKEN && !isGiftCert) {
          console.log('🚨 STEP 5: MARKING AS SOLD — itemId:', itemId);
          try {
            await markAsSold(env, itemId);
            console.log('🚨 STEP 5: Marked sold ✓');
          } catch (e) {
            console.error('🚨🚨🚨 STEP 5 FAILED: markAsSold error:', e.message);
          }
        } else {
          console.log('🚨 STEP 5: SKIPPING mark-as-sold —', !itemId ? 'no itemId' : 'no GITHUB_TOKEN');
        }

        // Capture buyer email from Square payment
        const buyerEmail = payment.buyer_email_address;
        if (buyerEmail && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          console.log('🚨 STEP 6: CAPTURING BUYER EMAIL:', buyerEmail);
          try {
            await fetch(`${env.SUPABASE_URL}/rest/v1/emails`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal,resolution=ignore-duplicates'
              },
              body: JSON.stringify({
                email: buyerEmail,
                source: 'purchase',
                item_id: itemId || null
              })
            });
            console.log('🚨 STEP 6: Email captured ✓');
          } catch (e) {
            console.error('🚨🚨🚨 STEP 6 FAILED: Email capture error:', e.message);
          }
        } else {
          console.log('🚨 STEP 6: SKIPPING email capture —', !buyerEmail ? 'no buyer email on payment' : 'missing Supabase env vars');
        }

        // For gift certs: send confirmation email now that payment is complete
        if (isGiftCert && buyerEmail && itemId && env.RESEND_API_KEY && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          try {
            // Look up the gift cert from discount_codes to get purchaser/recipient names
            const gcRes = await fetch(
              `${env.SUPABASE_URL}/rest/v1/discount_codes?code=eq.${encodeURIComponent(itemId)}&is_gift_certificate=eq.true&select=value,purchaser_name,recipient_name`,
              { headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}` } }
            );
            const gcData = await gcRes.json();
            const gc = gcData?.[0] || {};
            const gcAmount = gc.value || amount;
            const toName = gc.recipient_name || 'someone special';
            const fromName = gc.purchaser_name || '';
            const fromLine = fromName ? `<p style="color:#888;font-size:14px;">From: ${fromName}</p>` : '';
            const toLine = gc.recipient_name ? `<p style="color:#888;font-size:14px;">To: ${toName}</p>` : '';

            // Update purchaser_email on the gift cert record
            await fetch(
              `${env.SUPABASE_URL}/rest/v1/discount_codes?code=eq.${encodeURIComponent(itemId)}&is_gift_certificate=eq.true`,
              {
                method: 'PATCH',
                headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                body: JSON.stringify({ purchaser_email: buyerEmail })
              }
            );

            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'Harker760 <onboarding@resend.dev>',
                to: [buyerEmail],
                subject: `Your Harker760 Gift Certificate - $${gcAmount}`,
                html: `
                  <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
                    <h1 style="font-size:20px;font-weight:500;margin-bottom:24px;">Gift Certificate</h1>
                    ${toLine}${fromLine}
                    <p style="font-size:15px;color:#555;line-height:1.6;margin-bottom:24px;">
                      Here's your Harker760 gift certificate. Give this code to the recipient to use at checkout.
                    </p>
                    <div style="text-align:center;padding:24px;border:2px solid #1a1a1a;border-radius:12px;margin-bottom:24px;">
                      <div style="font-size:14px;color:#888;margin-bottom:8px;">GIFT CERTIFICATE CODE</div>
                      <div style="font-size:28px;font-weight:600;letter-spacing:0.06em;">${itemId}</div>
                      <div style="font-size:16px;color:#888;margin-top:8px;">$${gcAmount}</div>
                    </div>
                    <p style="font-size:14px;color:#888;line-height:1.6;">
                      This code can be used at checkout on <a href="https://harker760.com" style="color:#1a1a1a;">harker760.com</a> or in-store at Harker760 in Pasadena. It does not expire.
                    </p>
                    <hr style="border:none;border-top:1px solid #ddd;margin:32px 0;">
                    <p style="font-size:12px;color:#aaa;">Harker760<br>Pasadena, CA</p>
                  </div>
                `
              })
            });
            console.log('🚨 STEP 6b: Gift cert email sent to', buyerEmail, '✓');
          } catch (e) {
            console.error('🚨🚨🚨 STEP 6b FAILED: Gift cert email error:', e.message);
          }
        }

        // Record sale in Supabase sales table (website sales only — must have Harker760 note)
        if (note.startsWith('Harker760 |') && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          try {
            // Extract customer name — try cardholder name, then shipping address
            let cardholderName = payment.card_details?.card?.cardholder_name || null;
            if (!cardholderName && payment.shipping_address) {
              const addr = payment.shipping_address;
              if (addr.first_name || addr.last_name) cardholderName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
            }
            // Look up postedBy from inventory for commission tracking
            let postedBy = null;
            if (itemId && !isGiftCert) {
              try {
                const invRes = await fetch(`https://raw.githubusercontent.com/elikagan/harker760/main/inventory.json?t=${Date.now()}`);
                if (invRes.ok) {
                  const inv = await invRes.json();
                  const found = inv.find(i => i.id === itemId);
                  if (found?.postedBy) postedBy = found.postedBy;
                }
              } catch (_) {}
            }
            const saleRecord = {
              type: isGiftCert ? 'gift_certificate' : 'item',
              amount,
              customer_email: buyerEmail || null,
              customer_name: cardholderName,
              item_id: itemId || null,
              item_title: isGiftCert ? `Gift Certificate - $${amount}` : (itemInfo || null),
              gift_code: isGiftCert ? itemId : null,
              posted_by: postedBy,
              square_payment_id: payment.id || null,
              note: note || null
            };
            await fetch(`${env.SUPABASE_URL}/rest/v1/sales`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal,resolution=ignore-duplicates'
              },
              body: JSON.stringify(saleRecord)
            });
            console.log('🚨 STEP 7: Sale recorded ✓', saleRecord.type, '$' + amount);
          } catch (e) {
            console.error('🚨🚨🚨 STEP 7 FAILED: Sale record error:', e.message);
          }
        }

        // Sale notifications handled by Square app directly
      } else {
        console.log('🚨🚨🚨 STEP 4 STOPPED: Payment status is NOT COMPLETED — it is:', payment?.status);
      }
    } else {
      console.log('🚨🚨🚨 STEP 2 STOPPED: Event type is NOT payment.updated — it is:', event.type);
    }

    console.log('🚨 DONE: Webhook handler complete, returning 200');
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('🚨🚨🚨 WEBHOOK CRASHED:', e.message, e.stack);
    return new Response('Error', { status: 500 });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleRemoveBg(request, env) {
  try {
    const { imageBase64, apiKey } = await request.json();
    if (!imageBase64 || !apiKey) {
      return jsonResponse({ error: 'Missing imageBase64 or apiKey' }, 400, request);
    }

    // Convert base64 to binary
    const raw = atob(imageBase64);
    const binary = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
    const blob = new Blob([binary], { type: 'image/jpeg' });

    const form = new FormData();
    form.append('image_file', blob, 'image.jpg');
    form.append('size', 'auto');
    form.append('format', 'png');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form
    });

    if (!res.ok) {
      const err = await res.text();
      return jsonResponse({ error: `remove.bg ${res.status}: ${err}` }, res.status, request);
    }

    const resultBuf = await res.arrayBuffer();
    const resultBase64 = arrayBufferToBase64(resultBuf);

    return new Response(JSON.stringify({ imageBase64: resultBase64 }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function markAsSold(env, itemId, attempt = 0) {
  const owner = 'elikagan';
  const repo = 'harker760';
  const path = 'inventory.json';
  const ghApi = 'https://api.github.com';

  try {
    // Fetch current inventory
    const fileRes = await fetch(`${ghApi}/repos/${owner}/${repo}/contents/${path}?ref=main`, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'h760-checkout-worker'
      }
    });
    if (!fileRes.ok) return;

    const fileData = await fileRes.json();
    const content = atob(fileData.content.replace(/\n/g, ''));
    const items = JSON.parse(content);

    // Find and mark item as sold
    const item = items.find(i => i.id === itemId);
    if (!item || item.isSold) return;

    item.isSold = true;
    item.isNew = false;
    item.isHold = false;

    // Commit updated inventory
    const updated = JSON.stringify(items, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(updated)));

    const putRes = await fetch(`${ghApi}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'h760-checkout-worker'
      },
      body: JSON.stringify({
        message: `Mark ${item.title || itemId} as sold`,
        content: encoded,
        sha: fileData.sha,
        branch: 'main'
      })
    });

    // SHA conflict — retry up to 3 times (concurrent webhooks can race)
    if (putRes.status === 409 && attempt < 3) {
      console.log(`[markAsSold] SHA conflict for ${itemId}, retry ${attempt + 1}`);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
      return markAsSold(env, itemId, attempt + 1);
    }
    if (!putRes.ok) {
      console.error(`[markAsSold] Failed for ${itemId} after ${attempt + 1} attempts, status ${putRes.status}`);
    }
  } catch (e) {
    console.error(`[markAsSold] Error for ${itemId}:`, e.message);
    // Don't fail the webhook — reconciliation on admin load will catch it
  }
}

// ─── Sales ─────────────────────────────────────────────────────────

async function handleSales(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase not configured' }, 500, request);
  }
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sales?select=*&order=created_at.desc&limit=500`,
      {
        headers: {
          'apikey': env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
        }
      }
    );
    const sales = await res.json();
    return jsonResponse({ sales, count: sales.length }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleSalesBackfill(request, env) {
  // Query Square Payments API for all completed payments and insert into Supabase sales table
  if (!env.SQUARE_ACCESS_TOKEN) {
    return jsonResponse({ error: 'Square not configured' }, 500, request);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase not configured' }, 500, request);
  }

  try {
    const payments = [];
    let cursor = null;

    // Fetch Square payments (up to 3 pages to stay under Worker subrequest limit)
    let pages = 0;
    do {
      const params = new URLSearchParams({
        sort_order: 'DESC',
        limit: '100'
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(
        `https://connect.squareup.com/v2/payments?${params}`,
        {
          headers: {
            'Square-Version': '2024-12-18',
            'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`
          }
        }
      );
      const data = await res.json();
      if (!res.ok) {
        return jsonResponse({ error: data.errors?.[0]?.detail || 'Square API error' }, 500, request);
      }
      if (data.payments) payments.push(...data.payments);
      cursor = data.cursor || null;
      pages++;
    } while (cursor && pages < 3);

    // Filter to completed payments from the website only (have "Harker760 |" in note)
    const completed = payments.filter(p => p.status === 'COMPLETED' && p.note && p.note.startsWith('Harker760 |'));

    // Build sale records
    const records = completed.map(p => {
      const note = p.note || '';
      const amount = (p.amount_money?.amount || 0) / 100;
      const isGiftCert = note.includes('Gift Certificate');

      let itemId = null;
      let itemInfo = '';
      if (note.startsWith('Harker760 |')) {
        itemInfo = note.replace('Harker760 | ', '');
        const idMatch = note.match(/\(([^)]+)\)$/);
        itemId = idMatch ? idMatch[1] : null;
      }

      return {
        type: isGiftCert ? 'gift_certificate' : 'item',
        amount,
        customer_email: p.buyer_email_address || null,
        item_id: itemId || null,
        item_title: isGiftCert ? `Gift Certificate - $${amount}` : (itemInfo || note || null),
        gift_code: isGiftCert ? itemId : null,
        square_payment_id: p.id,
        note: note || null,
        created_at: p.created_at
      };
    });

    // Batch upsert into Supabase in chunks of 20
    let inserted = 0;
    const chunkSize = 20;
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sales`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal,resolution=ignore-duplicates'
          },
          body: JSON.stringify(chunk)
        });
        if (res.ok) inserted += chunk.length;
        else {
          const err = await res.text();
          console.error(`Batch ${i}-${i+chunkSize} failed:`, res.status, err);
        }
      } catch (e) {
        console.error(`Batch ${i}-${i+chunkSize} error:`, e.message);
      }
    }

    return jsonResponse({
      total_payments: payments.length,
      completed: completed.length,
      inserted,
      records: records.length
    }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleSalesBackfillNames(request, env) {
  // For each sale with a square_payment_id but no customer_name, fetch the payment from Square
  // and try cardholder_name, then order customer, then shipping address
  if (!env.SQUARE_ACCESS_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Missing Square or Supabase config' }, 500, request);
  }
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sales?customer_name=is.null&square_payment_id=not.is.null&select=id,square_payment_id`,
      { headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}` } }
    );
    const sales = await res.json();
    if (!sales.length) return jsonResponse({ updated: 0, message: 'All sales already have names' }, 200, request);

    let updated = 0;
    const details = [];
    for (const sale of sales) {
      try {
        // Fetch payment details
        const pRes = await fetch(`https://connect.squareup.com/v2/payments/${sale.square_payment_id}`, {
          headers: { 'Square-Version': '2024-12-18', 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` }
        });
        if (!pRes.ok) { details.push({ id: sale.id, error: 'payment fetch failed' }); continue; }
        const pData = await pRes.json();
        const payment = pData.payment;

        // Try multiple sources for name
        let name = payment?.card_details?.card?.cardholder_name;
        if (!name && payment?.shipping_address) {
          const addr = payment.shipping_address;
          if (addr.first_name || addr.last_name) name = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
        }
        if (!name && payment?.order_id) {
          // Try fetching the order for customer info
          const oRes = await fetch(`https://connect.squareup.com/v2/orders/${payment.order_id}`, {
            headers: { 'Square-Version': '2024-12-18', 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` }
          });
          if (oRes.ok) {
            const oData = await oRes.json();
            const fulfillment = oData.order?.fulfillments?.[0]?.pickup_details?.recipient;
            if (fulfillment?.display_name) name = fulfillment.display_name;
          }
        }

        details.push({ id: sale.id, paymentId: sale.square_payment_id, nameFound: name || null,
          cardholderName: payment?.card_details?.card?.cardholder_name || null,
          buyerEmail: payment?.buyer_email_address || null });

        if (!name) continue;

        await fetch(`${env.SUPABASE_URL}/rest/v1/sales?id=eq.${sale.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ customer_name: name })
        });
        updated++;
      } catch (e) {
        details.push({ id: sale.id, error: e.message });
      }
    }
    return jsonResponse({ total: sales.length, updated, details }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleImageProxy(request, url) {
  // Strip /img/ prefix to get the image path
  const imagePath = url.pathname.slice(5); // remove "/img/"
  if (!imagePath || imagePath.includes('..')) {
    return new Response('Bad request', { status: 400 });
  }

  // Only allow image paths from our products directory
  if (!imagePath.startsWith('images/products/')) {
    return new Response('Forbidden', { status: 403 });
  }

  // Check Cloudflare cache first (always use GET for cache key)
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  let response = await cache.match(cacheKey);
  if (response) return response;

  // Fetch from GitHub Pages origin
  const originUrl = `https://raw.githubusercontent.com/elikagan/harker760/main/${imagePath}`;
  const originResp = await fetch(originUrl);
  if (!originResp.ok) {
    return new Response('Not found', { status: 404 });
  }

  // Build response with aggressive caching
  response = new Response(originResp.body, {
    status: 200,
    headers: {
      'Content-Type': originResp.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    }
  });

  // Store in Cloudflare edge cache
  await cache.put(cacheKey, response.clone());
  return response;
}

// --- Admin GitHub proxy: keeps GITHUB_TOKEN server-side ---
async function handleAdminGitHub(request, env) {
  if (!env.GITHUB_TOKEN) return jsonResponse({ error: 'GitHub token not configured' }, 500, request);
  const { action, path, content, sha, message, branch } = await request.json();
  const ghBase = 'https://api.github.com';
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Harker760-Admin',
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'get') {
      const res = await fetch(`${ghBase}/repos/${path}`, { headers });
      if (!res.ok) return jsonResponse({ error: `GitHub ${res.status}` }, res.status, request);
      const data = await res.json();
      return jsonResponse(data, 200, request);
    }
    if (action === 'put') {
      const body = { message: message || 'Update', content, branch: branch || 'main' };
      if (sha) body.sha = sha;
      const res = await fetch(`${ghBase}/repos/${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.text();
        return jsonResponse({ error: err }, res.status, request);
      }
      return jsonResponse(await res.json(), 200, request);
    }
    if (action === 'delete') {
      const body = { message: message || 'Delete', sha, branch: branch || 'main' };
      const res = await fetch(`${ghBase}/repos/${path}`, { method: 'DELETE', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.text();
        return jsonResponse({ error: err }, res.status, request);
      }
      return jsonResponse(await res.json(), 200, request);
    }
    return jsonResponse({ error: 'Invalid action' }, 400, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// --- Admin Gemini proxy: keeps GEMINI_KEY server-side ---
async function handleAdminGemini(request, env) {
  if (!env.GEMINI_KEY) return jsonResponse({ error: 'Gemini key not configured' }, 500, request);
  const { model, contents, generationConfig } = await request.json();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return jsonResponse({ error: err }, res.status, request);
    }
    return jsonResponse(await res.json(), 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}
