/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DatasetAdapter, TestCase } from '../types';

const REPO_URL =
  'https://github.com/ace-design/qualified-user-stories.git';
const GROUND_TRUTH_DIR = 'ground-truth';

interface Annotation {
  personas?: { name: string }[];
  entities?: { name: string; is_main_entity?: boolean }[];
  actions?: { name: string }[];
  triggers?: { source: string; target: string }[];
  targets?: { source: string; target: string }[];
  contains?: { source: string; target: string }[];
}

interface StoryEntry {
  text?: string;
  annotation?: Annotation;
}

interface GroundTruthFile {
  name?: string;
  stories?: StoryEntry[];
}

function extractEntities(annotation: Annotation): string[] {
  const entities = new Set<string>();
  for (const entity of annotation.entities ?? []) {
    if (entity.name) entities.add(entity.name);
  }
  for (const persona of annotation.personas ?? []) {
    if (persona.name) entities.add(persona.name);
  }
  return [...entities];
}

function extractRelations(annotation: Annotation): string[] {
  const relations: string[] = [];
  for (const trigger of annotation.triggers ?? []) {
    relations.push(`${trigger.source} triggers ${trigger.target}`);
  }
  for (const target of annotation.targets ?? []) {
    relations.push(`${target.source} targets ${target.target}`);
  }
  for (const contains of annotation.contains ?? []) {
    relations.push(`${contains.source} contains ${contains.target}`);
  }
  return relations;
}

export const userStoriesAdapter: DatasetAdapter = {
  name: 'userStories',

  async download(cacheDir: string): Promise<void> {
    const repoDir = join(cacheDir, 'qualified-user-stories');
    if (existsSync(join(repoDir, '.git'))) {
      return;
    }
    console.log('[userStories] Cloning repository...');
    execFileSync('git', ['clone', '--depth', '1', REPO_URL, repoDir], {
      stdio: 'inherit',
    });
  },

  async loadTestCases(
    cacheDir: string,
    sampleSize: number,
  ): Promise<TestCase[]> {
    const groundTruthPath = join(
      cacheDir,
      'qualified-user-stories',
      GROUND_TRUTH_DIR,
    );

    if (!existsSync(groundTruthPath)) {
      throw new Error(
        `Ground truth directory not found at ${groundTruthPath}. Run download first.`,
      );
    }

    const files = readdirSync(groundTruthPath).filter((f) =>
      f.endsWith('.json'),
    );
    const testCases: TestCase[] = [];

    for (const file of files) {
      const raw = readFileSync(join(groundTruthPath, file), 'utf-8');
      const data = JSON.parse(raw) as GroundTruthFile;
      const backlogName = data.name ?? file.replace('.json', '');

      for (const [index, story] of (data.stories ?? []).entries()) {
        if (story.text === undefined || story.annotation === undefined) {
          continue;
        }

        const entities = extractEntities(story.annotation);
        const relations = extractRelations(story.annotation);

        if (entities.length === 0) continue;

        testCases.push({
          id: `userStories-${backlogName}-${index}`,
          source: 'userStories',
          naturalLanguageInput: story.text,
          expected: {
            entities,
            relations,
          },
        });
      }
    }

    // Shuffle deterministically and take sample
    testCases.sort((a, b) => a.id.localeCompare(b.id));
    return testCases.slice(0, sampleSize);
  },
};
