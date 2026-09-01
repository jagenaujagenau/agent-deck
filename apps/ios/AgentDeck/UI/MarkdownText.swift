import SwiftUI

/// A message drawn as the Markdown it was written in: headings are headings,
/// lists have bullets, fenced code sits in its own box, and a table is a
/// table. Sized to match the Android timeline, which the same person reads on
/// the other phone.
struct MarkdownText: View {
    var content: String
    var size: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(markdownBlocks(content).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(inline(text, size: headingSize(level)))
                .font(.system(size: headingSize(level), weight: .semibold))
                .foregroundStyle(Palette.text)
                .padding(.top, level <= 2 ? 4 : 0)

        case let .paragraph(text):
            Text(inline(text, size: size))
                .font(.system(size: size))
                .lineSpacing(5)

        case let .list(ordered, items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        marker(for: item, ordered: ordered, position: index)
                        Text(inline(item.text, size: size))
                            .font(.system(size: size))
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.depth) * 16)
                }
            }

        case let .code(language, text):
            CodeBlock(language: language, text: text)

        case let .quote(blocks):
            HStack(alignment: .top, spacing: 9) {
                Rectangle()
                    .fill(Palette.signal.opacity(0.45))
                    .frame(width: 2)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in
                        erased(inner)
                    }
                }
                .foregroundStyle(Palette.muted)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .table(headers, rows):
            MarkdownTable(headers: headers, rows: rows, size: size)

        case .rule:
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
                .padding(.vertical, 2)
        }
    }

    /// Blocks nested inside a quote go through here: `view(for:)` calling
    /// itself would make its opaque return type self-referential, and the
    /// erasure is the price of quoting a list or a fence.
    private func erased(_ block: MarkdownBlock) -> AnyView { AnyView(view(for: block)) }

    /// A bullet, a checkbox, or the item's own number — never a renumbering,
    /// because an agent that starts a list at 3 means 3.
    @ViewBuilder
    private func marker(for item: MarkdownListItem, ordered: Bool, position: Int) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.system(size: size - 2))
                .foregroundStyle(checked ? Palette.signal : Palette.muted)
        } else if ordered {
            Text("\(item.number ?? position + 1).")
                .font(.system(size: size, weight: .medium).monospacedDigit())
                .foregroundStyle(Palette.muted)
        } else {
            Text(item.depth % 2 == 0 ? "\u{2022}" : "\u{25E6}")
                .font(.system(size: size))
                .foregroundStyle(Palette.muted)
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: size + 8
        case 2: size + 6
        case 3: size + 3
        case 4: size + 2
        case 5: size + 1
        default: size
        }
    }
}

/// Bold, italic, links, inline code and strikethrough, with the code runs
/// given a monospaced face of their own — SwiftUI leaves them in the body
/// font otherwise, which makes `a` and a indistinguishable.
func inline(_ text: String, size: CGFloat) -> AttributedString {
    guard var attributed = try? AttributedString(
        markdown: text,
        options: .init(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
    ) else { return AttributedString(text) }

    for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
        attributed[run.range].font = .system(size: size - 1.5, design: .monospaced)
        attributed[run.range].foregroundColor = Palette.signal
    }
    for run in attributed.runs where run.link != nil {
        attributed[run.range].foregroundColor = Palette.blue
        attributed[run.range].underlineStyle = .single
    }
    return attributed
}

/// A fenced block: its own dark slab, scrolling sideways rather than wrapping,
/// because wrapped code lies about where its lines end.
private struct CodeBlock: View {
    var language: String?
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: 10, weight: .medium))
                    .kerning(0.5)
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(3)
                    .foregroundStyle(Palette.text.opacity(0.92))
                    .textSelection(.enabled)
                    // Without this the scroll view offers the text the bubble's
                    // width and it truncates to one ellipsised line instead of
                    // scrolling — the code block showed its first line only.
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.ink.opacity(0.72)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line, lineWidth: 1))
    }
}

/// Fixed-width columns that scroll sideways — the same shape Android draws,
/// because a table squeezed into phone width stops being readable long before
/// it stops fitting.
private struct MarkdownTable: View {
    var headers: [String]
    var rows: [[String]]
    var size: CGFloat

    private let column: CGFloat = 168

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        Text(inline(header, size: 13))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Palette.text)
                            .frame(width: column, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    }
                }
                Rectangle().fill(Palette.line).frame(height: 1)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(inline(cell, size: size - 1))
                                .font(.system(size: size - 1))
                                .foregroundStyle(Palette.text.opacity(0.9))
                                .frame(width: column, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                        }
                    }
                    .background(index.isMultiple(of: 2) ? Palette.surface.opacity(0.45) : .clear)
                    if index != rows.count - 1 {
                        Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 1)
                    }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.ink.opacity(0.72)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line, lineWidth: 1))
    }
}
