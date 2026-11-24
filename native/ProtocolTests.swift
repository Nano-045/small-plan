import Foundation

@main
struct ProtocolTests {
    static func main() throws {
        let old = digest(["old"])
        let new = digest(["new"])
        let remote = digest(["remote"])
        let marker = CalendarMarker(kind: "block", recordID: "123", desiredHash: old, remoteHash: remote)
        precondition(CalendarMarker(marker.url)?.key == marker.key)
        precondition(CalendarMarker(URL(string: "https://calendar-event/123")) == nil)
        let retry = try marker.action(operation: "upsert", actualHash: remote, desired: old, lastSynced: nil)
        precondition(retry == "ack")
        let update = try marker.action(operation: "upsert", actualHash: remote, desired: new, lastSynced: old)
        precondition(update == "upsert")
        let delete = try marker.action(operation: "delete", actualHash: remote, desired: old, lastSynced: old)
        precondition(delete == "delete")
        do {
            _ = try marker.action(operation: "delete", actualHash: new, desired: old, lastSynced: old)
            fatalError("Remote edits must prevent deletes")
        } catch let error as BridgeFailure {
            precondition(error.message.contains("edited"))
        }
        do {
            _ = try marker.action(operation: "upsert", actualHash: remote, desired: new, lastSynced: nil)
            fatalError("Unexpected remote version must prevent overwrites")
        } catch let error as BridgeFailure {
            precondition(error.message.contains("revision"))
        }
        let edited = digest(["edited"])
        let observed = try marker.conflictToken(calendarID: "owned", eventID: "existing", actualHash: edited,
                                                modification: "1", operation: "upsert",
                                                desired: new, lastSynced: old)
        let current = try marker.conflictToken(calendarID: "owned", eventID: "existing", actualHash: edited,
                                               modification: "1", operation: "upsert",
                                               desired: new, lastSynced: old)
        precondition(observed == current)
        let changedAgain = try marker.conflictToken(calendarID: "owned", eventID: "existing", actualHash: edited,
                                                    modification: "2", operation: "upsert",
                                                    desired: new, lastSynced: old)
        let changedCalendar = try marker.conflictToken(calendarID: "other", eventID: "existing", actualHash: edited,
                                                       modification: "1", operation: "upsert",
                                                       desired: new, lastSynced: old)
        let changedOperation = try marker.conflictToken(calendarID: "owned", eventID: "existing", actualHash: edited,
                                                        modification: "1", operation: "delete",
                                                        desired: new, lastSynced: old)
        precondition(changedAgain != observed && changedCalendar != observed && changedOperation != observed)
        do {
            _ = try marker.conflictToken(calendarID: "owned", eventID: "existing", actualHash: edited,
                                         modification: "1", operation: "upsert",
                                         desired: new, lastSynced: nil)
            fatalError("An unrelated remote revision must never have a confirmation token")
        } catch is BridgeFailure {
            // Expected.
        }
        do {
            _ = try resolveManagedEventID(mapped: "existing", exact: nil, matches: ["different"])
            fatalError("A marker match cannot stand in for a missing mapped event during confirmation")
        } catch is BridgeFailure {
            // Expected.
        }
        do {
            _ = try resolveManagedEventID(mapped: "existing", exact: "existing", matches: ["existing", "duplicate"])
            fatalError("A direct mapped event must still be rejected when a duplicate marker exists")
        } catch is BridgeFailure {
            // Expected.
        }
        precondition(CalendarMarker(URL(string: marker.url.absoluteString + "?amended=1")) == nil)
        let missingDelete = try missingManagedEventAction(operation: "delete", confirmed: true, hasMapping: true)
        precondition(missingDelete == "ack")
        do {
            _ = try missingManagedEventAction(operation: "upsert", confirmed: true, hasMapping: true)
            fatalError("A confirmed edit must never recreate a missing event")
        } catch is BridgeFailure {
            // Expected.
        }
        let dst = try DateWindow(from: "2026-04-05", through: "2026-04-05")
        precondition(dst.end.timeIntervalSince(dst.start) == 25 * 3600)
        do {
            _ = try DateWindow(from: "2026-02-30", through: "2026-02-30")
            fatalError("Invalid dates must fail")
        } catch is BridgeFailure {
            // Expected.
        }
        print("Calendar marker retry, update, delete, conflict and date-window tests passed.")
    }
}
