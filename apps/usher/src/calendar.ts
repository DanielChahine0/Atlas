/**
 * calendar.ts — Google Calendar event add for Usher (after confirmed registration).
 *
 * Usher adds an event to Google Calendar via the mcp-google service binding after
 * scraping a valid confirmation number. This is the authorized Calendar write path.
 *
 * Scope: calendar.events (add only — NO delete, per Pillar 2).
 * The calendar.events scope is the same one Sundial uses for task→calendar sync.
 *
 * Security invariants (T-04-32):
 *   - Calendar add fires ONLY after a non-empty confirmation_number is scraped.
 *   - No delete or edit of existing calendar events.
 *   - Hard stops (captcha, payment, etc.) never reach this path.
 */

// ─── Calendar event builder ────────────────────────────────────────────────────

/** Minimal shape for adding an event via mcp-google's calendar.events tool. */
export interface CalendarEventInput {
  /** Event title (e.g. "AWS Summit Toronto 2026"). */
  title: string;
  /** Start datetime in ISO 8601 (e.g. "2026-09-15T09:00:00-04:00"). */
  start: string;
  /** End datetime in ISO 8601 (e.g. "2026-09-15T17:00:00-04:00"). */
  end: string;
  /** Optional description — may include the confirmation number. */
  description?: string;
  /** Optional location. */
  location?: string;
  /** Private extended property to tag this event as Usher-managed. */
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

/** The mcp-google service binding surface Usher uses for calendar.events add. */
export interface CalendarTools {
  /**
   * Create a calendar event. Throws on failure.
   * This is a pass-through to mcp-google's calendar_create_event tool
   * (or equivalent — injected in tests via a stub).
   */
  createEvent(input: CalendarEventInput): Promise<{ eventId: string }>;
}

// ─── Add event after confirmed registration ────────────────────────────────────

/**
 * Add a confirmed event to Google Calendar.
 *
 * Called ONLY after a non-empty confirmation_number is scraped (T-04-32 gating).
 * Annotates the event with agent=usher so it can be identified as Usher-managed.
 *
 * @param tools            Injected CalendarTools (real mcp-google binding in prod, stub in tests).
 * @param eventTitle       The event title to display in Calendar.
 * @param eventStart       ISO 8601 start datetime.
 * @param eventEnd         ISO 8601 end datetime (same as start if unknown → 1h default).
 * @param confirmationNum  The scraped registration confirmation number.
 * @param location         Optional event location.
 * @returns                The created calendar eventId.
 */
export async function addEventToCalendar(
  tools: CalendarTools,
  eventTitle: string,
  eventStart: string,
  eventEnd: string,
  confirmationNum: string,
  location?: string,
): Promise<string> {
  const result = await tools.createEvent({
    title: eventTitle,
    start: eventStart,
    end: eventEnd,
    description: `Registered via Atlas Usher. Confirmation: ${confirmationNum}`,
    location: location,
    extendedProperties: {
      private: {
        agent: "usher",
        confirmation: confirmationNum,
      },
    },
  });
  return result.eventId;
}
