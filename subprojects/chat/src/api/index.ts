/*
 * SPDX-FileCopyrightText: 2025 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import express from 'express';

import { setupAPIClients, sseHandler } from '../middlewares';

import textToModel from './textToModel';
import textToModelPipeline from './textToModelPipeline';

const router = express.Router();

router.use(setupAPIClients);

router.use(sseHandler);

router.post('/textToModel', textToModel);
router.post('/textToModelPipeline', textToModelPipeline);

export default router;
