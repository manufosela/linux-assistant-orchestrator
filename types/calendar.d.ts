/**
 * A single calendar event (read-only representation).
 */
export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees?: string[];
  isAllDay: boolean;
}

/**
 * Summary of a day's calendar events.
 */
export interface CalendarDaySummary {
  date: string;
  eventCount: number;
  summaryText: string;
  events: CalendarEvent[];
}

/**
 * Abstract read-only calendar client interface.
 */
export interface CalendarClient {
  getTodayEvents(): Promise<CalendarEvent[]>;
  getUpcomingEvents(days?: number): Promise<CalendarEvent[]>;
  getEventById(eventId: string): Promise<CalendarEvent | null>;
}
