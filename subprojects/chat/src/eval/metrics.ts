/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type { JsonOutput } from '@tools.refinery/client';
import type {
  TextToModelPipelineResult,
  ExtractedDomain,
} from '@tools.refinery/client/chat';

import type { MetricScores, TestCase } from './types';

function normalize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_\-]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      curr.push(
        Math.min(
          curr[j]! + 1,
          prev[j + 1]! + 1,
          prev[j]! + (a[i] === b[j] ? 0 : 1),
        ),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

function fuzzyMatch(candidate: string, target: string): boolean {
  const normCandidate = normalize(candidate);
  const normTarget = normalize(target);

  if (normCandidate === normTarget) return true;
  if (normCandidate.includes(normTarget) || normTarget.includes(normCandidate))
    return true;

  const threshold = Math.max(2, Math.floor(normTarget.length / 3));
  return levenshtein(normCandidate, normTarget) <= threshold;
}

function computePrecisionRecallF1(
  actual: string[],
  expected: string[],
): { precision: number; recall: number; f1: number } {
  if (expected.length === 0 && actual.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  if (expected.length === 0) {
    return { precision: 0, recall: 1, f1: 0 };
  }
  if (actual.length === 0) {
    return { precision: 1, recall: 0, f1: 0 };
  }

  const matched = new Set<number>();
  let truePositives = 0;

  for (const act of actual) {
    for (let i = 0; i < expected.length; i += 1) {
      if (!matched.has(i) && fuzzyMatch(act, expected[i]!)) {
        truePositives += 1;
        matched.add(i);
        break;
      }
    }
  }

  const precision = truePositives / actual.length;
  const recall = truePositives / expected.length;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

function extractClassNames(json: JsonOutput): string[] {
  return json.relations
    .filter((r) => r.detail.type === 'class' && !r.detail.isAbstract)
    .map((r) => r.simpleName);
}

function extractReferenceNames(json: JsonOutput): string[] {
  return json.relations
    .filter(
      (r) => r.detail.type === 'reference' || r.detail.type === 'attribute',
    )
    .map((r) => r.simpleName);
}

function checkSyntacticValidity(result: TextToModelPipelineResult): boolean {
  return !result.issues.some((issue) => issue.severity === 'error');
}

function checkSemanticValidity(result: TextToModelPipelineResult): boolean {
  if (result.json === undefined) return false;
  const { json } = result;

  for (const relation of json.relations) {
    const tuples = json.partialInterpretation[relation.name] ?? [];
    for (const tuple of tuples) {
      const value = tuple[tuple.length - 1];
      if (value === 'error' || (typeof value === 'object' && value !== null && 'error' in value)) {
        return false;
      }
    }
  }
  return true;
}

function computeStructuralSimilarity(
  json: JsonOutput,
  expectedEntities: string[],
  expectedRelations: string[],
): number {
  const actualSet = new Set([
    ...extractClassNames(json).map(normalize),
    ...extractReferenceNames(json).map(normalize),
  ]);
  const expectedSet = new Set([
    ...expectedEntities.map(normalize),
    ...expectedRelations.map(normalize),
  ]);

  if (actualSet.size === 0 && expectedSet.size === 0) return 1;
  if (actualSet.size === 0 || expectedSet.size === 0) return 0;

  let intersection = 0;
  for (const item of actualSet) {
    if (expectedSet.has(item)) {
      intersection += 1;
    }
  }
  const union = new Set([...actualSet, ...expectedSet]).size;
  return intersection / union;
}

export function computeMetrics(
  testCase: TestCase,
  result: TextToModelPipelineResult | undefined,
  extractedDomain: ExtractedDomain | undefined,
): MetricScores {
  if (result === undefined) {
    return {
      syntacticValidity: false,
      semanticValidity: false,
    };
  }

  const syntacticValidity = checkSyntacticValidity(result);
  const semanticValidity = checkSemanticValidity(result);

  const scores: MetricScores = { syntacticValidity, semanticValidity };

  // Entity coverage: compare extracted/generated entities against expected
  if (testCase.expected.entities !== undefined && testCase.expected.entities.length > 0) {
    // Use both domain extraction output and generated model structure
    const actualEntities: string[] = [];

    if (extractedDomain !== undefined) {
      actualEntities.push(...extractedDomain.entities);
    }
    if (result.json !== undefined) {
      actualEntities.push(...extractClassNames(result.json));
    }

    const uniqueActual = [...new Set(actualEntities.map(normalize))].map(
      (n) => actualEntities.find((e) => normalize(e) === n)!,
    );

    const entityMetrics = computePrecisionRecallF1(
      uniqueActual,
      testCase.expected.entities,
    );
    scores.entityPrecision = entityMetrics.precision;
    scores.entityRecall = entityMetrics.recall;
    scores.entityF1 = entityMetrics.f1;
  }

  // Relation coverage
  if (testCase.expected.relations !== undefined && testCase.expected.relations.length > 0) {
    const actualRelations: string[] = [];

    if (extractedDomain !== undefined) {
      actualRelations.push(...extractedDomain.relations);
    }
    if (result.json !== undefined) {
      actualRelations.push(...extractReferenceNames(result.json));
    }

    const uniqueActual = [...new Set(actualRelations.map(normalize))].map(
      (n) => actualRelations.find((r) => normalize(r) === n)!,
    );

    const relationMetrics = computePrecisionRecallF1(
      uniqueActual,
      testCase.expected.relations,
    );
    scores.relationPrecision = relationMetrics.precision;
    scores.relationRecall = relationMetrics.recall;
    scores.relationF1 = relationMetrics.f1;
  }

  // Structural similarity (Jaccard)
  if (
    result.json !== undefined &&
    (testCase.expected.entities ?? []).length +
      (testCase.expected.relations ?? []).length >
      0
  ) {
    scores.structuralSimilarity = computeStructuralSimilarity(
      result.json,
      testCase.expected.entities ?? [],
      testCase.expected.relations ?? [],
    );
  }

  return scores;
}
