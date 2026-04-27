/**
 * A single email message (read-only representation).
 */
export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  snippet: string;
  isRead: boolean;
  isImportant: boolean;
  labels?: string[];
}

/**
 * Query parameters for fetching emails.
 */
export interface EmailQuery {
  maxResults?: number;
  query?: string;
  labelIds?: string[];
  unreadOnly?: boolean;
}

/**
 * Summary produced by the email summary service.
 */
export interface EmailSummary {
  totalFetched: number;
  importantCount: number;
  summaryText: string;
  highlights: string[];
}

/**
 * Abstract read-only email client interface.
 * No write operations are permitted.
 */
export interface EmailClient {
  fetchUnread(query?: EmailQuery): Promise<EmailMessage[]>;
  fetchImportant(query?: EmailQuery): Promise<EmailMessage[]>;
  fetchByQuery(query: EmailQuery): Promise<EmailMessage[]>;
}
