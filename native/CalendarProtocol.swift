import CryptoKit
import Foundation

struct BridgeFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func digest(_ parts: [String]) -> String {
    let json = (try? JSONEncoder().encode(parts)) ?? Data()
    return SHA256.hash(data: json).map { String(format: "%02x", $0) }.joined()
}

let isoSeconds = ISO8601DateFormatter()
let isoFraction = {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format
}()

func parseInstant(_ value: String?) -> Date? {
    guard let value else { return nil }
    return isoSeconds.date(from: value) ?? isoFraction.date(from: value)
}

struct CalendarMarker {
    let key: String
    let desiredHash: String
    let remoteHash: String

    init(kind: String, recordID: String, desiredHash: String, remoteHash: String) {
        key = digest([kind, recordID])
        self.desiredHash = desiredHash
        self.remoteHash = remoteHash
    }

    init?(_ url: URL?) {
        guard let url, url.scheme == "smallplan", url.host == "calendar-event" else { return nil }
        let fields = url.pathComponents.dropFirst().map { $0 }
        guard fields.count == 3, fields.allSatisfy(Self.validHash) else { return nil }
        key = fields[0]
        desiredHash = fields[1]
        remoteHash = fields[2]
        guard url.absoluteString == self.url.absoluteString else { return nil }
    }

    var url: URL {
        // The values are validated hexadecimal digests.
        URL(string: "smallplan://calendar-event/\(key)/\(desiredHash)/\(remoteHash)")!
    }

    static func validHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    func action(operation: String, actualHash: String, desired: String, lastSynced: String?) throws -> String {
        guard remoteHash == actualHash else {
            throw BridgeFailure("Calendar conflict. This Small Plan event was edited in Calendar.")
        }
        if operation == "upsert", desiredHash == desired { return "ack" }
        guard lastSynced == desiredHash else {
            throw BridgeFailure("Calendar conflict. The calendar event has an unexpected revision.")
        }
        return operation
    }
    func conflictToken(calendarID: String, eventID: String, actualHash: String,
                       modification: String, operation: String, desired: String, lastSynced: String?) throws -> String {
        guard actualHash != remoteHash, lastSynced == desiredHash || desired == desiredHash else {
            throw BridgeFailure("Calendar conflict. The event revision cannot be confirmed.")
        }
        return digest([calendarID, eventID, url.absoluteString, actualHash, modification, operation, desired])
    }
}

func resolveManagedEventID(mapped: String?, exact: String?, matches: Set<String>) throws -> String? {
    let candidates = matches.union(exact.map { [$0] } ?? [])
    guard candidates.count <= 1 else {
        throw BridgeFailure("Calendar conflict. Multiple Small Plan events have the same marker.")
    }
    guard mapped == nil || exact == mapped || candidates.isEmpty else {
        throw BridgeFailure("Calendar conflict. The previously synced event is missing or its identity changed.")
    }
    return candidates.first
}

func missingManagedEventAction(operation: String, confirmed: Bool, hasMapping: Bool) throws -> String {
    // The caller already checked ownership, moved mappings and ambiguous markers.
    // An absent event satisfies a delete even if its committed reply was lost.
    if operation == "delete" { return "ack" }
    if confirmed || hasMapping {
        throw BridgeFailure("Calendar conflict. The previously synced event is missing.")
    }
    return "create"
}

struct DateWindow {
    let start: Date
    let end: Date

    init(from: String?, through: String?, now: Date = Date()) throws {
        var melbourne = Calendar(identifier: .gregorian)
        melbourne.timeZone = TimeZone(identifier: "Australia/Melbourne")!
        let formatter = DateFormatter()
        formatter.calendar = melbourne
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = melbourne.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false

        func localDay(_ value: String?, defaultOffset: Int) throws -> Date {
            guard let value else {
                return melbourne.date(byAdding: .day, value: defaultOffset, to: melbourne.startOfDay(for: now))!
            }
            guard let day = formatter.date(from: value), formatter.string(from: day) == value else {
                throw BridgeFailure("Calendar search uses local YYYY-MM-DD dates.")
            }
            return day
        }
        let fromDay = try localDay(from, defaultOffset: -90)
        let toDay = try localDay(through, defaultOffset: 90)
        let length = melbourne.dateComponents([.day], from: fromDay, to: toDay).day!
        guard (0...365).contains(length) else {
            throw BridgeFailure("Choose a Calendar search window of up to 366 days.")
        }
        start = fromDay
        end = melbourne.date(byAdding: .day, value: 1, to: toDay)!
    }
}
