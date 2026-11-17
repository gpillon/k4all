/*
 * Classification of API errors. Headlamp's request helpers reject with an
 * Error carrying `status` and a message "<statusText> - <Status.message>".
 */

export type ApiErrorKind =
  | 'conflict'
  | 'invalid'
  | 'forbidden'
  | 'unauthorized'
  | 'notFound'
  | 'unavailable'
  | 'unknown';

export interface ClassifiedError {
  kind: ApiErrorKind;
  status?: number;
  message: string;
  /** A sentence for the user. */
  hint: string;
}

/** A failed JSON Patch "test" (our generation precondition) comes back as 422. */
const TEST_FAILED = /testing value \S+ failed|test failed/i;

export function classifyError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as { status?: number; message?: string };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (status === 409 || (status === 422 && TEST_FAILED.test(message))) {
    return {
      kind: 'conflict',
      status,
      message,
      hint: 'Someone changed this resource while you were editing.',
    };
  }
  if (status === 400 || status === 422) {
    return {
      kind: 'invalid',
      status,
      message,
      hint: /unknown field|strict decoding/i.test(message)
        ? 'The installed k4all-operator does not know one of these fields. Upgrade k4all first.'
        : 'The API server rejected the change.',
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      status,
      message,
      hint: 'Your user is not allowed to make this change.',
    };
  }
  if (status === 401) {
    return { kind: 'unauthorized', status, message, hint: 'Your session expired. Log in again.' };
  }
  if (status === 404) {
    return {
      kind: 'notFound',
      status,
      message,
      hint: 'The resource does not exist (any more). Is k4all-operator installed?',
    };
  }
  if (status === undefined || status === 0 || status === 408 || status >= 500) {
    return {
      kind: 'unavailable',
      status,
      message,
      hint: 'The API server could not be reached. Try again in a moment.',
    };
  }
  return { kind: 'unknown', status, message, hint: 'The request failed.' };
}
