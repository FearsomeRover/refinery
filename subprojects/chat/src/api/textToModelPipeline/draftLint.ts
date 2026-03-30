/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

export interface ExtractedStructureSymbols {
  classes: string[];
  references: string[];
}

export interface DraftLintResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

const CLASS_WITH_BODY_REGEX = /class\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/gu;
const CLASS_DECLARATION_REGEX = /class\s+([A-Za-z_]\w*)\s*(?:\{|\.)/gu;
const REFERENCE_DECLARATION_REGEX =
  /^\s*[A-Za-z_]\w*(?:\[[^\]]+\])?\s+([a-zA-Z_]\w*)\s*$/u;
const ASSERTION_REGEX = /^([A-Za-z_]\w*)\((.*)\)\.\s*$/u;
const IDENTIFIER_REGEX = /^[A-Za-z_]\w*$/u;
const ALLOWED_NON_ASSERTION_PREFIXES = ['default ', 'scope ', 'error ', '//'];

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function splitArguments(argumentText: string): string[] {
  return argumentText
    .split(',')
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from(
    { length: right.length + 1 },
    (_value, index) => index,
  );
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const insertion = current[j]! + 1;
      const deletion = previous[j + 1]! + 1;
      const substitution = previous[j]! + (left[i] === right[j] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }
    previous = current;
  }
  return previous[right.length]!;
}

function findClosestSymbol(
  symbol: string,
  candidates: string[],
): string | undefined {
  let bestCandidate: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(
      symbol.toLowerCase(),
      candidate.toLowerCase(),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  if (bestCandidate === undefined) {
    return undefined;
  }
  const threshold = Math.max(2, Math.floor(bestCandidate.length / 3));
  return bestDistance <= threshold ? bestCandidate : undefined;
}

function formatDeclaredSymbols(kind: string, symbols: string[]): string {
  if (symbols.length === 0) {
    return `No ${kind} are declared in the generated structure.`;
  }
  return `Declared ${kind} include ${symbols.map((symbol) => `\`${symbol}\``).join(', ')}.`;
}

function isAllowedNonAssertion(line: string): boolean {
  return ALLOWED_NON_ASSERTION_PREFIXES.some((prefix) =>
    line.startsWith(prefix),
  );
}

export function extractStructureSymbols(
  source: string,
): ExtractedStructureSymbols {
  const classes = new Set<string>();
  const references = new Set<string>();

  for (const match of source.matchAll(CLASS_DECLARATION_REGEX)) {
    const className = match[1];
    if (className !== undefined) {
      classes.add(className);
    }
  }

  for (const match of source.matchAll(CLASS_WITH_BODY_REGEX)) {
    const body = match[2] ?? '';
    for (const line of body.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const referenceMatch = REFERENCE_DECLARATION_REGEX.exec(trimmed);
      const referenceName = referenceMatch?.[1];
      if (referenceName !== undefined) {
        references.add(referenceName);
      }
    }
  }

  return {
    classes: uniqueSorted(classes),
    references: uniqueSorted(references),
  };
}

export function lintDraftAssertions(
  structureSource: string,
  assertions: string,
): DraftLintResult {
  const { classes, references } = extractStructureSymbols(structureSource);
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rawLine of assertions.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('```')) {
      errors.push(
        'Markdown code fences are not valid Refinery assertions. Return only raw assertions.',
      );
      continue;
    }
    if (isAllowedNonAssertion(line)) {
      continue;
    }

    const assertionMatch = ASSERTION_REGEX.exec(line);
    if (assertionMatch === null) {
      errors.push(`Malformed or non-assertion line: \`${line}\`.`);
      continue;
    }

    const symbol = assertionMatch[1]!;
    const argumentsText = assertionMatch[2] ?? '';
    const args = splitArguments(argumentsText);

    if (args.length === 1) {
      if (!classes.includes(symbol)) {
        const closest = findClosestSymbol(symbol, classes);
        errors.push(
          closest === undefined
            ? `Unknown class \`${symbol}\`. ${formatDeclaredSymbols('classes', classes)}`
            : `Unknown class \`${symbol}\`. Did you mean \`${closest}\`? ${formatDeclaredSymbols('classes', classes)}`,
        );
      }
      if (!IDENTIFIER_REGEX.test(args[0]!)) {
        errors.push(
          `Class assertion \`${line}\` must use a simple identifier argument.`,
        );
      }
      continue;
    }

    if (args.length === 2) {
      if (!references.includes(symbol)) {
        const closest = findClosestSymbol(symbol, references);
        errors.push(
          closest === undefined
            ? `Unknown relation \`${symbol}\`. ${formatDeclaredSymbols('relations', references)}`
            : `Unknown relation \`${symbol}\`. Did you mean \`${closest}\`? ${formatDeclaredSymbols('relations', references)}`,
        );
      }
      const invalidArgs = args.filter((arg) => !IDENTIFIER_REGEX.test(arg));
      if (invalidArgs.length > 0) {
        errors.push(
          `Relation assertion \`${line}\` must use simple identifier arguments.`,
        );
      }
      continue;
    }

    warnings.push(
      `Skipping advanced assertion \`${line}\` during draft lint because it has ${args.length} arguments.`,
    );
  }

  return {
    passed: errors.length === 0,
    errors: uniqueSorted(errors),
    warnings: uniqueSorted(warnings),
  };
}

export function draftLintToChatMessage(result: DraftLintResult): string {
  const sections = [
    'The generated assertions do not match the generated structure.',
    '',
    'Problems found:',
    ...result.errors.map((error) => `* ${error}`),
  ];

  if (result.warnings.length > 0) {
    sections.push(
      '',
      'Warnings:',
      ...result.warnings.map((warning) => `* ${warning}`),
    );
  }

  sections.push(
    '',
    'Please repair only the assertions. Do not modify the structure.',
  );
  return sections.join('\n');
}

export function normalizeDraftText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
