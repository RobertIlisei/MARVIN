// BrainStateGate — may this session write the brain's state?
//
// Several sessions run at once, and a turn that is not on screen still
// streams: background-job completions and wakeups fire against sessions the
// user is not looking at. The brain read a single untagged global, so
// whichever session wrote last owned it — and it showed "something general"
// rather than the selected session.
//
// The rule is a drop, not a queue. The brain is a picture of what the user is
// looking at; a state from another session is not a stale version of that, it
// is an answer to a different question.
//
// Pure (ADR-0022) because the interesting cases are all about nil: a boot
// with no session yet, a teardown that must still be able to idle, and the
// window during a brand-new chat where the session has no id until the server
// answers. Those are cheap to pin here and awkward to reproduce live.

import Foundation

public enum BrainStateGate {
    /// True when a state written by `writer` should be shown.
    ///
    /// - `writer == nil` — "no session in particular" (boot, teardown). Always
    ///   allowed, so idling still works when nothing is loaded and a
    ///   brand-new chat can report progress before it has an id.
    /// - `active == nil` — nothing is selected, so there is nothing for the
    ///   write to contradict.
    public static func accepts(writer: String?, active: String?) -> Bool {
        guard let writer, let active else { return true }
        return writer == active
    }
}
