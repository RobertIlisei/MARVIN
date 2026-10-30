// LegacySDKShims — compile-time stand-ins for APIs a newer SDK provides.
//
// Inert unless built with `-Xswiftc -DMARVIN_LEGACY_SDK`. The macOS 15 SDK
// declares `View.onGeometryChange`; the 14.x SDK does not, so call sites that
// are already runtime-guarded by `#available(macOS 15.0, *)` still fail to
// *compile* against it. With the flag set this supplies the same signature,
// built on the `GeometryReader` background that those sites' macOS 14
// fallbacks already use. Without the flag (Xcode 16+ / macOS 15 SDK) this
// file compiles to nothing and the SDK's own method is used.

#if MARVIN_LEGACY_SDK
import SwiftUI

extension View {
    @MainActor func onGeometryChange<T: Equatable>(
        for type: T.Type,
        of transform: @escaping (GeometryProxy) -> T,
        action: @escaping @MainActor (T) -> Void
    ) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { MainActor.assumeIsolated { action(transform(proxy)) } }
                    .onChange(of: transform(proxy)) { _, new in MainActor.assumeIsolated { action(new) } }
            }
        )
    }
}
#endif
