import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ClientErrorLoggerOptions {
  /**
   * Endpoint used by the injected script to POST client-side errors.
   * @default '/__client-error'
   */
  endpoint?: string;
  /**
   * Directory (relative to process.cwd) where logs are stored.
   * @default '.logs'
   */
  logDir?: string;
  /**
   * File name for appended client error logs.
   * @default 'client-errors.log'
   */
  logFileName?: string;
  /**
   * Whether `console.warn` should also be captured. Errors are always captured.
   * @default false
   */
  captureConsoleWarn?: boolean;
  /**
   * Maximum request body size accepted from the browser (bytes).
   * @default 64_000 (≈ 64KB)
   */
  maxBodySize?: number;
}

type RawPayload = {
  type?: string;
  message?: unknown;
  stack?: unknown;
  args?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  href?: unknown;
};

type NormalisedPayload = {
  type: string;
  message: string;
  stack?: string;
  args?: string[];
  filename?: string;
  lineno?: number;
  colno?: number;
  href?: string;
};

const DEFAULT_OPTIONS = {
  endpoint: '/__client-error',
  logDir: '.logs',
  logFileName: 'client-errors.log',
  captureConsoleWarn: false,
  maxBodySize: 64_000,
} satisfies Required<ClientErrorLoggerOptions>;

const ENTRY_DELIMITER = '##__CLIENT_ERROR_LOGGER_ENTRY__##';
const INSTALL_GUARD = '__CLIENT_ERROR_LOGGER_INSTALLED__';

class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Payload exceeds ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

const readBody = async (req: IncomingMessage, maxSize: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxSize) {
        req.destroy();
        reject(new PayloadTooLargeError(maxSize));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
};

const toStringSafe = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error && value.stack) return value.stack;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toNumberSafe = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalisePayload = (raw: RawPayload): NormalisedPayload => {
  const args = Array.isArray(raw.args)
    ? raw.args.map(toStringSafe).filter((item): item is string => Boolean(item))
    : undefined;

  return {
    type: toStringSafe(raw.type) ?? 'error',
    message: toStringSafe(raw.message) ?? '',
    stack: toStringSafe(raw.stack),
    args,
    filename: toStringSafe(raw.filename),
    lineno: toNumberSafe(raw.lineno),
    colno: toNumberSafe(raw.colno),
    href: toStringSafe(raw.href),
  };
};

const formatLogEntry = (payload: NormalisedPayload, timestamp: Date): string => {
  const lines = [
    ENTRY_DELIMITER,
    `[${timestamp.toISOString()}] ${payload.type} ${payload.message}`.trimEnd(),
    payload.stack,
    payload.args && payload.args.length ? `args:${JSON.stringify(payload.args)}` : undefined,
    `filename:${payload.filename ?? ''} line:${payload.lineno ?? ''}:${payload.colno ?? ''}`,
    `url:${payload.href ?? ''}`,
    '',
  ];

  return lines.filter((line) => line !== undefined).join('\n');
};

const createClientScript = (endpoint: string, captureConsoleWarn: boolean): string => {
  const warnPatch = captureConsoleWarn
    ? `
    var origWarn = console.warn;
    console.warn = function () {
      try {
        send({
          type: 'console.warn',
          args: Array.prototype.slice.call(arguments).map(stringify)
        });
      } catch (_) {}
      return origWarn.apply(console, arguments);
    };`
    : '';

  return `
(function () {
  if (typeof window === 'undefined') return;
  if (window.${INSTALL_GUARD}) return;
  Object.defineProperty(window, '${INSTALL_GUARD}', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  var endpoint = ${JSON.stringify(endpoint)};

  function stringify(value) {
    try {
      if (value == null) return String(value);
      if (value && value.stack) return value.stack;
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
    } catch (_) {
      try { return String(value); } catch (_) { return '[unserialisable]'; }
    }
  }

  function send(payload) {
    try {
      var base = {
        href: location.href
      };
      var body = JSON.stringify(Object.assign(base, payload));
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (_) {}
  }

  window.addEventListener('error', function (event) {
    try {
      send({
        type: 'error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error && event.error.stack
      });
    } catch (_) {}
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event.reason || {};
      send({
        type: 'unhandledrejection',
        message: reason && reason.message ? reason.message : stringify(reason),
        stack: reason && reason.stack
      });
    } catch (_) {}
  });

  (function () {
    var origError = console.error;
    console.error = function () {
      try {
        send({
          type: 'console.error',
          args: Array.prototype.slice.call(arguments).map(stringify)
        });
      } catch (_) {}
      return origError.apply(console, arguments);
    };
    ${warnPatch}
  })();
})();`;
};

const resolveOptions = (options: ClientErrorLoggerOptions = {}): Required<ClientErrorLoggerOptions> => ({
  endpoint: options.endpoint ?? DEFAULT_OPTIONS.endpoint,
  logDir: options.logDir ?? DEFAULT_OPTIONS.logDir,
  logFileName: options.logFileName ?? DEFAULT_OPTIONS.logFileName,
  captureConsoleWarn: options.captureConsoleWarn ?? DEFAULT_OPTIONS.captureConsoleWarn,
  maxBodySize: options.maxBodySize ?? DEFAULT_OPTIONS.maxBodySize,
});

export function vitePluginClientErrorLogger(options?: ClientErrorLoggerOptions): Plugin {
  const resolved = resolveOptions(options);
  const logDirPath = path.resolve(process.cwd(), resolved.logDir);
  const logFilePath = path.join(logDirPath, resolved.logFileName);
  const logDirReady = fs.mkdir(logDirPath, { recursive: true });

  return {
    name: 'vite-plugin-client-error-logger',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      server.middlewares.use(resolved.endpoint, (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Only POST is allowed');
          return;
        }

        readBody(req, resolved.maxBodySize)
          .then(async (body) => {
            await logDirReady;
            let raw: RawPayload;
            try {
              raw = JSON.parse(body || '{}');
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Invalid JSON payload');
              return;
            }

            const payload = normalisePayload(raw);
            const entry = formatLogEntry(payload, new Date());
            try {
              await fs.appendFile(logFilePath, entry, 'utf8');
              res.statusCode = 204;
              res.end();
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Failed to write log file');
              server.config.logger.error(`[client-error-logger] Failed to append log: ${(err as Error).message}`);
            }
          })
          .catch((error) => {
            if (error instanceof PayloadTooLargeError) {
              res.statusCode = 413;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Payload too large');
            } else {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Failed to read request body');
              server.config.logger.error(`[client-error-logger] Request body read failed: ${(error as Error).message}`);
            }
          });
      });
    },

    transformIndexHtml(html: string) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head',
            children: createClientScript(resolved.endpoint, resolved.captureConsoleWarn),
          },
        ],
      };
    },
  };
}

export const clientErrorLogger = vitePluginClientErrorLogger;

export default vitePluginClientErrorLogger;
