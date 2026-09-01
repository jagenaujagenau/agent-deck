import Foundation

/// What a message's Markdown becomes before anything draws it. iOS used to
/// hand the whole message to `AttributedString(markdown:)` in inline-only
/// mode, which renders bold and links but leaves every block marker standing:
/// headings arrived as "## Heading", lists as "- item", fenced code with its
/// backticks, tables as a wall of pipes. Android has parsed blocks all along,
/// so the two phones showed the same message differently.
indirect enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(ordered: Bool, items: [MarkdownListItem])
    case code(language: String?, text: String)
    case quote([MarkdownBlock])
    case table(headers: [String], rows: [[String]])
    case rule
}

struct MarkdownListItem: Equatable {
    /// Nesting depth, counted in two-space steps from the left margin.
    var depth: Int
    /// The number a `1.` item shows, or nil for a bullet.
    var number: Int?
    /// Set for `- [ ]` / `- [x]` items only, so a task list reads as one.
    var checked: Bool?
    var text: String
}

/// The message's blocks, in reading order.
func markdownBlocks(_ content: String) -> [MarkdownBlock] {
    let lines = restoreFlattenedMarkdown(content).components(separatedBy: "\n")
    var blocks: [MarkdownBlock] = []
    var index = 0

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmed

        if trimmed.isEmpty {
            index += 1
            continue
        }

        if let fence = codeFence(trimmed) {
            var body: [String] = []
            index += 1
            while index < lines.count, !lines[index].trimmed.hasPrefix(fence.marker) {
                body.append(lines[index])
                index += 1
            }
            // An unclosed fence still ends the block: a streamed message often
            // arrives mid-fence, and swallowing the rest as plain text would
            // be worse than closing it here.
            if index < lines.count { index += 1 }
            blocks.append(.code(language: fence.language, text: dedent(body).joined(separator: "\n")))
            continue
        }

        if let heading = heading(trimmed) {
            blocks.append(heading)
            index += 1
            continue
        }

        if let table = table(lines, from: index) {
            blocks.append(.table(headers: table.headers, rows: table.rows))
            index = table.end
            continue
        }

        if isRule(trimmed) {
            blocks.append(.rule)
            index += 1
            continue
        }

        if trimmed.hasPrefix(">") {
            var quoted: [String] = []
            while index < lines.count, lines[index].trimmed.hasPrefix(">") {
                let inner = String(lines[index].trimmed.dropFirst())
                quoted.append(inner.hasPrefix(" ") ? String(inner.dropFirst()) : inner)
                index += 1
            }
            blocks.append(.quote(markdownBlocks(quoted.joined(separator: "\n"))))
            continue
        }

        if listMarker(line) != nil {
            var items: [MarkdownListItem] = []
            var ordered = false
            while index < lines.count, let marker = listMarker(lines[index]) {
                ordered = ordered || marker.number != nil
                var text = marker.text
                // A wrapped list item continues on the next indented,
                // unmarked line — joined, or it would read as a new paragraph.
                var lookahead = index + 1
                while lookahead < lines.count,
                      listMarker(lines[lookahead]) == nil,
                      !lines[lookahead].trimmed.isEmpty,
                      lines[lookahead].hasPrefix(" ") {
                    text += " " + lines[lookahead].trimmed
                    lookahead += 1
                }
                items.append(
                    MarkdownListItem(depth: marker.depth, number: marker.number, checked: marker.checked, text: text))
                index = lookahead
                // A blank line inside a list is a loose list, not its end.
                if index < lines.count, lines[index].trimmed.isEmpty, index + 1 < lines.count,
                   listMarker(lines[index + 1]) != nil {
                    index += 1
                }
            }
            blocks.append(.list(ordered: ordered, items: items))
            continue
        }

        var paragraph: [String] = []
        while index < lines.count {
            let candidate = lines[index]
            let candidateTrimmed = candidate.trimmed
            if candidateTrimmed.isEmpty || codeFence(candidateTrimmed) != nil || heading(candidateTrimmed) != nil
                || listMarker(candidate) != nil || candidateTrimmed.hasPrefix(">") || isRule(candidateTrimmed)
                || table(lines, from: index) != nil {
                break
            }
            paragraph.append(candidateTrimmed)
            index += 1
        }
        if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
    }

    return blocks.isEmpty ? [.paragraph(content)] : blocks
}

// MARK: - Line shapes

private func heading(_ trimmed: String) -> MarkdownBlock? {
    let hashes = trimmed.prefix(while: { $0 == "#" }).count
    guard (1 ... 6).contains(hashes) else { return nil }
    let rest = String(trimmed.dropFirst(hashes))
    guard rest.hasPrefix(" ") else { return nil }
    let text = rest.trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
    return text.isEmpty ? nil : .heading(level: hashes, text: text)
}

private func codeFence(_ trimmed: String) -> (marker: String, language: String?)? {
    for marker in ["```", "~~~"] where trimmed.hasPrefix(marker) {
        let language = String(trimmed.dropFirst(marker.count)).trimmed
        return (marker, language.isEmpty ? nil : language)
    }
    return nil
}

/// `---`, `***`, `___` — three or more of one mark and nothing else.
private func isRule(_ trimmed: String) -> Bool {
    let stripped = trimmed.replacingOccurrences(of: " ", with: "")
    guard stripped.count >= 3, let mark = stripped.first, "-*_".contains(mark) else { return false }
    return stripped.allSatisfy { $0 == mark }
}

private struct ListMarker {
    var depth: Int
    var number: Int?
    var checked: Bool?
    var text: String
}

private func listMarker(_ line: String) -> ListMarker? {
    let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
    // Capped: agents indent nested lists by two, three, or four spaces
    // interchangeably, and past four steps the indent costs more width than
    // the nesting is worth on a phone.
    let depth = min(4, indent.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2)
    var rest = String(line.dropFirst(indent.count))

    var number: Int?
    if let bullet = rest.first, "-*+".contains(bullet), rest.dropFirst().first == " " {
        rest = String(rest.dropFirst(2))
    } else {
        let digits = rest.prefix(while: \.isNumber)
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let afterDigits = rest.dropFirst(digits.count)
        guard let separator = afterDigits.first, separator == "." || separator == ")",
              afterDigits.dropFirst().first == " " else { return nil }
        number = Int(digits)
        rest = String(afterDigits.dropFirst(2))
    }

    var checked: Bool?
    let box = rest.trimmed
    if box.hasPrefix("[ ] ") || box == "[ ]" {
        checked = false
        rest = String(box.dropFirst(3))
    } else if box.lowercased().hasPrefix("[x] ") || box.lowercased() == "[x]" {
        checked = true
        rest = String(box.dropFirst(3))
    }

    let text = rest.trimmed
    return text.isEmpty && checked == nil ? nil : ListMarker(depth: depth, number: number, checked: checked, text: text)
}

/// Strips the shared leading indentation of a fenced block, so code indented
/// inside a list still starts at the left edge of its own box.
private func dedent(_ lines: [String]) -> [String] {
    let common = lines
        .filter { !$0.trimmed.isEmpty }
        .map { $0.prefix(while: { $0 == " " }).count }
        .min() ?? 0
    guard common > 0 else { return lines }
    return lines.map { $0.count >= common ? String($0.dropFirst(common)) : $0.trimmed }
}

// MARK: - Tables

/// A pipe table starting at `start`, or nil if the two lines there are not a
/// header and its separator. Mirrors Kotlin's `responseBlocks`: short rows are
/// padded rather than ending the table, extra cells are ignored, and `\|`
/// inside a cell does not split it.
private func table(_ lines: [String], from start: Int) -> (headers: [String], rows: [[String]], end: Int)? {
    guard start + 1 < lines.count else { return nil }
    let headers = tableCells(lines[start])
    let separators = tableCells(lines[start + 1])
    guard separators.count >= 2, headers.count == separators.count else { return nil }
    guard separators.allSatisfy({
        $0.range(of: "^:?-{3,}:?$", options: .regularExpression) != nil
    }) else { return nil }

    var rows: [[String]] = []
    var index = start + 2
    while index < lines.count {
        let cells = tableCells(lines[index])
        if cells.isEmpty { break }
        rows.append((0 ..< headers.count).map { column in column < cells.count ? cells[column] : "" })
        index += 1
    }
    return (headers, rows, index)
}

private func tableCells(_ line: String) -> [String] {
    let trimmed = line.trimmed
    // A lone "|" starts and ends with a pipe but delimits nothing.
    guard trimmed.count >= 2, trimmed.hasPrefix("|"), trimmed.hasSuffix("|") else { return [] }
    var cells: [String] = []
    var cell = ""
    var characters = Array(trimmed)
    characters.removeFirst()
    characters.removeLast()
    var index = 0
    while index < characters.count {
        let character = characters[index]
        if character == "\\", index + 1 < characters.count, characters[index + 1] == "|" {
            cell.append("|")
            index += 2
        } else if character == "|" {
            cells.append(cell.trimmed)
            cell = ""
            index += 1
        } else {
            cell.append(character)
            index += 1
        }
    }
    cells.append(cell.trimmed)
    return cells
}

/// Repairs historical responses flattened before Markdown-safe ingestion was
/// introduced. Mirrored from Kotlin's `restoreFlattenedMarkdown`.
func restoreFlattenedMarkdown(_ content: String) -> String {
    guard !content.contains("\n"), content.contains("| |") else { return content }
    var lines = content
        .replacingOccurrences(of: "\\|\\s+\\|", with: "|\n|", options: .regularExpression)
        .components(separatedBy: "\n")
    var separatorIndex = 1
    var repairedTable = false

    while separatorIndex < lines.count {
        let separators = lines[separatorIndex].trimmed
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .components(separatedBy: "|")
            .map { $0.trimmed }
        guard separators.count >= 2,
              separators.allSatisfy({ $0.range(of: "^:?-{3,}:?$", options: .regularExpression) != nil })
        else {
            separatorIndex += 1
            continue
        }
        let columns = separators.count
        let headerIndex = separatorIndex - 1
        let header = Array(lines[headerIndex])
        let headerBars = header.indices.filter { header[$0] == "|" }
        guard headerBars.count >= columns + 1 else {
            separatorIndex += 1
            continue
        }
        let tableStart = headerBars[headerBars.count - columns - 1]
        let prefix = restoreFlattenedHeadings(
            String(header[0 ..< tableStart]).trimmingCharacters(in: .whitespaces))
        let tableHeader = "| " + String(header[(tableStart + 1)...]).trimmingCharacters(in: .whitespaces)
        if prefix.trimmed.isEmpty {
            lines[headerIndex] = tableHeader
        } else {
            lines.remove(at: headerIndex)
            lines.insert(contentsOf: [prefix, "", tableHeader], at: headerIndex)
            separatorIndex += 2
        }
        repairedTable = true

        var rowIndex = separatorIndex + 1
        while rowIndex < lines.count {
            let row = Array(lines[rowIndex])
            guard lines[rowIndex].drop(while: { $0 == " " }).first == "|" else { break }
            let bars = row.indices.filter { row[$0] == "|" }
            guard bars.count >= columns + 1 else { break }
            let closingBar = bars[columns]
            let trailing = String(row[(closingBar + 1)...]).trimmed
            lines[rowIndex] = String(row[0 ... closingBar])
            if !trailing.isEmpty {
                lines.insert(contentsOf: ["", restoreFlattenedHeadings(trailing)], at: rowIndex + 1)
                break
            }
            rowIndex += 1
        }
        separatorIndex += 1
    }

    return repairedTable ? lines.joined(separator: "\n") : content
}

private func restoreFlattenedHeadings(_ value: String) -> String {
    value.replacingOccurrences(of: "\\s+(?=#{1,6}\\s)", with: "\n\n", options: .regularExpression)
}
