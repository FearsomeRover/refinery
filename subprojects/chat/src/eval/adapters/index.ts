/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type { DatasetAdapter, DatasetName } from '../types';

import { modelSetAdapter } from './modelSet';
import { text2vqlAdapter } from './text2vql';
import { userStoriesAdapter } from './userStories';
import { zenodoAdapter } from './zenodo';

const adapters: Record<DatasetName, DatasetAdapter> = {
  userStories: userStoriesAdapter,
  text2vql: text2vqlAdapter,
  modelSet: modelSetAdapter,
  zenodo: zenodoAdapter,
};

export default adapters;
