// Prints each on-screen window's owner, title, layer (window level) and bounds.
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly]
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  if CommandLine.arguments.count > 1 && !owner.contains(CommandLine.arguments[1]) { continue }
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let name = w[kCGWindowName as String] as? String ?? ""
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("\(owner) | layer \(layer) | \(name) | \(b["X"] ?? "") \(b["Y"] ?? "") \(b["Width"] ?? "")x\(b["Height"] ?? "")")
}
