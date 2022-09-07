import { NavigationBarItem, NavigationTree, ScriptElementKind, ScriptElementKindModifier, TextSpan } from "typescript";
import { SymbolKind, SymbolTag, DocumentSymbol, Range, Position } from "vscode-languageserver";

import Civet, { SourceMap } from "@danielx/civet"
const { util: { lookupLineColumn } } = Civet

export type SourcemapLines = SourceMap["data"]["lines"]

// https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/languageFeatures/documentSymbol.ts#L63

const getSymbolKind = (kind: string): SymbolKind => {
  switch (kind) {
    case ScriptElementKind.moduleElement: return SymbolKind.Module;
    case ScriptElementKind.classElement: return SymbolKind.Class;
    case ScriptElementKind.enumElement: return SymbolKind.Enum;
    case ScriptElementKind.interfaceElement: return SymbolKind.Interface;
    case ScriptElementKind.memberFunctionElement: return SymbolKind.Method;
    case ScriptElementKind.memberVariableElement: return SymbolKind.Property;
    case ScriptElementKind.memberGetAccessorElement: return SymbolKind.Property;
    case ScriptElementKind.memberSetAccessorElement: return SymbolKind.Property;
    case ScriptElementKind.variableElement: return SymbolKind.Variable;
    case ScriptElementKind.constElement: return SymbolKind.Variable;
    case ScriptElementKind.localVariableElement: return SymbolKind.Variable;
    case ScriptElementKind.functionElement: return SymbolKind.Function;
    case ScriptElementKind.localFunctionElement: return SymbolKind.Function;
    case ScriptElementKind.constructSignatureElement: return SymbolKind.Constructor;
    case ScriptElementKind.constructorImplementationElement: return SymbolKind.Constructor;
  }
  return SymbolKind.Variable;
};

/**
 * @param lineTable Table of line lengths in generated TypeScript code
 * @param sourcemapLines Lines of sourcemapping to convert generated TypeScript positions to source Civet positions
 * @param output Symbols to display in VSCode Outline
 * @param item
 */
export function convertNavTree(
  lineTable: number[],
  sourcemapLines: SourcemapLines | undefined,
  output: DocumentSymbol[],
  item: NavigationTree,
): boolean {
  let shouldInclude = shouldIncludeEntry(item);
  if (!shouldInclude && !item.childItems?.length) {
    return false;
  }

  const children = new Set(item.childItems || []);
  for (const span of item.spans) {
    const range = rangeFromTextSpan(span, lineTable, sourcemapLines);
    const symbolInfo = convertSymbol(item, range, lineTable, sourcemapLines);

    for (const child of children) {
      if (child.spans.some(span => !!intersectRanges(range, rangeFromTextSpan(span, lineTable, sourcemapLines)))) {
        const includedChild = convertNavTree(lineTable, sourcemapLines, symbolInfo.children!, child);
        shouldInclude = shouldInclude || includedChild;
        children.delete(child);
      }
    }

    if (shouldInclude) {
      output.push(symbolInfo);
    }
  }

  return shouldInclude;
}

function convertSymbol(item: NavigationTree, range: Range, lineTable: number[], sourcemapLines?: SourcemapLines): DocumentSymbol {
  const selectionRange = item.nameSpan ? rangeFromTextSpan(item.nameSpan, lineTable, sourcemapLines) : range;
  let label = item.text;

  switch (item.kind) {
    case ScriptElementKind.memberGetAccessorElement: label = `(get) ${label}`; break;
    case ScriptElementKind.memberSetAccessorElement: label = `(set) ${label}`; break;
  }

  const symbolInfo = makeDocumentSymbol(
    label,
    '',
    getSymbolKind(item.kind),
    range,
    containsRange(range, selectionRange) ? selectionRange : range
  );

  const kindModifiers = parseKindModifier(item.kindModifiers);
  if (kindModifiers.has(ScriptElementKindModifier.deprecatedModifier)) {
    symbolInfo.tags = [SymbolTag.Deprecated];
  }

  return symbolInfo;
}

function shouldIncludeEntry(item: NavigationTree | NavigationBarItem): boolean {
  if (item.kind === ScriptElementKind.alias) {
    return false;
  }
  return !!(item.text && item.text !== '<function>' && item.text !== '<class>');
}

function parseKindModifier(kindModifiers: string): Set<string> {
  return new Set(kindModifiers.split(/,|\s+/g));
}

function rangeFromTextSpan(span: TextSpan, lineTable: number[], sourcemapLines?: SourcemapLines): Range {
  const [l1, c1] = lookupLineColumn(lineTable, span.start)
  const [l2, c2] = lookupLineColumn(lineTable, span.start + span.length)

  const range = makeRange(l1, c1, l2, c2)

  if (sourcemapLines) {
    return remapRange(range, sourcemapLines)
  }

  return range
}

export function makeRange(l1: number, c1: number, l2: number, c2: number) {
  return {
    start: {
      line: l1,
      character: c1,
    },
    end: {
      line: l2,
      character: c2,
    }
  }
}

/**
 * Creates a new document symbol.
 *
 * @param name The name of the symbol.
 * @param detail Details for the symbol.
 * @param kind The kind of the symbol.
 * @param range The full range of the symbol.
 * @param selectionRange The range that should be reveal.
 */
function makeDocumentSymbol(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range): DocumentSymbol {
  return {
    name,
    detail,
    kind,
    range,
    selectionRange,
    children: []
  }
}

/**
 * A intersection of the two ranges.
 */
export function intersectRanges(a: Range, b: Range): Range | null {
  let { line: resultStartLineNumber, character: resultStartColumn } = a.start;
  let { line: resultEndLineNumber, character: resultEndColumn } = a.end;
  let { line: otherStartLineNumber, character: otherStartColumn } = b.start;
  let { line: otherEndLineNumber, character: otherEndColumn } = b.end;

  if (resultStartLineNumber < otherStartLineNumber) {
    resultStartLineNumber = otherStartLineNumber;
    resultStartColumn = otherStartColumn;
  } else if (resultStartLineNumber === otherStartLineNumber) {
    resultStartColumn = Math.max(resultStartColumn, otherStartColumn);
  }

  if (resultEndLineNumber > otherEndLineNumber) {
    resultEndLineNumber = otherEndLineNumber;
    resultEndColumn = otherEndColumn;
  } else if (resultEndLineNumber === otherEndLineNumber) {
    resultEndColumn = Math.min(resultEndColumn, otherEndColumn);
  }

  // Check if selection is now empty
  if (resultStartLineNumber > resultEndLineNumber) {
    return null;
  }
  if (resultStartLineNumber === resultEndLineNumber && resultStartColumn > resultEndColumn) {
    return null;
  }
  return makeRange(resultStartLineNumber, resultStartColumn, resultEndLineNumber, resultEndColumn);
}

/**
 * Test if `otherRange` is in `range`. If the ranges are equal, will return true.
 */
export function containsRange(range: Range, otherRange: Range): boolean {
  if (otherRange.start.line < range.start.line || otherRange.end.line < range.start.line) {
    return false;
  }
  if (otherRange.start.line > range.end.line || otherRange.end.line > range.end.line) {
    return false;
  }
  if (otherRange.start.line === range.start.line && otherRange.start.character < range.start.character) {
    return false;
  }
  if (otherRange.end.line === range.end.line && otherRange.end.character > range.end.character) {
    return false;
  }
  return true;
}

export function remapPosition(sourcemapLines: SourcemapLines, position: Position): Position {
  const { line, character } = position

  const textLine = sourcemapLines[line]
  // Return original position if no mapping at this line
  if (!textLine?.length) return position

  let i = 0, p = 0, l = textLine.length,
    lastMapping, lastMappingPosition = 0

  while (i < l) {
    const mapping = textLine[i]!
    p += mapping[0]!

    if (mapping.length === 4) {
      lastMapping = mapping
      lastMappingPosition = p
    }

    if (p >= character) {
      break
    }

    i++
  }

  if (lastMapping) {
    const srcLine = lastMapping[2]
    const srcChar = lastMapping[3]
    const newChar = srcChar + character - lastMappingPosition

    return {
      line: srcLine,
      character: newChar,
    }
  } else {
    console.error("no mapping for ", position)
    return position
  }
}

export function forwardMap(sourcemapLines: SourcemapLines, position: Position) {
  debugger
  const { line: origLine, character: origOffset } = position

  let col = 0
  let bestLine = -1,
    bestOffset = -1,
    foundLine = -1,
    foundOffset = -1

  sourcemapLines.forEach((line, i) => {
    col = 0
    line.forEach((mapping) => {
      col += mapping[0]

      if (mapping.length === 4) {
        // find best line without going beyond
        const [_p, _f, srcLine, srcOffset] = mapping
        if (srcLine <= origLine) {
          if (srcLine >= bestLine && (srcOffset <= origOffset)) {
            bestLine = srcLine
            bestOffset = srcOffset
            foundLine = i
            foundOffset = col
          }
        }
      }
    })
  })

  if (foundLine >= 0) {
    return {
      line: foundLine + origLine - bestLine,
      character: foundOffset + origOffset - bestOffset
    }
  }

  console.warn(`couldn't forward map src position: ${[origLine, origOffset]}`)
  return position
}

/**
 * Use sourcemap lines to remap the start and end position of a range.
 */
export function remapRange(range: Range, sourcemapLines: SourcemapLines,): Range {
  debugger
  return {
    start: remapPosition(sourcemapLines, range.start),
    end: remapPosition(sourcemapLines, range.end)
  }
}
