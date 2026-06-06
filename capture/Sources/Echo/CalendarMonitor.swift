// CalendarMonitor.swift — EventKit calendar monitor for Echo arm triggers
//
// DESIGN (D3-03):
//   CalendarMonitor watches EKEventStore for upcoming calendar events that contain
//   a video conferencing link (isVideoConference) or are flagged as audio-active.
//   When such an event is detected within an arm window (e.g. 5 minutes before start),
//   it calls ConsentGate.arm(reason:) to show the consent prompt.
//
// PRIVACY: CalendarMonitor reads calendar data only. It never writes to the calendar
//   (only Sundial/Usher have calendar.events write scope — pillar 1). All event access
//   is local via EventKit and never transmitted as raw data. Only the event TITLE is
//   passed to ConsentGate.arm() as the session reason.
//
// PERMISSION: EKEntityType.event requires fullAccess on macOS 14+.
//   NSCalendarsFullAccessUsageDescription must be in Info.plist (managed by AtlasCapture
//   target's entitlements/plist, not this file).
//
// ARM WINDOW: By default, arm 5 minutes before the event starts. If the daemon starts
//   mid-event (within the event's time range), arm immediately.

import EventKit
import Foundation
import Shared

// MARK: - CalendarMonitor delegate

/// Receives arm-trigger notifications from CalendarMonitor.
public protocol CalendarMonitorDelegate: AnyObject, Sendable {
    /// Called when a qualifying calendar event is about to start (or already started).
    /// - Parameter title: The event title — used as the ConsentGate arm reason.
    func calendarMonitor(_ monitor: CalendarMonitor, didDetectEvent title: String)
}

// MARK: - CalendarMonitor

/// Monitors the local EventKit calendar store for video-conference events
/// and fires arm triggers to ConsentGate.
///
/// THREAD SAFETY: EventKit delivers EKEventStoreChangedNotification on an unspecified
/// queue. This class serializes all EK accesses on its internal queue.
public final class CalendarMonitor: @unchecked Sendable {

    // MARK: - Configuration

    /// How many seconds before an event starts to arm the gate.
    public static let armWindowSeconds: TimeInterval = 5 * 60

    // MARK: - State

    private let eventStore = EKEventStore()
    private let queue = DispatchQueue(label: "com.atlas.capture.calendarmonitor")
    private var notificationObserver: Any?
    private var checkTimer: DispatchSourceTimer?
    private var armedEventIDs = Set<String>()

    // MARK: - Delegate

    public weak var delegate: (any CalendarMonitorDelegate)?

    // MARK: - Init / deinit

    public init() {}

    deinit {
        stop()
    }

    // MARK: - Start / Stop

    /// Request calendar access and begin monitoring.
    ///
    /// On macOS 14+ this calls requestFullAccessToEvents(). The permission prompt
    /// appears only once (EventKit caches the decision). If denied, the monitor
    /// silently does nothing (callers can check EKAuthorizationStatus separately).
    public func start() {
        Task {
            await self.requestAccessAndBeginMonitoring()
        }
    }

    /// Stop monitoring and invalidate timers.
    public func stop() {
        queue.sync {
            checkTimer?.cancel()
            checkTimer = nil
            if let obs = notificationObserver {
                NotificationCenter.default.removeObserver(obs)
                notificationObserver = nil
            }
        }
    }

    // MARK: - Private: access + monitoring

    private func requestAccessAndBeginMonitoring() async {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .fullAccess:
            beginMonitoring()
        case .notDetermined:
            do {
                let granted = try await eventStore.requestFullAccessToEvents()
                if granted { beginMonitoring() }
            } catch {
                let incident = RawIncident(
                    severity: "P3",
                    kind: "echo.calendar.access-error",
                    sourceAgent: "Echo",
                    note: "EventKit access request failed: \(error.localizedDescription)"
                )
                await IncidentRelay.shared.emit(incident)
            }
        case .denied, .restricted:
            // User denied calendar access. Monitor silently does nothing.
            // An incident would be too noisy — the system privacy preference is the gate.
            break
        case .writeOnly:
            // writeOnly is insufficient — need fullAccess.
            break
        @unknown default:
            break
        }
    }

    private func beginMonitoring() {
        queue.async { [weak self] in
            guard let self else { return }

            // Observe EKEventStoreChangedNotification for calendar changes.
            let obs = NotificationCenter.default.addObserver(
                forName: .EKEventStoreChanged,
                object: self.eventStore,
                queue: nil
            ) { [weak self] _ in
                self?.checkUpcomingEvents()
            }
            self.notificationObserver = obs

            // Check immediately (catch mid-event daemon start).
            self.checkUpcomingEvents()

            // Also poll on a 60-second timer (arm-window edge detection).
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 60, repeating: 60.0)
            timer.setEventHandler { [weak self] in
                self?.checkUpcomingEvents()
            }
            timer.resume()
            self.checkTimer = timer
        }
    }

    // MARK: - Private: event check

    private func checkUpcomingEvents() {
        // Search a 90-minute window (arm-window + meeting duration headroom).
        let now = Date()
        let windowEnd = now.addingTimeInterval(Self.armWindowSeconds + 90 * 60)

        // EKEventStore date-range predicate (local EventKit, no network).
        let calendars = eventStore.calendars(for: .event)
        let predicate = eventStore.predicateForEvents(
            withStart: now.addingTimeInterval(-Self.armWindowSeconds),
            end: windowEnd,
            calendars: calendars.isEmpty ? nil : calendars
        )
        let events = eventStore.events(matching: predicate)

        for event in events {
            guard let eventID = event.eventIdentifier else { continue }
            // Skip already-armed events.
            guard !armedEventIDs.contains(eventID) else { continue }

            // Arm if this is a video-conference event or explicitly flagged audio-active.
            // hasVideoConferenceURL: checks event URL or notes for conferencing links.
            let shouldArm = hasVideoConferenceURL(event) || hasAudioActiveNote(event)

            guard shouldArm else { continue }

            // Arm if within the arm window or already started.
            let secondsUntilStart = event.startDate.timeIntervalSinceNow
            let alreadyStarted = event.startDate <= now && event.endDate >= now
            let nearlyStarting = secondsUntilStart <= Self.armWindowSeconds && secondsUntilStart >= -60

            guard alreadyStarted || nearlyStarting else { continue }

            armedEventIDs.insert(eventID)
            let title = event.title ?? "Meeting"
            let del = delegate
            DispatchQueue.main.async {
                del?.calendarMonitor(self, didDetectEvent: title)
            }
        }
    }

    /// Returns true if the event has a URL or notes containing a video conference link.
    /// Checks for common conferencing patterns: Zoom, Google Meet, Teams, Webex.
    private func hasVideoConferenceURL(_ event: EKEvent) -> Bool {
        let videoPatterns = ["zoom.us/j/", "meet.google.com/", "teams.microsoft.com/l/meetup",
                             "webex.com/meet/", "webex.com/join/", "chime.aws/",
                             "whereby.com/", "us02web.zoom.us/"]
        // Check the event URL.
        if let urlString = event.url?.absoluteString {
            for pattern in videoPatterns where urlString.contains(pattern) {
                return true
            }
        }
        // Check event notes for embedded links.
        if let notes = event.notes {
            for pattern in videoPatterns where notes.contains(pattern) {
                return true
            }
        }
        return false
    }

    /// Returns true if the event notes contain the `#atlas-audio-active` tag.
    private func hasAudioActiveNote(_ event: EKEvent) -> Bool {
        guard let notes = event.notes else { return false }
        return notes.contains("#atlas-audio-active")
    }
}
