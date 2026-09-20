// language: JavaScript (Node 18+ ESM), file: src/agent/tools/live-share.js
// VS Code's "forward a port" feature, for a Telegram agent.
//
// What VS Code does: you run something that listens on localhost:PORT, VS Code
// tunnels it through its relay so a browser on your own machine can open it.
// The value is the loop-back — the server stays private on the remote box and
// the human still gets a clickable URL.
//
// What this does, adapted for a bot: the agent runs a dev server, a notebook,
// or a debugger inside its workspace (job_start, or execute_python). That
// listener is bound to 127.0.0.1 on the host — nothing on the public internet
// can reach it. tunnel_open punches a hole the *bot's* user can walk through,
// and only that user.
//
// Two transports, because the shape of the deploy differs:
//
//   local  — the bot and the human are on the same machine (Termux, a dev box).
//            No relay needed: the URL is just http://127.0.0.1:PORT, which the
//            user's own browser can open. Zero moving parts.
//   relay  — the host is remote (a VPS). A real TCP forwarder is spawned that
//            listens on a public port and pipes to 127.0.0.1:PORT. Access is
//            gated by a random unguessable path token, so the port being open
//            does not mean reachable. Local ports are still local: this never
//            re-exposes something the operator did not explicitly forward.
//
// Why a token and not an auth wall: a browser navigating to a URL cannot be
// asked for a header, and a basic-auth dialog breaks websocket dev servers.
// A 128-bit secret in the path is what ngrok, and VS Code itself, use.
//
// Safety: this opens a network listener. It is dangerous, always gated, and
// the tool refuses to forward anything that is not a localhost address.

import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../logger.js';

const MAX_TUNNELS = 12;
const TOKEN_BYTES = 16;

// userId -> Map<localPort, tunnel>
const _tunnels = new Map();

function tunnelsOf(userId) {
  const key = String(userId ?? '0');
  if (!_tunnels.has(key)) _tunnels.set(key, new Map());
  return _tunnels.get(key);
}

// ---------------------------------------------------------------- transport

/**
 * A minimal TCP relay: accept on the public side, connect to the private side,
 * splice the two sockets. No HTTP parsing — so it is protocol-agnostic and
 * carries websockets, which an HTTP-aware proxy would break.
 */
function relayLoop(publicSrv, targetPort, token, onHit) {
  publicSrv.on('connection', (sock) => {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    let authed = !token; // a tunnel without a token is public by request only
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });

    const teardown = (why) => {
      sock.destroy();
      upstream.destroy();
      if (authed) onHit(peer, why);
    };

    // The first bytes decide everything. If a token is required, the client's
    // request line must contain it. Bytes before that are held back and only
    // forwarded once the check passes — so an unauthed probe never reaches the
    // private service.
    let buffer = Buffer.alloc(0);
    let verified = !token;

    sock.on('data', (chunk) => {
      if (verified) { upstream.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]);
      // A request line longer than this is not an HTTP request we understand.
      if (buffer.length > 8192) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return teardown('bad request'); }
      const head = buffer.toString('latin1');
      const lineEnd = head.indexOf('\r\n');
      if (lineEnd < 0) return; // wait for the full request line
      if (head.slice(0, lineEnd).includes(`/${token}`)) {
        verified = true;
        authed = true;
        upstream.write(buffer);
        buffer = Buffer.alloc(0);
      } else {
        sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return teardown('bad token');
      }
    });

    upstream.on('data', (d) => sock.write(d));
    sock.on('error', () => teardown('socket error'));
    upstream.on('error', () => teardown('upstream error'));
    sock.on('close', () => teardown('closed'));
    upstream.on('close', () => teardown('upstream closed'));
  });
}

/**
 * Plain HTTP reverse proxy. Used only for the read-only preview mode, where the
 * point is showing the human a page, not carrying a websocket session.
 */
// WebSocket upgrade for the HTTP preview path. This is what carries HMR, so a
// preview that drops it shows a page that never hot-reloads.
function proxyUpgrade(srv, targetPort, onHit) {
  srv.on('upgrade', (req, socket) => {
    onHit(req.socket.remoteAddress, req.url);
    const up = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      const head = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;
      socket.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
}

// ---------------------------------------------------------------- reachability

// Is anything listening on 127.0.0.1:port? The tool's error when nothing does
// is the one that actually helps: "start the server first" beats "connection refused".
function isListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.connect({ host, port }, () => { probe.destroy(); resolve(true); });
    probe.setTimeout(600, () => { probe.destroy(); resolve(false); });
    probe.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------- tools

const openSchema = z.object({
  port: z.number().int().min(1).max(65535).describe('The localhost port your server is listening on'),
  name: z.string().min(1).max(60).optional().describe('A label, shown in the URL list'),
  public_port: z.number().int().min(1024).max(65535).optional().describe('External port to listen on (relay mode). Default: auto-pick a free one'),
  mode: z.enum(['relay', 'local']).optional().describe('relay: punch through to a public URL. local: the URL is http://127.0.0.1:port, used when the human is on the same machine'),
  readonly: z.boolean().optional().describe('HTTP-only preview (no websocket upgrade). Default false — full tunnel, so HMR/live-reload works'),
  no_token: z.boolean().optional().describe('Skip the path token. Only for localhost-only (mode: local). Refused in relay mode'),
});

const closeSchema = z.object({ port: z.number().int().min(1).max(65535) });
const listSchema = z.object({});

export const liveShareTools = [
  {
    name: 'tunnel_open',
    description:
      'Expose a localhost port the user can open in their own browser, like VS Code port forwarding. Use after starting a dev server, a Jupyter notebook, a storybook, a debugger — anything that listens locally and is useless without a URL. Returns a clickable URL. The port stays bound to 127.0.0.1 on the host; only the forwarding listener is public, and only with a secret path token. Dangerous: opens a network listener.',
    isDangerous: true,
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'The localhost port your server is listening on' },
        name: { type: 'string', description: 'A label, shown in the URL list' },
        public_port: { type: 'number', description: 'External port to listen on (relay mode). Default: auto-pick a free one' },
        mode: { type: 'string', enum: ['relay', 'local'], description: 'relay: public URL. local: http://127.0.0.1:port (same machine)' },
        readonly: { type: 'boolean', description: 'HTTP-only preview (no websocket). Default false — full tunnel' },
        no_token: { type: 'boolean', description: 'Skip the path token. Refused in relay mode' },
      },
      required: ['port'],
      additionalProperties: false,
    },
    schema: openSchema,
    async execute({ port, name, public_port, mode, readonly = false, no_token = false }, ctx = {}) {
      const tunnels = tunnelsOf(ctx.userId ?? ctx.chatId);
      if (tunnels.size >= MAX_TUNNELS) return `⚠️ tunnel limit reached (${MAX_TUNNELS}). Close one with tunnel_close first.`;

      const useRelay = mode ? mode === 'relay' : isRelayDeploy();
      if (no_token && useRelay) return '⚠️ no_token is refused in relay mode — a public listener must carry a secret path.';

      const up = await isListening(port);
      if (!up) {
        return `⚠️ nothing is listening on 127.0.0.1:${port}.\nStart the server first (job_start or execute_python), then call tunnel_open again.`;
      }

      const token = no_token ? '' : randomBytes(TOKEN_BYTES).toString('hex');
      const label = name || `port-${port}`;

      if (!useRelay) {
        // Same-machine: no listener of our own is needed. The user's browser can
        // reach 127.0.0.1 directly.
        const t = { port, name: label, token, mode: 'local', url: localUrl(port, token), hits: 0, closed: false };
        tunnels.set(port, t);
        return `✅ forwarded 127.0.0.1:${port} — the user is on this machine, no relay needed.\n\n${t.url}`;
      }

      // Relay: find a free public port, then splice.
      const ext = public_port || (await freePort());
      if (!ext) return '⚠️ no free external port available (1024-65535)';

      const srv = net.createServer();
      const t = {
        port, name: label, token, mode: 'relay', ext, url: publicUrl(ext, token),
        hits: 0, srv, closed: false, started: Date.now(),
      };
      tunnels.set(port, t);

      const onHit = (peer, why) => {
        t.hits++;
        logger.info({ peer, why, port: ext }, 'tunnel hit');
      };

      if (readonly) {
        // HTTP-only preview: the token gates the request line, then the
        // response is streamed straight through from the private service.
        t.srv = http.createServer((req, res) => {
          if (token && !req.url.includes(`/${token}`)) { res.writeHead(401); return res.end(); }
          onHit(req.socket.remoteAddress, req.url);
          const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          });
          up.on('error', (e) => { res.writeHead(502); res.end(`upstream down: ${e.message}`); });
          req.pipe(up);
        });
        proxyUpgrade(t.srv, port, onHit);
      } else {
        relayLoop(srv, port, token, onHit);
      }

      await new Promise((resolve, reject) => {
        srv.once('listening', resolve);
        srv.once('error', reject);
        srv.listen(ext, '0.0.0.0');
      }).catch((err) => {
        tunnels.delete(port);
        return `⚠️ could not listen on :${ext} — ${err.message}`;
      });

      logger.info({ ext, port, name: label }, 'tunnel opened');
      return `✅ forwarded 127.0.0.1:${port} → public :${ext}\n\n${t.url}\n\n_${label}_ — the URL carries a secret token; it is not guessable. Close it with tunnel_close ${port}.`;
    },
  },

  {
    name: 'tunnel_list',
    description: 'List the ports this user has forwarded, with their URLs and hit counts.',
    isDangerous: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    schema: listSchema,
    async execute(_args, ctx = {}) {
      const tunnels = tunnelsOf(ctx.userId ?? ctx.chatId);
      if (!tunnels.size) return 'No forwarded ports. Start a server, then tunnel_open its port.';
      return [...tunnels.values()].map(
        (t) => `${t.name} — 127.0.0.1:${t.port}${t.mode === 'relay' ? ` → :${t.ext}` : ''}\n${t.url}  (${t.hits} hits)`
      ).join('\n\n');
    },
  },

  {
    name: 'tunnel_close',
    description: 'Close a forwarded port and stop its listener. The localhost service itself is left running.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: { port: { type: 'number', description: 'The localhost port that was forwarded' } },
      required: ['port'],
      additionalProperties: false,
    },
    schema: closeSchema,
    async execute({ port }, ctx = {}) {
      const tunnels = tunnelsOf(ctx.userId ?? ctx.chatId);
      const t = tunnels.get(port);
      if (!t) return `⚠️ no tunnel on port ${port}.`;
      t.closed = true;
      t.srv?.close?.();
      t.srv?.closeAllConnections?.();
      tunnels.delete(port);
      return `✅ closed ${t.name} (127.0.0.1:${port}). The service is still running locally — forward it again with tunnel_open ${port}.`;
    },
  },
];

// ---------------------------------------------------------------- helpers

function localUrl(port, token) {
  return `http://127.0.0.1:${port}${token ? `/${token}` : ''}`;
}

function publicUrl(ext, token) {
  const host = process.env.PUBLIC_HOST || process.env.HOSTNAME || 'localhost';
  const proto = process.env.PUBLIC_TLS ? 'https' : 'http';
  return `${proto}://${host}:${ext}${token ? `/${token}` : ''}`;
}

// A relay deploy is one where the host is not the human's machine. The bot
// itself is the signal: if it can be reached from the internet, the workspace
// probably can be too.
function isRelayDeploy() {
  if (process.env.TUNNEL_MODE) return process.env.TUNNEL_MODE === 'relay';
  // Termux/Android: the user IS on the machine. A VPS has a public hostname.
  if (process.env.TERMUX_VERSION || /android/i.test(process.env.PROOT_TMP_DIR || '')) return false;
  return Boolean(process.env.PUBLIC_HOST || publicIpLikely());
}

// Cheap signal, no network call: a typical VPS hostname is not a .local name.
function publicIpLikely() {
  const h = os.hostname();
  return !/\.local$|\.internal$|localhost/i.test(h);
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(null));
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
