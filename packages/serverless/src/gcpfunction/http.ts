import {
  SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN,
  SEMANTIC_ATTRIBUTE_SENTRY_SOURCE,
  Transaction,
  handleCallbackErrors,
  setHttpStatus,
} from '@sentry/core';
import type { AddRequestDataToEventOptions } from '@sentry/node';
import { continueTrace, startSpanManual } from '@sentry/node';
import { getCurrentScope } from '@sentry/node';
import { captureException, flush } from '@sentry/node';
import { isString, logger, stripUrlQueryAndFragment } from '@sentry/utils';

import { DEBUG_BUILD } from '../debug-build';
import { domainify, markEventUnhandled, proxyFunction } from './../utils';
import type { HttpFunction, WrapperOptions } from './general';

// TODO (v8 / #5257): Remove this whole old/new business and just use the new stuff
type ParseRequestOptions = AddRequestDataToEventOptions['include'] & {
  serverName?: boolean;
  version?: boolean;
};

interface OldHttpFunctionWrapperOptions extends WrapperOptions {
  /**
   * @deprecated Use `addRequestDataToEventOptions` instead.
   */
  parseRequestOptions: ParseRequestOptions;
}
interface NewHttpFunctionWrapperOptions extends WrapperOptions {
  addRequestDataToEventOptions: AddRequestDataToEventOptions;
}

export type HttpFunctionWrapperOptions = OldHttpFunctionWrapperOptions | NewHttpFunctionWrapperOptions;

/**
 * Wraps an HTTP function handler adding it error capture and tracing capabilities.
 *
 * @param fn HTTP Handler
 * @param options Options
 * @returns HTTP handler
 */
export function wrapHttpFunction(
  fn: HttpFunction,
  wrapOptions: Partial<HttpFunctionWrapperOptions> = {},
): HttpFunction {
  const wrap = (f: HttpFunction): HttpFunction => domainify(_wrapHttpFunction(f, wrapOptions));

  let overrides: Record<PropertyKey, unknown> | undefined;

  // Functions emulator from firebase-tools has a hack-ish workaround that saves the actual function
  // passed to `onRequest(...)` and in fact runs it so we need to wrap it too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const emulatorFunc = (fn as any).__emulator_func as HttpFunction | undefined;
  if (emulatorFunc) {
    overrides = { __emulator_func: proxyFunction(emulatorFunc, wrap) };
  }
  return proxyFunction(fn, wrap, overrides);
}

/** */
function _wrapHttpFunction(fn: HttpFunction, wrapOptions: Partial<HttpFunctionWrapperOptions> = {}): HttpFunction {
  // TODO (v8 / #5257): Switch to using `addRequestDataToEventOptions`
  // eslint-disable-next-line deprecation/deprecation
  const { parseRequestOptions } = wrapOptions as OldHttpFunctionWrapperOptions;

  const options: HttpFunctionWrapperOptions = {
    flushTimeout: 2000,
    // TODO (v8 / xxx): Remove this line, since `addRequestDataToEventOptions` will be included in the spread of `wrapOptions`
    addRequestDataToEventOptions: parseRequestOptions ? { include: parseRequestOptions } : {},
    ...wrapOptions,
  };
  return (req, res) => {
    const reqMethod = (req.method || '').toUpperCase();
    const reqUrl = stripUrlQueryAndFragment(req.originalUrl || req.url || '');

    const sentryTrace = req.headers && isString(req.headers['sentry-trace']) ? req.headers['sentry-trace'] : undefined;
    const baggage = req.headers?.baggage;

    return continueTrace({ sentryTrace, baggage }, () => {
      return startSpanManual(
        {
          name: `${reqMethod} ${reqUrl}`,
          op: 'function.gcp.http',
          attributes: {
            [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'route',
            [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.function.serverless.gcp_http',
          },
        },
        span => {
          getCurrentScope().setSDKProcessingMetadata({
            request: req,
            requestDataOptionsFromGCPWrapper: options.addRequestDataToEventOptions,
          });

          if (span instanceof Transaction) {
            // We also set __sentry_transaction on the response so people can grab the transaction there to add
            // spans to it later.
            // TODO(v8): Remove this
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
            (res as any).__sentry_transaction = span;
          }
          res.once('finish', (): void => {
            if (span) {
              setHttpStatus(span, res.statusCode);
              span.end();
            }
            void flush(options.flushTimeout).then(null, (e: unknown) => {
              __DEBUG_BUILD__ && logger.error(e);
            });
          });

          return handleCallbackErrors(
            () => fn(req, res),
            err => {
              captureException(err, scope => markEventUnhandled(scope));
            },
          );
        },
      );
    });
  };
}
