/**
 * DropMail API — Cloudflare Worker (Edge Function)
 * Deploy: wrangler deploy
 * 
 * Handles:
 *   GET  /api/mail?inbox=user&domain=dropmail.io   → List emails
 *   GET  /api/mail/:id                              → Get single email
 *   POST /api/webhook/mailgun                       → Mailgun inbound webhook
 *   DELETE /api/mail/:id                            → Delete email
 *   DELETE /api/inbox?inbox=user&domain=...        → Destroy inbox
 */

// ── CONFIG ─────────────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = ['dropmail.io', 'tempbox.net', 'inboxzap.com'];
const MAILGUN_WEBHOOK_KEY = 'your_mailgun_webhook_signing_key'; // env var in prod
const EMAIL_TTL_SECONDS = 60 * 60 * 24; // 24 hours default

// ── CORS HEADERS ────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Webhook from Mailgun (inbound email)
      if (path === '/api/webhook/mailgun' && request.method === 'POST') {
        return await handleMailgunWebhook(request, env);
      }

      // List emails in inbox
      if (path === '/api/mail' && request.method === 'GET') {
        return await listEmails(url, env);
      }

      // Get single email
      if (path.startsWith('/api/mail/') && request.method === 'GET') {
        const id = path.split('/').pop();
        return await getEmail(id, env);
      }

      // Delete single email
      if (path.startsWith('/api/mail/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return await deleteEmail(id, env);
      }

      // Destroy whole inbox
      if (path === '/api/inbox' && request.method === 'DELETE') {
        return await destroyInbox(url, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

// ── HANDLE MAILGUN INBOUND ───────────────────────────────────────────────────
async function handleMailgunWebhook(request, env) {
  const formData = await request.formData();

  // Extract fields from Mailgun's inbound format
  const recipient   = formData.get('recipient') || '';   // user@dropmail.io
  const sender      = formData.get('sender') || '';
  const from        = formData.get('From') || sender;
  const subject     = formData.get('subject') || '(no subject)';
  const bodyPlain   = formData.get('body-plain') || '';
  const bodyHtml    = formData.get('body-html') || bodyPlain;
  const timestamp   = formData.get('timestamp') || Date.now();

  // Parse inbox + domain from recipient
  const [inbox, domain] = recipient.toLowerCase().split('@');

  if (!ALLOWED_DOMAINS.includes(domain)) {
    return json({ error: 'Domain not allowed' }, 403);
  }

  // Extract OTP if present
  const otp = extractOTP(bodyPlain + ' ' + subject);

  // Detect email type
  const type = detectEmailType(subject, bodyPlain);

  const emailId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const emailObj = {
    id: emailId,
    inbox,
    domain,
    from,
    subject,
    bodyHtml: sanitizeHtml(bodyHtml),
    bodyPlain,
    otp,
    type,
    timestamp: Number(timestamp),
    unread: true,
    receivedAt: new Date().toISOString(),
  };

  // Store in KV: key = inbox:domain:id, TTL = 24h
  const key = `email:${inbox}:${domain}:${emailId}`;
  await env.MAIL_KV.put(key, JSON.stringify(emailObj), {
    expirationTtl: EMAIL_TTL_SECONDS,
  });

  // Update inbox index
  const indexKey = `index:${inbox}:${domain}`;
  const existing = await env.MAIL_KV.get(indexKey, 'json') || [];
  existing.unshift(emailId);
  await env.MAIL_KV.put(indexKey, JSON.stringify(existing.slice(0, 100)), {
    expirationTtl: EMAIL_TTL_SECONDS,
  });

  return json({ ok: true, id: emailId });
}

// ── LIST EMAILS ─────────────────────────────────────────────────────────────
async function listEmails(url, env) {
  const inbox  = (url.searchParams.get('inbox') || '').toLowerCase();
  const domain = (url.searchParams.get('domain') || '').toLowerCase();

  if (!inbox || !domain) return json({ error: 'inbox and domain required' }, 400);
  if (!ALLOWED_DOMAINS.includes(domain)) return json({ error: 'Invalid domain' }, 403);
  if (!/^[a-z0-9._+-]+$/i.test(inbox)) return json({ error: 'Invalid inbox name' }, 400);

  const indexKey = `index:${inbox}:${domain}`;
  const ids = await env.MAIL_KV.get(indexKey, 'json') || [];

  // Fetch all emails in parallel
  const emails = await Promise.all(
    ids.map(id => env.MAIL_KV.get(`email:${inbox}:${domain}:${id}`, 'json'))
  );

  const valid = emails
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  return json(valid);
}

// ── GET SINGLE EMAIL ─────────────────────────────────────────────────────────
async function getEmail(id, env) {
  // We need inbox+domain to build the key, so client must pass them
  // Alternative: use a global lookup index
  const email = await env.MAIL_KV.get(`email:${id}`, 'json');
  if (!email) return json({ error: 'Not found' }, 404);
  return json(email);
}

// ── DELETE EMAIL ─────────────────────────────────────────────────────────────
async function deleteEmail(id, env) {
  await env.MAIL_KV.delete(`email:${id}`);
  return json({ ok: true });
}

// ── DESTROY INBOX ─────────────────────────────────────────────────────────────
async function destroyInbox(url, env) {
  const inbox  = url.searchParams.get('inbox');
  const domain = url.searchParams.get('domain');
  const indexKey = `index:${inbox}:${domain}`;
  const ids = await env.MAIL_KV.get(indexKey, 'json') || [];

  await Promise.all([
    env.MAIL_KV.delete(indexKey),
    ...ids.map(id => env.MAIL_KV.delete(`email:${inbox}:${domain}:${id}`)),
  ]);

  return json({ ok: true, deleted: ids.length });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function extractOTP(text) {
  // Match 4-8 digit codes (OTPs)
  const patterns = [
    /\b(\d{6})\b/,
    /\b(\d{4})\b/,
    /\b(\d{8})\b/,
    /code[:\s]+(\d{4,8})/i,
    /OTP[:\s]+(\d{4,8})/i,
    /verification code[:\s]+(\d{4,8})/i,
    /your code is[:\s]+(\d{4,8})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function detectEmailType(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  if (/otp|one.time|verification code|your code/.test(text)) return 'otp';
  if (/verify|confirm|activate|account/.test(text)) return 'verify';
  if (/unsubscribe|newsletter|promo|offer|deal/.test(text)) return 'promo';
  return 'message';
}

function sanitizeHtml(html) {
  // In production use DOMPurify or a proper sanitizer
  // Cloudflare Workers has HTMLRewriter for safe transforms
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
