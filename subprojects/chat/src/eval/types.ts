/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type {
  ExtractedDomain,
  TextToModelPipelineResult,
} from '@tools.refinery/client/chat';

export interface TestCase {
  id: string;
  source: string;
  naturalLanguageInput: string;
  metamodelSource?: string;
  expected: {
    entities?: string[];
    relations?: string[];
    requirements?: string[];
    referenceModel?: string;
  };
}

export interface StageResult {
  success: boolean;
  duration: number;
}

export interface EvalStages {
  extractDomain?: StageResult & { output?: ExtractedDomain };
  structure?: StageResult & { output?: string };
  predicates?: StageResult & { iterations?: number };
  candidates?: StageResult & { count?: number };
  critique?: StageResult & { findings?: string[] };
}

export interface MetricScores {
  syntacticValidity: boolean;
  semanticValidity: boolean;
  entityRecall?: number;
  entityPrecision?: number;
  entityF1?: number;
  relationRecall?: number;
  relationPrecision?: number;
  relationF1?: number;
  structuralSimilarity?: number;
}

export interface EvalResult {
  testCase: TestCase;
  stages: EvalStages;
  finalResult?: TextToModelPipelineResult;
  metrics: MetricScores;
  error?: string;
  totalDuration: number;
}

export interface EvalConfig {
  datasets: DatasetName[];
  sampleSize: number;
  candidateCount: number;
  outputDir: string;
  chatBaseURL: string;
  datasetCacheDir: string;
}

export type DatasetName = 'text2vql' | 'userStories' | 'modelSet' | 'zenodo';

export interface DatasetAdapter {
  name: DatasetName;
  download(cacheDir: string): Promise<void>;
  loadTestCases(cacheDir: string, sampleSize: number): Promise<TestCase[]>;
}
