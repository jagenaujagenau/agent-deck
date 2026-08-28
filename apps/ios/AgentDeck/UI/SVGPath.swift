import SwiftUI

/// A minimal SVG path-data reader, enough for the harness marks and nothing more.
///
/// The vendor artwork already exists in this repository as Android vector
/// drawables, whose `pathData` is SVG path data verbatim. Reading it directly
/// keeps one copy of each mark: redrawing them by hand would be a second
/// drawing that drifts from the first, and bundling them as images would need
/// an asset catalog this app deliberately does without.
///
/// Supports `M m L l H h V v C c A a Z z` — every command the three marks use.
/// An unknown command aborts the parse rather than guessing, because half a
/// logo is worse than the monogram it would otherwise have fallen back to.
enum SVGPath {
    static func parse(_ data: String) -> Path? {
        var scanner = Scanner(data: data)
        var path = Path()
        var current = CGPoint.zero
        var start = CGPoint.zero
        var previous: Character = " "

        while let command = scanner.command(after: previous) {
            previous = command
            let relative = command.isLowercase
            func point(_ x: Double, _ y: Double) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch Character(command.lowercased()) {
            case "m":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                start = current
                path.move(to: current)
                // A second coordinate pair after a moveto is an implicit lineto.
                previous = relative ? "l" : "L"
            case "l":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                path.addLine(to: current)
            case "h":
                guard let x = scanner.number() else { return nil }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
            case "v":
                guard let y = scanner.number() else { return nil }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
            case "c":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number()
                else { return nil }
                let end = point(x, y)
                path.addCurve(to: end, control1: point(x1, y1), control2: point(x2, y2))
                current = end
            case "a":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(),
                      let largeArc = scanner.flag(), let sweep = scanner.flag(),
                      let x = scanner.number(), let y = scanner.number()
                else { return nil }
                let end = point(x, y)
                appendArc(
                    to: &path, from: current, to: end,
                    rx: rx, ry: ry, rotation: rotation,
                    largeArc: largeArc, sweep: sweep
                )
                current = end
            case "z":
                path.closeSubpath()
                current = start
            default:
                return nil
            }
        }
        return path.isEmpty ? nil : path
    }

    /// SVG's endpoint arc parameterisation, converted to the centre form and
    /// then to cubics — `Path` has no elliptical-arc-to primitive.
    private static func appendArc(
        to path: inout Path,
        from origin: CGPoint,
        to end: CGPoint,
        rx: Double, ry: Double, rotation: Double,
        largeArc: Bool, sweep: Bool
    ) {
        var rx = abs(rx)
        var ry = abs(ry)
        // A degenerate radius means the arc is a straight line, per the spec.
        guard rx > 0, ry > 0, origin != end else {
            path.addLine(to: end)
            return
        }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx = (origin.x - end.x) / 2
        let dy = (origin.y - end.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy

        // Radii too small to span the chord are scaled up until they fit.
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }

        let numerator = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let factor = (denominator == 0 ? 0 : (numerator / denominator).squareRoot())
            * (largeArc == sweep ? -1 : 1)
        let cx1 = factor * rx * y1 / ry
        let cy1 = -factor * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (origin.x + end.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (origin.y + end.y) / 2

        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let dot = ux * vx + uy * vy
            let length = (ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot()
            let value = acos(min(1, max(-1, length == 0 ? 1 : dot / length)))
            return (ux * vy - uy * vx < 0) ? -value : value
        }

        let startAngle = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var sweepAngle = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep, sweepAngle > 0 { sweepAngle -= 2 * .pi }
        if sweep, sweepAngle < 0 { sweepAngle += 2 * .pi }

        // A cubic approximates a circular arc well up to about a quarter turn.
        let segments = max(1, Int(ceil(abs(sweepAngle) / (.pi / 2))))
        let delta = sweepAngle / Double(segments)
        let alpha = 4.0 / 3.0 * tan(delta / 4)
        var theta = startAngle

        for _ in 0 ..< segments {
            let next = theta + delta
            let from = ellipsePoint(cx, cy, rx, ry, cosPhi, sinPhi, theta)
            let to = ellipsePoint(cx, cy, rx, ry, cosPhi, sinPhi, next)
            let fromDerivative = ellipseDerivative(rx, ry, cosPhi, sinPhi, theta)
            let toDerivative = ellipseDerivative(rx, ry, cosPhi, sinPhi, next)
            path.addCurve(
                to: to,
                control1: CGPoint(x: from.x + alpha * fromDerivative.x, y: from.y + alpha * fromDerivative.y),
                control2: CGPoint(x: to.x - alpha * toDerivative.x, y: to.y - alpha * toDerivative.y)
            )
            theta = next
        }
    }

    private static func ellipsePoint(
        _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double,
        _ cosPhi: Double, _ sinPhi: Double, _ theta: Double
    ) -> CGPoint {
        let x = rx * cos(theta)
        let y = ry * sin(theta)
        return CGPoint(x: cx + cosPhi * x - sinPhi * y, y: cy + sinPhi * x + cosPhi * y)
    }

    private static func ellipseDerivative(
        _ rx: Double, _ ry: Double,
        _ cosPhi: Double, _ sinPhi: Double, _ theta: Double
    ) -> CGPoint {
        let x = -rx * sin(theta)
        let y = ry * cos(theta)
        return CGPoint(x: cosPhi * x - sinPhi * y, y: sinPhi * x + cosPhi * y)
    }

    /// A hand-rolled tokenizer, because SVG path data is not whitespace
    /// separated: `.843-2.463` is two numbers, and `a1 1 0 010` packs two flags
    /// and a coordinate into four characters.
    private struct Scanner {
        private let characters: [Character]
        private var index = 0

        init(data: String) { characters = Array(data) }

        mutating func command(after previous: Character) -> Character? {
            skipSeparators()
            guard index < characters.count else { return nil }
            let character = characters[index]
            if character.isLetter {
                index += 1
                return character
            }
            // A bare number continues the previous command, per the spec.
            return previous == " " ? nil : previous
        }

        mutating func number() -> Double? {
            skipSeparators()
            var text = ""
            if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                text.append(characters[index])
                index += 1
            }
            var seenDot = false
            while index < characters.count {
                let character = characters[index]
                if character.isNumber {
                    text.append(character)
                } else if character == ".", !seenDot {
                    seenDot = true
                    text.append(character)
                } else if character == "e" || character == "E" {
                    text.append(character)
                    index += 1
                    if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                        text.append(characters[index])
                        index += 1
                    }
                    continue
                } else {
                    break
                }
                index += 1
            }
            return Double(text)
        }

        /// An arc flag is exactly one character, and may be glued to the digits
        /// on either side of it.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard index < characters.count, let value = characters[index].wholeNumberValue, value == 0 || value == 1
            else { return nil }
            index += 1
            return value == 1
        }

        private mutating func skipSeparators() {
            while index < characters.count, characters[index] == " " || characters[index] == "," || characters[index] == "\n" || characters[index] == "\t" || characters[index] == "\r" {
                index += 1
            }
        }
    }
}

/// One filled sub-path of a harness mark, scaled to fit the space it is given.
struct HarnessArtwork: View {
    var strokes: [HarnessStroke]
    var viewBox: CGSize

    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width / viewBox.width, geometry.size.height / viewBox.height)
            let offset = CGSize(
                width: (geometry.size.width - viewBox.width * scale) / 2,
                height: (geometry.size.height - viewBox.height * scale) / 2
            )
            ZStack {
                ForEach(Array(strokes.enumerated()), id: \.offset) { _, stroke in
                    if let path = SVGPath.parse(stroke.data) {
                        path
                            .applying(CGAffineTransform(scaleX: scale, y: scale))
                            .offset(x: offset.width, y: offset.height)
                            .fill(stroke.color, style: FillStyle(eoFill: true))
                    }
                }
            }
        }
    }
}

struct HarnessStroke {
    var data: String
    var color: Color
}
