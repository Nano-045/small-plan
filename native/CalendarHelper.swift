import EventKit
import Foundation

private struct Registry: Codable {
    var sources: [String: [String: String]] = [:]
    var ids: Set<String> { Set(sources.values.flatMap { $0.values }) }

    static var path: URL {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return (0..<4).reduce(executable) { result, _ in result.deletingLastPathComponent() }
            .appendingPathComponent("owned-calendars.json")
    }

    static func load() throws -> Registry {
        guard FileManager.default.fileExists(atPath: path.path) else { return Registry() }
        do {
            return try JSONDecoder().decode(Registry.self, from: Data(contentsOf: path))
        } catch {
            throw BridgeFailure("The Small Plan Calendar ownership registry could not be read.")
        }
    }

    func save() throws {
        try JSONEncoder().encode(self).write(to: Self.path, options: .atomic)
    }
}

private func authorization() -> String {
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return "pending"      // notDetermined
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "authorized"   // authorized on older macOS, fullAccess on macOS 14+
    case 4: return "write_only"
    default: return "unavailable"
    }
}

private func discoverAuthorization(_ store: EKEventStore) -> String {
    let status = authorization()
    guard status == "pending" || status == "write_only" else { return status }
    var result: String?
    let complete: @Sendable (Bool, Error?) -> Void = { _, error in
        DispatchQueue.main.async {
            if error != nil && authorization() == "pending" {
                result = "unavailable"
            } else {
                result = authorization()
            }
        }
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: complete)
    } else {
        store.requestAccess(to: .event, completion: complete)
    }
    let deadline = Date().addingTimeInterval(80)
    while result == nil && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return result ?? "pending"
}

private func isICloud(_ source: EKSource?) -> Bool {
    guard let source else { return false }
    // EventKit exposes source type and display title, without a provider/account ID.
    // Require both known iCloud properties and let the user select the exact ID.
    return source.sourceType == .calDAV && source.title == "iCloud"
}

private func calendars(_ store: EKEventStore, registry: Registry) -> [[String: Any]] {
    return store.calendars(for: .event).map { calendar in
        ["id": calendar.calendarIdentifier, "title": calendar.title,
         "source_id": calendar.source.sourceIdentifier,
         "writable": calendar.allowsContentModifications,
         "owned": registry.ids.contains(calendar.calendarIdentifier)]
    }
}

private func sources(_ store: EKEventStore) -> [[String: Any]] {
    store.sources.map { source in
        ["id": source.sourceIdentifier, "title": source.title,
         "type": isICloud(source) ? "icloud" : "other",
         "writable": isICloud(source) && source.calendars(for: .event).contains { $0.allowsContentModifications }]
    }
}

private func ownedCalendar(_ kind: String, store: EKEventStore, source: EKSource,
                           registry: inout Registry) throws -> EKCalendar {
    let sourceID = source.sourceIdentifier
    if let id = registry.sources[sourceID]?[kind] {
        guard let calendar = store.calendar(withIdentifier: id),
              calendar.source.sourceIdentifier == sourceID, calendar.allowsContentModifications else {
            throw BridgeFailure("Calendar conflict. A Small Plan calendar is missing or read-only.")
        }
        return calendar
    }
    let title = kind == "block" ? "Small Plan — Plan" : "Small Plan — Actual"
    guard !source.calendars(for: .event).contains(where: { $0.title == title }) else {
        throw BridgeFailure("Calendar conflict. A calendar named \(title) exists without local proof of ownership.")
    }
    let calendar = EKCalendar(for: .event, eventStore: store)
    calendar.title = title
    calendar.source = source
    try store.saveCalendar(calendar, commit: true)
    registry.sources[sourceID, default: [:]][kind] = calendar.calendarIdentifier
    try registry.save()
    return calendar
}

private func readSelected(_ selected: Set<String>, registry: Registry, store: EKEventStore,
                          window: DateWindow) throws -> [[String: Any]] {
    let readIDs = selected.subtracting(registry.ids)
    guard !readIDs.isEmpty else { return [] }
    let selectedCalendars = store.calendars(for: .event).filter { readIDs.contains($0.calendarIdentifier) }
    guard selectedCalendars.count == readIDs.count else {
        throw BridgeFailure("Calendar selection changed. Discover calendars again before syncing.")
    }
    let predicate = store.predicateForEvents(withStart: window.start, end: window.end, calendars: selectedCalendars)
    var unique: [String: [String: Any]] = [:]
    store.enumerateEvents(matching: predicate) { event, stop in
        guard unique.count < 5001 else { stop.pointee = true; return }
        guard let calendarID = event.calendar?.calendarIdentifier,
              let start = event.startDate, let end = event.endDate, end > start,
              CalendarMarker(event.url) == nil else { return }
        let identity = event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? event.calendarItemIdentifier
        let occurrence = event.hasRecurrenceRules ? isoSeconds.string(from: event.occurrenceDate ?? start) : ""
        let id = digest([calendarID, identity, occurrence])
        let title = (event.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        unique[id] = ["id": id, "title": title.isEmpty ? "Busy" : String(title.prefix(240)),
                      "calendar_id": calendarID, "start_at": isoSeconds.string(from: start),
                      "end_at": isoSeconds.string(from: end), "all_day": event.isAllDay]
    }
    guard unique.count <= 5000 else {
        throw BridgeFailure("Calendar selection returned over 5,000 events. Choose fewer calendars or a shorter range.")
    }
    return unique.values.sorted {
        ($0["start_at"] as? String ?? "", $0["id"] as? String ?? "") <
        ($1["start_at"] as? String ?? "", $1["id"] as? String ?? "")
    }
}

private func eventHash(_ event: EKEvent) -> String {
    digest([
        event.title ?? "", event.startDate.map(isoSeconds.string(from:)) ?? "",
        event.endDate.map(isoSeconds.string(from:)) ?? "",
        event.isAllDay ? "allday" : "timed", event.location ?? "", event.notes ?? "",
        event.hasAlarms ? "alarms" : "", event.hasAttendees ? "attendees" : "",
        event.hasRecurrenceRules ? "recurrence" : ""
    ])
}

private struct ConfirmableCalendarEdit: Error {
    let snapshot: [String: String]
}

private func syncJob(_ job: [String: Any], link: [String: Any], store: EKEventStore,
                     calendar: EKCalendar) throws -> [String: Any] {
    guard let id = job["id"], let operation = job["operation"] as? String,
          ["upsert", "delete"].contains(operation),
          let kind = job["record_kind"] as? String, let recordID = job["record_id"] as? String,
          let desired = job["hash"] as? String, CalendarMarker.validHash(desired) else {
        throw BridgeFailure("The Calendar outbox job is malformed.")
    }
    let key = digest([kind, recordID])
    let mapping = (job["event_id"] as? String) ?? (link["event_id"] as? String)
    let mappedCalendar = (job["calendar_id"] as? String) ?? (link["calendar_id"] as? String)
    let lastSynced = (job["last_synced_hash"] as? String) ?? (link["last_synced_hash"] as? String)
    if let mappedCalendar, mappedCalendar != calendar.calendarIdentifier {
        throw BridgeFailure("Calendar conflict. This event is linked to a different Small Plan calendar.")
    }
    let start = parseInstant(job["start_at"] as? String)
    let end = parseInstant(job["end_at"] as? String)
    let confirmation = job["confirmed_conflict_token"] as? String
    let mapped = mapping.flatMap { store.event(withIdentifier: $0) }
    if let mapped {
        guard mapped.refresh(), mapped.eventIdentifier == mapping,
              mapped.calendar?.calendarIdentifier == calendar.calendarIdentifier,
              CalendarMarker(mapped.url)?.key == key else {
            throw BridgeFailure("Calendar conflict. The mapped event was moved or its marker was changed.")
        }
    }
    var matches: [String: EKEvent] = [:]
    func findMarkers(start: Date, end: Date) {
        let pad = TimeInterval(31 * 24 * 3600)
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-pad),
                                                end: end.addingTimeInterval(pad), calendars: [calendar])
        for match in store.events(matching: predicate) where CalendarMarker(match.url)?.key == key {
            if let id = match.eventIdentifier { matches[id] = match }
        }
    }
    if let start, let end, start < end { findMarkers(start: start, end: end) }
    if let mapped, let remoteStart = mapped.startDate, let remoteEnd = mapped.endDate {
        // A move within the owned calendar can put the mapped event outside
        // the normal recovery window. Check for duplicate markers there too.
        if start.map({ abs($0.timeIntervalSince(remoteStart)) > 3600 }) ?? true {
            findMarkers(start: remoteStart, end: remoteEnd)
        }
        if let id = mapped.eventIdentifier { matches[id] = mapped }
    }
    let existingID = try resolveManagedEventID(mapped: mapping, exact: mapped?.eventIdentifier,
                                               matches: Set(matches.keys))
    let existing = existingID.flatMap { matches[$0] }

    func result(_ eventID: String?) -> [String: Any] {
        var output: [String: Any] = ["id": id, "calendar_id": calendar.calendarIdentifier]
        if let eventID { output["event_id"] = eventID }
        return output
    }

    if let existing {
        guard existing.refresh(), existing.eventIdentifier == existingID,
              existing.calendar?.calendarIdentifier == calendar.calendarIdentifier,
              let marker = CalendarMarker(existing.url), marker.key == key else {
            throw BridgeFailure("Calendar conflict. The event moved, disappeared, or its marker changed.")
        }
        let actualHash = eventHash(existing)
        let action: String
        if marker.remoteHash != actualHash {
            guard let mapped, let eventID = mapped.eventIdentifier, eventID == existing.eventIdentifier,
                  !existing.hasAttendees, !existing.hasRecurrenceRules, !existing.isDetached,
                  let remoteStart = existing.startDate, let remoteEnd = existing.endDate else {
                throw BridgeFailure("Calendar conflict. This event cannot be safely overwritten from Small Plan.")
            }
            let modification = existing.lastModifiedDate.map { String($0.timeIntervalSinceReferenceDate) } ?? ""
            let token = try marker.conflictToken(calendarID: calendar.calendarIdentifier, eventID: eventID,
                                                  actualHash: actualHash, modification: modification,
                                                  operation: operation, desired: desired, lastSynced: lastSynced)
            if confirmation != token {
                let title = (existing.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                throw ConfirmableCalendarEdit(snapshot: [
                    "token": token, "title": title.isEmpty ? "Busy" : String(title.prefix(240)),
                    "start_at": isoSeconds.string(from: remoteStart),
                    "end_at": isoSeconds.string(from: remoteEnd)
                ])
            }
            action = operation
        } else {
            action = try marker.action(operation: operation, actualHash: actualHash,
                                       desired: desired, lastSynced: lastSynced)
            if action == "ack" { return result(existing.eventIdentifier) }
            if confirmation != nil {
                throw BridgeFailure("Calendar conflict. The event changed after confirmation. Review and retry sync.")
            }
        }
        if action == "delete" {
            try store.remove(existing, span: .thisEvent, commit: true)
            return result(nil)
        }
    } else {
        let action = try missingManagedEventAction(operation: operation, confirmed: confirmation != nil,
                                                   hasMapping: mapping != nil || lastSynced != nil)
        if action == "ack" { return result(nil) }
    }

    guard let start, let end, end > start, end.timeIntervalSince(start) <= 2 * 24 * 3600,
          let title = job["title"] as? String, !title.isEmpty else {
        throw BridgeFailure("The Calendar job needs a title and a valid event range.")
    }
    let event = existing ?? EKEvent(eventStore: store)
    if existing == nil { event.calendar = calendar }
    event.title = title
    event.startDate = start
    event.endDate = end
    event.isAllDay = false
    // Preserve Calendar-only fields, including notes, location and alarms.
    event.url = CalendarMarker(kind: kind, recordID: recordID, desiredHash: desired,
                               remoteHash: eventHash(event)).url
    try store.save(event, span: .thisEvent, commit: true)
    guard let eventID = event.eventIdentifier else {
        throw BridgeFailure("Calendar saved an event without returning its identifier. Retry sync.")
    }
    return result(eventID)
}

private func sync(_ command: [String: Any], store: EKEventStore, registry: inout Registry) throws -> [String: Any] {
    guard let selected = command["selected_ids"] as? [String],
          let jobs = command["jobs"] as? [[String: Any]],
          selected.count <= 100, jobs.count <= 500 else {
        throw BridgeFailure("Calendar sync expects at most 100 selected calendars and 500 outbox jobs.")
    }
    let window = try DateWindow(from: command["from_date"] as? String, through: command["to_date"] as? String)
    let events = try readSelected(Set(selected), registry: registry, store: store, window: window)
    let source = (command["source_id"] as? String).flatMap { store.source(withIdentifier: $0) }
    let links = command["links"] as? [String: [String: Any]] ?? [:]
    var results: [[String: Any]] = []
    for job in jobs {
        guard let id = job["id"] else {
            throw BridgeFailure("A Calendar outbox job has no ID.")
        }
        do {
            guard let kind = job["record_kind"] as? String, ["block", "actual"].contains(kind),
                  let recordID = job["record_id"] as? String else {
                throw BridgeFailure("Calendar only accepts planner block and actual session jobs.")
            }
            guard let source, isICloud(source),
                  source.calendars(for: .event).contains(where: { $0.allowsContentModifications }) else {
                throw BridgeFailure("Calendar sync is pending. Select a writable iCloud source in Settings.")
            }
            // A delete for a record that was never written needs no owned calendar.
            if job["operation"] as? String == "delete", registry.sources[source.sourceIdentifier]?[kind] == nil,
               !(job["event_id"] is String), !(job["calendar_id"] is String) {
                results.append(["id": id])
                continue
            }
            let link = links["\(kind):\(recordID)"] ?? [:]
            if let mapped = (job["calendar_id"] as? String) ?? (link["calendar_id"] as? String),
               registry.sources[source.sourceIdentifier]?[kind] != mapped {
                throw BridgeFailure("Calendar conflict. This job is linked to a different Small Plan calendar.")
            }
            let target = try ownedCalendar(kind, store: store, source: source, registry: &registry)
            results.append(try syncJob(job, link: link,
                                       store: store, calendar: target))
        } catch let conflict as ConfirmableCalendarEdit {
            results.append(["id": id, "error": "Calendar conflict. This Small Plan event was edited in Calendar.",
                            "conflict": conflict.snapshot])
        } catch let failure as BridgeFailure {
            results.append(["id": id, "error": failure.message])
        } catch {
            results.append(["id": id, "error": "Apple Calendar rejected the event or calendar write. Check iCloud settings and retry."])
        }
    }
    return ["status": "authorized", "authorization": "authorized", "events": events, "results": results,
            "calendars": calendars(store, registry: registry), "sources": sources(store),
            "owned_calendars": registry.sources[source?.sourceIdentifier ?? ""] ?? [:]]
}

private func handle(_ command: [String: Any]) throws -> [String: Any] {
    guard let action = command["command"] as? String, ["status", "discover", "sync"].contains(action) else {
        throw BridgeFailure("Unknown Small Plan Calendar command.")
    }
    let initial = authorization()
    if action == "status" {
        return ["status": initial, "authorization": initial]
    }
    var status = initial
    if action == "sync", initial != "authorized" {
        return ["status": initial, "authorization": initial, "events": [], "results": [], "calendars": [], "sources": []]
    }
    let store = EKEventStore()
    if action == "discover" { status = discoverAuthorization(store) }
    guard status == "authorized" else {
        return ["status": status, "authorization": status, "calendars": [], "sources": []]
    }
    var registry = try Registry.load()
    if action == "discover" {
        return ["status": status, "authorization": status, "calendars": calendars(store, registry: registry),
                "sources": sources(store)]
    }
    return try sync(command, store: store, registry: &registry)
}

@main
struct CalendarHelper {
    static func main() {
        let response: [String: Any]
        do {
            var data = Data()
            while data.count <= 8_000_000,
                  let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty {
                data.append(chunk)
            }
            guard data.count <= 8_000_000,
                  let command = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw BridgeFailure("Calendar helper expected one JSON command under 8 MB.")
            }
            response = try handle(command)
        } catch let failure as BridgeFailure {
            response = ["status": "error", "error": failure.message]
        } catch {
            response = ["status": "error", "error": "Calendar helper could not process the command."]
        }
        if let output = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(output)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
}
