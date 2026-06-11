import SwiftUI

// App-wide motion vocabulary. One source of truth for every overlay/panel/toggle
// animation so the window-open feel is identical everywhere and reduce-motion is
// honored in a single place rather than per-surface.
//
// Three curves:
//   • window — the signature spring for overlays/panels opening (the + button
//     marquee, the dashboard add panel, the settings sheet). Heavier, with a soft
//     settle, so a surface reads as "expanding into place".
//   • nav    — a snappier spring for step transitions WITHIN an already-open
//     surface (chooser → form push/pop). Less overshoot so stepping feels crisp.
//   • quick  — a short easeInOut for toggles (customize on/off, panel show/hide
//     state flips) where a spring would feel mushy.
//
// Reduce-motion: when accessibilityReduceMotion is on, springs degrade to a short
// fade (or nothing). Route every animation through `Motion.resolve` / the
// `.nyxAnimation` modifier so this degradation is automatic and consistent.
enum Motion {
    // Signature window-open spring: overlays and panels expanding into place.
    static let window = Animation.spring(response: 0.32, dampingFraction: 0.86)

    // Snappier spring for within-overlay step transitions (push/pop).
    static let nav = Animation.spring(response: 0.26, dampingFraction: 0.82)

    // Short easeInOut for toggles and simple state flips.
    static let quick = Animation.easeInOut(duration: 0.18)

    // The reduce-motion fallback: a brief opacity-only crossfade. Short enough to
    // read as "instant with a softened edge" rather than a slide.
    static let reducedFade = Animation.easeInOut(duration: 0.12)

    // Resolve a curve against the reduce-motion preference. When reduce-motion is
    // on, every spring/curve collapses to a quick fade so nothing slides, scales,
    // or springs — only opacity changes.
    static func resolve(_ animation: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? reducedFade : animation
    }
}

extension View {
    // Apply a Motion curve to a value change, auto-degraded for reduce-motion.
    // Reads accessibilityReduceMotion from the environment so call sites don't
    // each have to thread it through.
    func nyxAnimation<V: Equatable>(_ animation: Animation, value: V) -> some View {
        modifier(NyxAnimationModifier(animation: animation, value: value))
    }
}

private struct NyxAnimationModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V

    func body(content: Content) -> some View {
        content.animation(Motion.resolve(animation, reduceMotion: reduceMotion), value: value)
    }
}

// Transition helpers that collapse to a plain fade under reduce-motion. Use these
// for .transition(...) so a sliding/scaling insertion becomes an opacity-only
// crossfade when the operator has reduce-motion enabled.
enum MotionTransition {
    // Scale-plus-fade anchored near a corner — the fallback marquee for an overlay
    // that grows out of a nearby button. `reduceMotion` collapses it to .opacity.
    static func grow(from anchor: UnitPoint, reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .scale(scale: 0.92, anchor: anchor).combined(with: .opacity)
    }

    // Asymmetric push: content enters from `edge`, leaving content exits toward the
    // opposite edge. Used for the chooser → form step. Collapses to a fade under
    // reduce-motion.
    static func push(from edge: Edge, reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        let opposite: Edge = {
            switch edge {
            case .leading:  return .trailing
            case .trailing: return .leading
            case .top:      return .bottom
            case .bottom:   return .top
            }
        }()
        return .asymmetric(
            insertion: .move(edge: edge).combined(with: .opacity),
            removal:   .move(edge: opposite).combined(with: .opacity))
    }

    // Slide in from an edge with a fade; fade-only under reduce-motion. Used for
    // the dashboard add-widget panel.
    static func slide(from edge: Edge, reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .move(edge: edge).combined(with: .opacity)
    }
}
