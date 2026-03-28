/*
 * SPDX-FileCopyrightText: 2025 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import {
  TextToModelPipelineRequest,
  TextToModelPipelineResult,
  TextToModelPipelineStatus,
  TextToModelRequest,
  TextToModelResult,
  TextToModelStatus,
} from './dto';

import { GenericRefinery, type RefineryOptions } from '@tools.refinery/client';

export class RefineryChat extends GenericRefinery {
  constructor(options: RefineryOptions) {
    super(options);
  }

  readonly textToModel = this.streaming(
    'textToModel',
    TextToModelRequest,
    TextToModelResult,
    TextToModelStatus,
  );

  readonly textToModelPipeline = this.streaming(
    'textToModelPipeline',
    TextToModelPipelineRequest,
    TextToModelPipelineResult,
    TextToModelPipelineStatus,
  );
}
