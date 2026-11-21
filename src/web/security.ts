// Localhost-only HTTP protections. There is no authentication: these checks stop a random website from driving the
// server through the teacher's browser (CSRF) or through a rebinding hostname.
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function hostName(host: string | undefined): { name: string; port: string } | null {
  if (host === undefined || host === '') return null;
  const match = /^([^:]+)(?::(\d+))?$/.exec(host);
  if (match === null) return null;
  return { name: match[1] as string, port: match[2] ?? '' };
}

function localPort(req: Request): string {
  const port = req.socket.localPort;
  return port === undefined ? '' : String(port);
}

function expectedOrigin(req: Request): string {
  return `http://127.0.0.1:${localPort(req)}`;
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    // Alpine's standard build evaluates directives with Function() and toggles inline styles; no inline <script> is allowed.
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
};

export const localHostOnly: RequestHandler = (req, res, next) => {
  const host = hostName(req.get('host'));
  if (host === null || !LOCAL_HOSTS.has(host.name)) {
    res.status(403).json({ error: { code: 'host_not_allowed', message: 'This server only answers localhost requests.' } });
    return;
  }
  const port = localPort(req);
  if (host.port !== '' && port !== '' && host.port !== port) {
    res.status(403).json({ error: { code: 'host_not_allowed', message: 'The Host header does not match this server.' } });
    return;
  }
  next();
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** State-changing requests must come from our own page and carry the custom header (no CORS is enabled). */
export const sameOriginWrites: RequestHandler = (req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get('x-tui-grade') !== '1') {
    res.status(403).json({ error: { code: 'missing_client_header', message: 'Missing X-TUI-Grade header.' } });
    return;
  }
  const origin = req.get('origin');
  if (origin !== expectedOrigin(req) && origin !== `http://localhost:${localPort(req)}`) {
    res.status(403).json({ error: { code: 'origin_not_allowed', message: 'This request did not come from the dashboard.' } });
    return;
  }
  next();
};

/** No CORS: reject preflights instead of advertising cross-origin access. */
export const rejectPreflight: RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.status(403).json({ error: { code: 'cors_disabled', message: 'Cross-origin requests are not allowed.' } });
    return;
  }
  next();
};

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 500;
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) process.stderr.write(`tui-grade web: ${message}\n`);
  res.status(status).json({ error: { code, message: status >= 500 ? 'Internal server error' : message } });
};
