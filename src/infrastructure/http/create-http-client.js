/**
 * Creates a simple HTTP client wrapping the native fetch API.
 * Supports configurable timeouts and base URLs.
 *
 * @param {{ baseUrl?: string, defaultTimeoutMs?: number, defaultHeaders?: Record<string, string> }} options
 * @returns {HttpClient}
 */
export function createHttpClient({
  baseUrl = '',
  defaultTimeoutMs = 30000,
  defaultHeaders = {},
} = {}) {
  /**
   * Performs a GET request and returns parsed JSON.
   *
   * @param {string} path
   * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options]
   * @returns {Promise<unknown>}
   */
  async function get(path, options = {}) {
    return request('GET', path, undefined, options);
  }

  /**
   * Performs a POST request with a JSON body and returns parsed JSON.
   *
   * @param {string} path
   * @param {unknown} body
   * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options]
   * @returns {Promise<unknown>}
   */
  async function post(path, body, options = {}) {
    return request('POST', path, body, options);
  }

  /**
   * Core request function.
   *
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options]
   * @returns {Promise<unknown>}
   */
  async function request(method, path, body, options = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...defaultHeaders,
          ...(options.headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpError(response.status, errorText, url);
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { get, post };
}

/**
 * Represents an HTTP error response.
 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} body
   * @param {string} url
   */
  constructor(statusCode, body, url) {
    super(`HTTP ${statusCode} from ${url}`);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
    this.url = url;
  }
}

/**
 * @typedef {Object} HttpClient
 * @property {(path: string, options?: object) => Promise<unknown>} get
 * @property {(path: string, body: unknown, options?: object) => Promise<unknown>} post
 */
