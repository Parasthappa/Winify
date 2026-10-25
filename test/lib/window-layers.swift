// Prints each on-screen window's owner, title, layer (window level) and bounds.
// Argument: an owner's process ID (only its windows), or part of an owner's name.
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly]
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as! [[String: Any]]
let want = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
  if !want.isEmpty {
    if let n = Int(want) { if pid != n { continue } } else if !owner.contains(want) { continue }
  }
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("\(owner) pid \(pid) | layer \(layer) | \(b["X"] ?? "") \(b["Y"] ?? "") \(b["Width"] ?? "")x\(b["Height"] ?? "")")
}
