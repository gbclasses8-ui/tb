import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TARGET_ORIGIN = 'https://ais-pre-2nf54bq7hle7qcwczxouzs-561745921472.asia-east1.run.app';

// In-memory cookie jar to maintain authenticated communication with upstream
const cookieJar: Record<string, string> = {
  '__SECURE-aistudio_auth_token': 'one_token_to_rule_them_all',
  '__SECURE-aistudio_auth_flow_may_set_cookies': 'true',
};

function getCookieHeader(): string {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function updateCookiesFromHeaders(headers: Headers) {
  const raw = (headers as any).getSetCookie
    ? (headers as any).getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);

  for (const c of raw) {
    if (typeof c === 'string') {
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) {
        cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
      }
    }
  }
}

// Upstream session check
async function ensureUpstreamSession() {
  try {
    const res = await fetch(TARGET_ORIGIN + '/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Cookie: getCookieHeader(),
      },
      redirect: 'manual',
    });
    updateCookiesFromHeaders(res.headers);
  } catch (err) {
    console.warn('Initial upstream handshake warning:', err);
  }
}

// Refresh upstream session every 10 minutes
setInterval(ensureUpstreamSession, 10 * 60 * 1000);

// Parse raw body for potential POST/PUT payload forwarding
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// 1. Static branding assets (Serving the user-provided icon)
app.use(express.static(path.resolve(__dirname, 'public'), { maxAge: '1d' }));

// 2. Upstream Proxy for /api/* and /batch_thumbs/*
app.use(['/api', '/batch_thumbs'], async (req: Request, res: Response) => {
  try {
    if (!cookieJar['GAESA']) {
      await ensureUpstreamSession();
    }
    const targetUrl = new URL(req.originalUrl, TARGET_ORIGIN);
    const headers = new Headers();

    const clientUa = req.headers['user-agent'] as string || '';
    const browserUa =
      clientUa && !clientUa.toLowerCase().includes('curl')
        ? clientUa
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    headers.set('User-Agent', browserUa);
    headers.set('Cookie', getCookieHeader());

    if (req.headers['authorization']) {
      headers.set('Authorization', req.headers['authorization'] as string);
    }
    if (req.headers['content-type']) {
      headers.set('Content-Type', req.headers['content-type'] as string);
    }
    if (req.headers['range']) {
      headers.set('Range', req.headers['range'] as string);
    }
    if (req.headers['accept']) {
      headers.set('Accept', req.headers['accept'] as string);
    }
    if (req.headers['accept-language']) {
      headers.set('Accept-Language', req.headers['accept-language'] as string);
    }
    if (req.headers['x-requested-with']) {
      headers.set('X-Requested-With', req.headers['x-requested-with'] as string);
    }

    const hasBody =
      ['POST', 'PUT', 'PATCH'].includes(req.method) &&
      req.body &&
      Buffer.isBuffer(req.body) &&
      req.body.length > 0;

    let upstreamRes = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
    });

    // If session expired or 302 redirect to cookie check, refresh and retry once
    if (upstreamRes.status === 302 || upstreamRes.status === 401 || upstreamRes.status === 403) {
      updateCookiesFromHeaders(upstreamRes.headers);
      await ensureUpstreamSession();
      headers.set('Cookie', getCookieHeader());
      upstreamRes = await fetch(targetUrl.toString(), {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: 'manual',
      });
    }

    updateCookiesFromHeaders(upstreamRes.headers);

    const contentType = upstreamRes.headers.get('content-type') || '';
    const hopByHopHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding']);

    // If HTML player response, apply GB STUDY branding & Telegram replacement
    if (contentType.includes('text/html')) {
      let html = await upstreamRes.text();
      html = html
        .replace(/https:\/\/t\.me\/spidystudy/g, 'https://t.me/GBFreestudy')
        .replace(/@spidystudy/gi, '@GBFreestudy')
        .replace(/Target Board/gi, 'GB STUDY')
        .replace(/Spidy Study/gi, 'GB STUDY')
        .replace(/spidystudy/gi, 'gbstudy');

      upstreamRes.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (!hopByHopHeaders.has(lower) && lower !== 'content-length') {
          res.setHeader(key, val);
        }
      });
      res.setHeader('Content-Length', Buffer.byteLength(html, 'utf-8'));
      res.status(upstreamRes.status).send(html);
      return;
    }

    // Forward status & headers for video/PDF/JSON/binary data
    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (!hopByHopHeaders.has(lower)) {
        res.setHeader(key, val);
      }
    });

    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body as any);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error(`Proxy error on ${req.originalUrl}:`, err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy Gateway Error', details: err.message });
    }
  }
});

// Vite Middleware for Development / Static serving for Production
async function setupFrontend() {
  await ensureUpstreamSession();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GB STUDY server running at http://0.0.0.0:${PORT}`);
  });
}

setupFrontend().catch((err) => {
  console.error('Failed to start frontend server:', err);
  process.exit(1);
});
