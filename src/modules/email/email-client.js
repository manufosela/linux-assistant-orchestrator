/**
 * Email client placeholder.
 *
 * Real implementations will support Gmail API and Microsoft Graph.
 * This module is read-only: it must never send, delete, archive, or modify emails.
 *
 * @returns {import('../../../types/email.js').EmailClient}
 */
export function createEmailClient() {
  /**
   * @param {import('../../../types/email.js').EmailQuery} [query]
   * @returns {Promise<import('../../../types/email.js').EmailMessage[]>}
   */
  async function fetchUnread(query) {
    void query;
    throw new EmailNotImplementedError('fetchUnread');
  }

  /**
   * @param {import('../../../types/email.js').EmailQuery} [query]
   * @returns {Promise<import('../../../types/email.js').EmailMessage[]>}
   */
  async function fetchImportant(query) {
    void query;
    throw new EmailNotImplementedError('fetchImportant');
  }

  /**
   * @param {import('../../../types/email.js').EmailQuery} query
   * @returns {Promise<import('../../../types/email.js').EmailMessage[]>}
   */
  async function fetchByQuery(query) {
    void query;
    throw new EmailNotImplementedError('fetchByQuery');
  }

  return { fetchUnread, fetchImportant, fetchByQuery };
}

export class EmailNotImplementedError extends Error {
  /** @param {string} operation */
  constructor(operation) {
    super(`Email integration not implemented: ${operation}. Set EMAIL_PROVIDER to enable.`);
    this.name = 'EmailNotImplementedError';
  }
}
