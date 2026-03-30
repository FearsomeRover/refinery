/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import z from 'zod/v4';

import {
  ConcretizationSuccessResult,
  JsonOutput,
  OutputFormats,
  ProblemInput,
} from '@tools.refinery/client';

export const TextToModelPipelineRequest = z.object({
  metamodel: ProblemInput,
  text: z.string(),
  format: OutputFormats.prefault({}),
  candidateCount: z.number().int().min(1).max(5).default(3),
});

export type TextToModelPipelineRequest = z.infer<
  typeof TextToModelPipelineRequest
>;

export const PipelineCandidate = z.object({
  randomSeed: z.number(),
  branchIndex: z.number().optional(),
  branchExplanation: z.string().optional(),
  source: z.string().optional(),
  json: JsonOutput.optional(),
  critique: z.string().array().default([]),
});

export type PipelineCandidate = z.infer<typeof PipelineCandidate>;

export const ExtractedDomain = z.object({
  summary: z.string(),
  entities: z.string().array().default([]),
  relations: z.string().array().default([]),
  requirements: z.string().array().default([]),
  examples: z.string().array().default([]),
  ambiguities: z.string().array().default([]),
  assumptions: z.string().array().default([]),
});

export type ExtractedDomain = z.infer<typeof ExtractedDomain>;

export const TextToModelPipelineResult = ConcretizationSuccessResult.extend({
  extractedDomain: ExtractedDomain,
  structureSource: z.string(),
  assumptions: z.string().array().default([]),
  findings: z.string().array().default([]),
  candidates: PipelineCandidate.array().default([]),
});

export type TextToModelPipelineResult = z.infer<
  typeof TextToModelPipelineResult
>;

export const TextToModelPipelineStatus = z.object({
  role: z.enum(['refinery', 'assistant']),
  stage: z.enum([
    'extract',
    'structure',
    'predicates',
    'preview',
    'concretize',
    'candidates',
    'critique',
    'aggregate',
  ]),
  kind: z.enum(['started', 'progress', 'warning', 'completed']),
  content: z.string(),
});

export type TextToModelPipelineStatus = z.infer<
  typeof TextToModelPipelineStatus
>;
