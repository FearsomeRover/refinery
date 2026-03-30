/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type { JsonOutput } from '@tools.refinery/client';
import type { ExtractedDomain } from '@tools.refinery/client/chat';

import { extractStructureSymbols } from './draftLint';

const MAX_TARGET_CLASSES = 3;
const MAX_TARGET_RELATIONS = 4;
const MAX_OPTIONAL_FEATURES = 2;
const POSITIVE_TUPLE_VALUES = new Set(['true', 'must']);

export interface RichnessTarget {
  symbolName: string;
  min: number;
  rationale: string;
}

export interface RichnessPattern {
  description: string;
  rationale: string;
}

export interface RichnessPlan {
  centralClasses: string[];
  groundedClasses: string[];
  groundedRelations: string[];
  targetInstances: RichnessTarget[];
  targetRelations: RichnessTarget[];
  optionalFeatures: string[];
  overlapPatterns: RichnessPattern[];
  guardrails: string[];
}

export interface CandidateRichnessAnalysis {
  randomSeed: number;
  classCounts: Record<string, number>;
  relationCounts: Record<string, number>;
  optionalFeaturesUsed: string[];
  matchedTargets: string[];
  unmetTargets: string[];
  overlapSatisfied: boolean;
  connectedComponentSize: number;
  nodeCount: number;
  richnessScore: number;
  groundingScore: number;
  totalScore: number;
  diversitySignature: string;
}

interface ScoredSymbol {
  symbolName: string;
  score: number;
}

function normalizeWord(word: string): string {
  const lowered = word.toLowerCase();
  if (lowered.endsWith('ies') && lowered.length > 3) {
    return `${lowered.slice(0, -3)}y`;
  }
  if (lowered.endsWith('s') && !lowered.endsWith('ss') && lowered.length > 3) {
    return lowered.slice(0, -1);
  }
  return lowered;
}

function splitIntoNormalizedWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[^A-Za-z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => normalizeWord(word));
}

function normalizePhrase(text: string): string {
  return splitIntoNormalizedWords(text).join(' ');
}

function createCorpusSections(
  text: string,
  extractedDomain: ExtractedDomain,
): string[] {
  return [
    text,
    extractedDomain.summary,
    ...extractedDomain.entities,
    ...extractedDomain.relations,
    ...extractedDomain.requirements,
    ...extractedDomain.examples,
  ].filter((value) => value.trim().length > 0);
}

function symbolMentionScore(symbolName: string, sections: string[]): number {
  const normalizedSymbol = normalizePhrase(symbolName);
  const symbolWords = normalizedSymbol.split(' ').filter((word) => word !== '');
  if (symbolWords.length === 0) {
    return 0;
  }

  let score = 0;
  for (const [index, section] of sections.entries()) {
    const normalizedSection = normalizePhrase(section);
    if (normalizedSection === '') {
      continue;
    }
    const matchesDirectPhrase = normalizedSection.includes(normalizedSymbol);
    const sectionWords = new Set(normalizedSection.split(' ').filter(Boolean));
    const matchesWordSet = symbolWords.every((word) => sectionWords.has(word));
    if (!matchesDirectPhrase && !matchesWordSet) {
      continue;
    }
    if (index === 0) {
      score += 5;
    } else if (index === 1) {
      score += 2;
    } else {
      score += 3;
    }
  }
  return score;
}

function rankSymbols(
  symbolNames: string[],
  sections: string[],
): ScoredSymbol[] {
  return symbolNames
    .map((symbolName) => ({
      symbolName,
      score: symbolMentionScore(symbolName, sections),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.symbolName.localeCompare(right.symbolName),
    );
}

function createClassTargets(groundedClasses: ScoredSymbol[]): RichnessTarget[] {
  return groundedClasses
    .slice(0, MAX_TARGET_CLASSES)
    .map(({ symbolName }, index) => ({
      symbolName,
      min: index === 0 ? 3 : 2,
      rationale:
        index === 0
          ? 'Central prompt-grounded class should appear more than once in richer examples.'
          : 'Prompt-grounded supporting class should not collapse to a single trivial instance.',
    }));
}

function createRelationTargets(
  groundedRelations: ScoredSymbol[],
): RichnessTarget[] {
  return groundedRelations
    .slice(0, MAX_TARGET_RELATIONS)
    .map(({ symbolName }, index) => ({
      symbolName,
      min: index < 2 ? 2 : 1,
      rationale:
        index < 2
          ? 'Central prompt-grounded relation should be instantiated multiple times when possible.'
          : 'Prompt-grounded relation should appear at least once in non-trivial examples.',
    }));
}

function countPromptMentionedOptionals(
  groundedRelations: ScoredSymbol[],
  targetRelations: RichnessTarget[],
): string[] {
  const targetedNames = new Set(
    targetRelations.map(({ symbolName }) => symbolName),
  );
  return groundedRelations
    .filter(({ symbolName }) => !targetedNames.has(symbolName))
    .slice(0, MAX_OPTIONAL_FEATURES)
    .map(({ symbolName }) => symbolName);
}

function isPositiveTupleValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return POSITIVE_TUPLE_VALUES.has(value) || value.length > 0;
  }
  return false;
}

function countPositiveFacts(json: JsonOutput, symbolName: string): number {
  const tuples = json.partialInterpretation[symbolName] ?? [];
  return tuples.filter((tuple) => isPositiveTupleValue(tuple.at(-1))).length;
}

function countNodeParticipation(
  json: JsonOutput,
  relationNames: string[],
): Map<number, number> {
  const participation = new Map<number, number>();
  for (const relationName of relationNames) {
    const tuples = json.partialInterpretation[relationName] ?? [];
    for (const tuple of tuples) {
      if (!isPositiveTupleValue(tuple.at(-1))) {
        continue;
      }
      for (const value of tuple.slice(0, -1)) {
        if (typeof value !== 'number') {
          continue;
        }
        participation.set(value, (participation.get(value) ?? 0) + 1);
      }
    }
  }
  return participation;
}

function computeConnectedComponentSize(
  json: JsonOutput,
  relationNames: string[],
): number {
  const nodeIds = new Set<number>();
  const adjacency = new Map<number, Set<number>>();

  for (const relationName of relationNames) {
    const tuples = json.partialInterpretation[relationName] ?? [];
    for (const tuple of tuples) {
      if (!isPositiveTupleValue(tuple.at(-1))) {
        continue;
      }
      const nodeArgs = tuple.filter(
        (value): value is number => typeof value === 'number',
      );
      for (const nodeId of nodeArgs) {
        nodeIds.add(nodeId);
        adjacency.set(nodeId, adjacency.get(nodeId) ?? new Set<number>());
      }
      for (let i = 0; i < nodeArgs.length; i += 1) {
        for (let j = i + 1; j < nodeArgs.length; j += 1) {
          const left = nodeArgs[i]!;
          const right = nodeArgs[j]!;
          adjacency.get(left)?.add(right);
          adjacency.get(right)?.add(left);
        }
      }
    }
  }

  let best = 0;
  const visited = new Set<number>();
  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }
    const queue = [nodeId];
    visited.add(nodeId);
    let size = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      size += 1;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        queue.push(next);
      }
    }
    best = Math.max(best, size);
  }

  return best;
}

export function deriveRichnessPlan(
  text: string,
  extractedDomain: ExtractedDomain,
  structureSource: string,
): RichnessPlan {
  const symbols = extractStructureSymbols(structureSource);
  const sections = createCorpusSections(text, extractedDomain);
  const groundedClasses = rankSymbols(symbols.classes, sections);
  const groundedRelations = rankSymbols(symbols.references, sections);
  const targetInstances = createClassTargets(groundedClasses);
  const targetRelations = createRelationTargets(groundedRelations);
  const optionalFeatures = countPromptMentionedOptionals(
    groundedRelations,
    targetRelations,
  );

  const overlapPatterns: RichnessPattern[] =
    targetRelations.length >= 2 || targetInstances.length >= 2
      ? [
          {
            description:
              'Prefer at least one object reused across multiple prompt-grounded relations.',
            rationale:
              'Role overlap makes examples more informative and less trivially disconnected.',
          },
        ]
      : [];

  return {
    centralClasses: targetInstances.map(({ symbolName }) => symbolName),
    groundedClasses: groundedClasses.map(({ symbolName }) => symbolName),
    groundedRelations: groundedRelations.map(({ symbolName }) => symbolName),
    targetInstances,
    targetRelations,
    optionalFeatures,
    overlapPatterns,
    guardrails: [
      'Only use classes already present in the generated structure.',
      'Only use relations already present in the generated structure.',
      'Do not treat example richness targets as permanent domain constraints.',
      'Do not introduce prompt-unsupported concepts while seeking richer examples.',
    ],
  };
}

export function analyzeCandidateRichness(
  randomSeed: number,
  json: JsonOutput | undefined,
  plan: RichnessPlan,
): CandidateRichnessAnalysis {
  const classCounts: Record<string, number> = {};
  const relationCounts: Record<string, number> = {};
  const matchedTargets: string[] = [];
  const unmetTargets: string[] = [];

  if (json === undefined) {
    return {
      randomSeed,
      classCounts,
      relationCounts,
      optionalFeaturesUsed: [],
      matchedTargets,
      unmetTargets,
      overlapSatisfied: false,
      connectedComponentSize: 0,
      nodeCount: 0,
      richnessScore: 0,
      groundingScore: 0,
      totalScore: 0,
      diversitySignature: JSON.stringify({ randomSeed, missingJson: true }),
    };
  }

  for (const target of plan.targetInstances) {
    const count = countPositiveFacts(json, target.symbolName);
    classCounts[target.symbolName] = count;
    if (count >= target.min) {
      matchedTargets.push(`class:${target.symbolName}`);
    } else {
      unmetTargets.push(`class:${target.symbolName}`);
    }
  }

  for (const target of plan.targetRelations) {
    const count = countPositiveFacts(json, target.symbolName);
    relationCounts[target.symbolName] = count;
    if (count >= target.min) {
      matchedTargets.push(`relation:${target.symbolName}`);
    } else {
      unmetTargets.push(`relation:${target.symbolName}`);
    }
  }

  const optionalFeaturesUsed = plan.optionalFeatures.filter((symbolName) => {
    const count = countPositiveFacts(json, symbolName);
    relationCounts[symbolName] = count;
    return count > 0;
  });

  const overlapRelationNames = [
    ...plan.targetRelations.map(({ symbolName }) => symbolName),
    ...plan.optionalFeatures,
  ];
  const participation = countNodeParticipation(json, overlapRelationNames);
  const overlapSatisfied = [...participation.values()].some(
    (count) => count >= 2,
  );
  const connectedComponentSize = computeConnectedComponentSize(
    json,
    overlapRelationNames,
  );
  const nodeCount = json.nodes.length;

  let richnessScore = 0;
  for (const target of plan.targetInstances) {
    const count = classCounts[target.symbolName] ?? 0;
    richnessScore += Math.min(count, target.min) * 2;
  }
  for (const target of plan.targetRelations) {
    const count = relationCounts[target.symbolName] ?? 0;
    richnessScore += Math.min(count, target.min) * 2;
  }
  richnessScore += optionalFeaturesUsed.length;
  if (overlapSatisfied) {
    richnessScore += 2;
  }
  if (connectedComponentSize >= 3) {
    richnessScore += 2;
  } else if (connectedComponentSize >= 2) {
    richnessScore += 1;
  }

  const groundingScore =
    matchedTargets.length * 2 +
    optionalFeaturesUsed.length -
    unmetTargets.length;
  const totalScore = richnessScore + groundingScore;

  return {
    randomSeed,
    classCounts,
    relationCounts,
    optionalFeaturesUsed,
    matchedTargets,
    unmetTargets,
    overlapSatisfied,
    connectedComponentSize,
    nodeCount,
    richnessScore,
    groundingScore,
    totalScore,
    diversitySignature: JSON.stringify({
      classCounts,
      relationCounts,
      optionalFeaturesUsed,
      overlapSatisfied,
      connectedComponentSize,
    }),
  };
}

export function rankCandidatesByRichnessAndDiversity(
  analyses: CandidateRichnessAnalysis[],
  critiqueCounts: number[],
): CandidateRichnessAnalysis[] {
  const remaining = [...analyses];
  const ranked: CandidateRichnessAnalysis[] = [];
  const usedSignatures = new Set<string>();

  while (remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftCritiquePenalty =
        (critiqueCounts[left.randomSeed - 1] ?? 0) * 2;
      const rightCritiquePenalty =
        (critiqueCounts[right.randomSeed - 1] ?? 0) * 2;
      const leftDiversityBonus = usedSignatures.has(left.diversitySignature)
        ? 0
        : 2;
      const rightDiversityBonus = usedSignatures.has(right.diversitySignature)
        ? 0
        : 2;
      const leftScore =
        left.totalScore - leftCritiquePenalty + leftDiversityBonus;
      const rightScore =
        right.totalScore - rightCritiquePenalty + rightDiversityBonus;
      return rightScore - leftScore || left.randomSeed - right.randomSeed;
    });
    const next = remaining.shift();
    if (next === undefined) {
      break;
    }
    ranked.push(next);
    usedSignatures.add(next.diversitySignature);
  }

  return ranked;
}
