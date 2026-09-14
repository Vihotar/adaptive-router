/**
 * failure.mjs — Unified Failure Formatting & Reporting Layer
 *
 * Ensures Adaptive Router never reports a bare FAILED status.
 * Every failure captures:
 *  - Plain-business-language reason
 *  - Worker and model
 *  - Stage (Build, Validation, Test, Review)
 *  - Worker completion status (distinguishing generation completion from post-generation rejection)
 *  - Recommended next actions and actionable buttons
 *  - Strict secret sanitization (zero keys, tokens, or credentials)
 */

import { sanitizeText } from './events.mjs';
import { formatWorkerName } from './coding.mjs';

/**
 * Normalizes stage string into canonical representation.
 */
export function normalizeFailureStage(stage, rawError = '') {
  const s = String(stage || '').toLowerCase();
  const err = String(rawError || '').toLowerCase();

  if (s.includes('review') || err.includes('review') || err.includes('audit')) return 'Review';
  if (s.includes('test') || err.includes('test') || err.includes('browser') || err.includes('checks verified')) return 'Test';
  if (s.includes('validat') || err.includes('150 kb') || err.includes('safepath') || err.includes('deliverable exceeds') || err.includes('duplicate file') || err.includes('deliverable changed')) return 'Validation';
  if (s.includes('build') || s.includes('draft') || err.includes('draft') || err.includes('econnrefused') || err.includes('spawn')) return 'Build';
  if (s.includes('rout') || err.includes('worker') || err.includes('candidate')) return 'Build';
  return 'Validation';
}

/**
 * Generates plain-business-language explanation from error and context.
 */
export function explainFailureReason({ errorText = '', stage = 'Build', workerName = '', workerCompleted = false }) {
  const err = String(errorText || '');
  const errLower = err.toLowerCase();

  // 1. Deliverable size limit
  if (errLower.includes('150 kb') || errLower.includes('exceeds 150')) {
    if (workerCompleted) {
      return `Worker ${workerName || 'Builder'} completed successfully, but deliverable validation failed because combined project files exceed the 150 KB size limit.`;
    }
    return `Deliverable validation failed: combined files exceed the 150 KB size limit.`;
  }

  // 2. Deliverable structure / file counts
  if (errLower.includes('expected 1–20 deliverable files') || errLower.includes('expected 1-20 deliverable files') || errLower.includes('no files returned') || errLower.includes('empty file list') || errLower.includes('no builder produced a usable draft') || errLower.includes('only index.html') || errLower.includes('may be edited')) {
    return `Worker ${workerName || 'Builder'} returned an unusable deliverable: expected between 1 and 20 valid deliverable files, but none were accepted (${err}).`;
  }

  if (errLower.includes('unsafe deliverable path')) {
    return `Deliverable rejected: output contained an unsafe file path outside project boundaries (${err}).`;
  }

  if (errLower.includes('duplicate file path')) {
    return `Deliverable rejected: output contained duplicate file paths.`;
  }

  if (errLower.includes('deliverable changed after review')) {
    return `Integrity check failed: deliverable files changed after independent review approval.`;
  }

  if (errLower.includes('missing required file') || errLower.includes('required file missing')) {
    return `Worker output validation failed: a required file specified in the task contract was missing.`;
  }

  // 3. Worker process crash / network failure
  if (errLower.includes('econnrefused') || errLower.includes('failed to spawn') || errLower.includes('enoent') || errLower.includes('process exited') || errLower.includes('spawn') || errLower.includes('connection refused')) {
    return `Worker ${workerName || 'service'} crashed or was unreachable: connection to the local worker process was refused.`;
  }

  // 3b. All workers exhausted / unavailable
  if (errLower.includes('no available independent') || errLower.includes('no eligible worker')) {
    if (errLower.includes('econnrefused') || errLower.includes('refused') || errLower.includes('spawn') || errLower.includes('enoent')) {
      return `Worker ${workerName || 'service'} crashed or was unreachable: connection to the local worker process was refused.`;
    }
    if (errLower.includes('quota') || errLower.includes('rate limit')) {
      return `All eligible candidate workers for ${stage.toLowerCase()} reached usage or quota limits.`;
    }
    if (errLower.includes('invalid') || errLower.includes('schema') || errLower.includes('syntaxerror') || errLower.includes('deliverable') || errLower.includes('files') || errLower.includes('unusable')) {
      return `Worker ${workerName || 'Builder'} returned an invalid or unusable deliverable structure: ${err}.`;
    }
    return `No available independent ${stage.toLowerCase()} worker could complete the task. Work is saved; retry after a worker becomes available.`;
  }

  // 4. Schema validation
  if (errLower.includes('schema') || errLower.includes('json') || errLower.includes('syntaxerror') || errLower.includes('invalid output')) {
    return `Worker ${workerName || 'Builder'} returned an invalid output structure that could not be parsed into project deliverables.`;
  }

  // 5. Quota / rate limit
  if (errLower.includes('quota') || errLower.includes('rate limit') || errLower.includes('429') || errLower.includes('overloaded')) {
    return `Worker ${workerName || 'service'} reached usage or quota limits and could not complete the task.`;
  }

  // 6. Reviewer failure
  if (stage === 'Review') {
    return `Independent reviewer ${workerName || 'worker'} encountered an error during code audit: ${err}.`;
  }

  // 7. Testing failure
  if (stage === 'Test') {
    return `Automated test verification failed: ${err}.`;
  }

  // 8. General fallback
  if (workerCompleted) {
    return `Worker ${workerName || 'Builder'} completed generation, but output was rejected during ${stage.toLowerCase()}: ${err}.`;
  }
  return `Task execution failed during ${stage.toLowerCase()} with ${workerName || 'worker'}: ${err}.`;
}

/**
 * Determines recommended action string based on error characteristics.
 */
export function getRecommendedAction({ errorText = '', stage = 'Build', isQuota = false, isCrash = false }) {
  const errLower = String(errorText || '').toLowerCase();

  if (errLower.includes('150 kb') || errLower.includes('exceeds 150')) {
    return 'Reduce project baseline size, request fewer files in the instruction, or split the work into smaller tasks.';
  }
  if (isCrash || errLower.includes('econnrefused') || errLower.includes('spawn') || errLower.includes('enoent')) {
    return 'Check if the worker application is running, or retry using another available worker.';
  }
  if (isQuota || errLower.includes('quota') || errLower.includes('429')) {
    return 'Wait for worker quota to reset, or enable another qualified worker in workers.json.';
  }
  if (stage === 'Review') {
    return 'Enable another qualified independent reviewer in workers.json and retry the review.';
  }
  if (stage === 'Validation') {
    return 'Review the required file structure and retry with another worker or clearer instruction.';
  }
  return 'Retry with the same worker or switch to another available worker.';
}

/**
 * Formats a complete, validated, sanitized Task Failure descriptor.
 */
export function formatTaskFailure({
  error = null,
  stage = null,
  worker = null,
  model = null,
  workerCompleted = false,
  proposedFiles = null,
  task = null
} = {}) {
  const rawMsg = typeof error === 'string' ? error : (error?.message || task?.error || 'Unknown error');
  const sanitizedMsg = sanitizeText(rawMsg);

  const normalizedStage = normalizeFailureStage(stage || error?.stage, sanitizedMsg);
  const activeWorker = worker || error?.worker || task?.builderWorker || task?.selectedBuilder || task?.contributors?.[0] || 'adaptive-router';
  const workerDisplayName = formatWorkerName(activeWorker) || activeWorker.toUpperCase();
  const activeModel = model || error?.model || task?.builderModel || null;

  // Distinguish whether the worker finished generating output before validation/assembly failed
  const didWorkerComplete = Boolean(
    workerCompleted ||
    error?.workerCompleted ||
    normalizedStage === 'Validation' ||
    normalizedStage === 'Test' ||
    normalizedStage === 'Review'
  );

  const plainReason = explainFailureReason({
    errorText: sanitizedMsg,
    stage: normalizedStage,
    workerName: workerDisplayName,
    workerCompleted: didWorkerComplete
  });

  const isCrash = /econnrefused|failed to spawn|enoent|process exited/i.test(sanitizedMsg);
  const isQuota = /quota|rate limit|429|overloaded/i.test(sanitizedMsg);

  const workerStatusText = didWorkerComplete
    ? `Worker completed generation successfully; deliverable was rejected during ${normalizedStage.toLowerCase()}.`
    : `Worker encountered an error during ${normalizedStage.toLowerCase()}.`;

  const recommendedAction = getRecommendedAction({
    errorText: sanitizedMsg,
    stage: normalizedStage,
    isQuota,
    isCrash
  });

  const actions = [
    {
      id: 'retry_same_worker',
      label: 'Retry with Same Worker',
      recommended: !isCrash && !isQuota
    },
    {
      id: 'retry_other_worker',
      label: 'Retry with Another Worker',
      recommended: isCrash || isQuota
    },
    {
      id: 'stop_task',
      label: 'Stop Task',
      recommended: false
    }
  ];

  return {
    title: 'Task Failed',
    reason: sanitizeText(plainReason),
    technicalError: sanitizedMsg,
    stage: normalizedStage,
    worker: activeWorker,
    workerName: workerDisplayName,
    model: activeModel,
    workerCompleted: didWorkerComplete,
    workerStatusText: sanitizeText(workerStatusText),
    recommendedAction: sanitizeText(recommendedAction),
    actions
  };
}
