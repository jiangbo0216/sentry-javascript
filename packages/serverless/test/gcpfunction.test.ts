import * as SentryNode from '@sentry/node';
import type { Event } from '@sentry/types';
import * as domain from 'domain';
import * as http from 'http';

import * as Sentry from '../src';
import { wrapCloudEventFunction, wrapEventFunction, wrapHttpFunction } from '../src/gcpfunction';
import type {
  CloudEventFunction,
  CloudEventFunctionWithCallback,
  EventFunction,
  EventFunctionWithCallback,
  HttpFunction,
  Request,
  Response,
} from '../src/gcpfunction/general';
/**
 * Why @ts-expect-error some Sentry.X calls
 *
 * A hack-ish way to contain everything related to mocks in the same __mocks__ file.
 * Thanks to this, we don't have to do more magic than necessary. Just add and export desired method and assert on it.
 */

describe('GCPFunction', () => {
  afterEach(() => {
    // @ts-expect-error see "Why @ts-expect-error" note
    SentryNode.resetMocks();
  });

  async function handleHttp(fn: HttpFunction, trace_headers: { [key: string]: string } | null = null): Promise<void> {
    let headers: { [key: string]: string } = { host: 'hostname', 'content-type': 'application/json' };
    if (trace_headers) {
      headers = { ...headers, ...trace_headers };
    }
    return new Promise((resolve, _reject) => {
      const d = domain.create();
      const req = {
        method: 'POST',
        url: '/path?q=query',
        headers: headers,
        body: { foo: 'bar' },
      } as Request;
      const res = new http.ServerResponse(req);
      d.on('error', () => {
        res.end();
        res.emit('finish');
        resolve();
      });
      d.run(() =>
        process.nextTick(
          (req: Request, res: Response) =>
            Promise.resolve(fn(req, res)).then(() => {
              res.emit('finish');
              resolve();
            }),
          req,
          res as Response,
        ),
      );
    });
  }

  function handleEvent(fn: EventFunctionWithCallback): Promise<any> {
    return new Promise((resolve, reject) => {
      const d = domain.create();
      // d.on('error', () => res.end());
      const context = {
        eventType: 'event.type',
        resource: 'some.resource',
      };
      d.on('error', reject);
      d.run(() =>
        process.nextTick(fn, {}, context, (err: any, result: any) => {
          if (err != null || err != undefined) {
            reject(err);
          } else {
            resolve(result);
          }
        }),
      );
    });
  }

  function handleCloudEvent(fn: CloudEventFunctionWithCallback): Promise<any> {
    return new Promise((resolve, reject) => {
      const d = domain.create();
      // d.on('error', () => res.end());
      const context = {
        type: 'event.type',
      };
      d.on('error', reject);
      d.run(() =>
        process.nextTick(fn, context, (err: any, result: any) => {
          if (err != null || err != undefined) {
            reject(err);
          } else {
            resolve(result);
          }
        }),
      );
    });
  }

  describe('wrapHttpFunction() options', () => {
    test('flushTimeout', async () => {
      expect.assertions(1);

      const handler: HttpFunction = (_, res) => {
        res.end();
      };
      const wrappedHandler = wrapHttpFunction(handler, { flushTimeout: 1337 });

      await handleHttp(wrappedHandler);
      expect(SentryNode.flush).toBeCalledWith(1337);
    });
  });

  describe('wrapHttpFunction()', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const handler: HttpFunction = (_req, res) => {
        res.statusCode = 200;
        res.end();
      };
      const wrappedHandler = wrapHttpFunction(handler);
      await handleHttp(wrappedHandler);

      const fakeTransactionContext = {
        name: 'POST /path',
        op: 'function.gcp.http',
        origin: 'auto.function.serverless.gcp_http',
        metadata: { source: 'route' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.setHttpStatus).toBeCalledWith(200);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('incoming trace headers are correctly parsed and used', async () => {
      expect.assertions(1);

      const handler: HttpFunction = (_req, res) => {
        res.statusCode = 200;
        res.end();
      };
      const wrappedHandler = wrapHttpFunction(handler);
      const traceHeaders = {
        'sentry-trace': '12312012123120121231201212312012-1121201211212012-0',
        baggage: 'sentry-release=2.12.1,maisey=silly,charlie=goofy',
      };
      await handleHttp(wrappedHandler, traceHeaders);

      const fakeTransactionContext = {
        name: 'POST /path',
        op: 'function.gcp.http',
        origin: 'auto.function.serverless.gcp_http',
        traceId: '12312012123120121231201212312012',
        parentSpanId: '1121201211212012',
        parentSampled: false,
        metadata: {
          dynamicSamplingContext: {
            release: '2.12.1',
          },
          source: 'route',
        },
      };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
    });

    test('capture error', async () => {
      expect.assertions(5);

      const error = new Error('wat');
      const handler: HttpFunction = (_req, _res) => {
        throw error;
      };
      const wrappedHandler = wrapHttpFunction(handler);

      const trace_headers: { [key: string]: string } = {
        'sentry-trace': '12312012123120121231201212312012-1121201211212012-0',
      };

      await handleHttp(wrappedHandler, trace_headers);

      const fakeTransactionContext = {
        name: 'POST /path',
        op: 'function.gcp.http',
        origin: 'auto.function.serverless.gcp_http',
        traceId: '12312012123120121231201212312012',
        parentSpanId: '1121201211212012',
        parentSampled: false,
        metadata: { dynamicSamplingContext: {}, source: 'route' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });

    test('should not throw when flush rejects', async () => {
      expect.assertions(2);

      const handler: HttpFunction = async (_req, res) => {
        res.statusCode = 200;
        res.end();
      };

      const wrappedHandler = wrapHttpFunction(handler);

      const mockEnd = jest.fn();

      jest.spyOn(Sentry, 'flush').mockImplementationOnce(async () => {
        throw new Error();
      });

      await expect(handleHttp(wrappedHandler).then(mockEnd)).resolves.toBeUndefined();
      expect(mockEnd).toHaveBeenCalledTimes(1);
    });
  });

  // This tests that the necessary pieces are in place for request data to get added to event - the `RequestData`
  // integration is included in the defaults and the necessary data is stored in `sdkProcessingMetadata`. The
  // integration's tests cover testing that it uses that data correctly.
  test('wrapHttpFunction request data prereqs', async () => {
    expect.assertions(2);

    Sentry.GCPFunction.init({});

    const handler: HttpFunction = (_req, res) => {
      res.end();
    };
    const wrappedHandler = wrapHttpFunction(handler, { addRequestDataToEventOptions: { include: { ip: true } } });

    await handleHttp(wrappedHandler);

    expect(SentryNode.init).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultIntegrations: expect.arrayContaining([expect.any(SentryNode.Integrations.RequestData)]),
      }),
    );

    // @ts-expect-error see "Why @ts-expect-error" note
    expect(SentryNode.fakeScope.setSDKProcessingMetadata).toHaveBeenCalledWith({
      request: {
        method: 'POST',
        url: '/path?q=query',
        headers: { host: 'hostname', 'content-type': 'application/json' },
        body: { foo: 'bar' },
      },
      requestDataOptionsFromGCPWrapper: { include: { ip: true } },
    });
  });

  describe('wrapEventFunction() without callback', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const func: EventFunction = (_data, _context) => {
        return 42;
      };
      const wrappedHandler = wrapEventFunction(func);
      await expect(handleEvent(wrappedHandler)).resolves.toBe(42);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('capture error', async () => {
      expect.assertions(6);

      const error = new Error('wat');
      const handler: EventFunction = (_data, _context) => {
        throw error;
      };
      const wrappedHandler = wrapEventFunction(handler);
      await expect(handleEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });
  });

  describe('wrapEventFunction() as Promise', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const func: EventFunction = (_data, _context) =>
        new Promise(resolve => {
          setTimeout(() => {
            resolve(42);
          }, 10);
        });
      const wrappedHandler = wrapEventFunction(func);
      await expect(handleEvent(wrappedHandler)).resolves.toBe(42);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('capture error', async () => {
      expect.assertions(6);

      const error = new Error('wat');
      const handler: EventFunction = (_data, _context) =>
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(error);
          }, 10);
        });

      const wrappedHandler = wrapEventFunction(handler);
      await expect(handleEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });
  });

  describe('wrapEventFunction() with callback', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const func: EventFunctionWithCallback = (_data, _context, cb) => {
        cb(null, 42);
      };
      const wrappedHandler = wrapEventFunction(func);
      await expect(handleEvent(wrappedHandler)).resolves.toBe(42);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('capture error', async () => {
      expect.assertions(6);

      const error = new Error('wat');
      const handler: EventFunctionWithCallback = (_data, _context, cb) => {
        cb(error);
      };
      const wrappedHandler = wrapEventFunction(handler);
      await expect(handleEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });

    test('capture exception', async () => {
      expect.assertions(4);

      const error = new Error('wat');
      const handler: EventFunctionWithCallback = (_data, _context, _cb) => {
        throw error;
      };
      const wrappedHandler = wrapEventFunction(handler);
      await expect(handleEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.event',
        origin: 'auto.function.serverless.gcp_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
    });
  });

  test('marks the captured error as unhandled', async () => {
    expect.assertions(4);

    const error = new Error('wat');
    const handler: EventFunctionWithCallback = (_data, _context, _cb) => {
      throw error;
    };
    const wrappedHandler = wrapEventFunction(handler);
    await expect(handleEvent(wrappedHandler)).rejects.toThrowError(error);

    expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));

    // @ts-expect-error just mocking around...
    const scopeFunction = SentryNode.captureException.mock.calls[0][1];
    const event: Event = { exception: { values: [{}] } };
    let evtProcessor: ((e: Event) => Event) | undefined = undefined;
    scopeFunction({ addEventProcessor: jest.fn().mockImplementation(proc => (evtProcessor = proc)) });

    expect(evtProcessor).toBeInstanceOf(Function);
    // @ts-expect-error just mocking around...
    expect(evtProcessor(event).exception.values[0].mechanism).toEqual({
      handled: false,
      type: 'generic',
    });
  });

  test('wrapEventFunction scope data', async () => {
    expect.assertions(1);

    const handler: EventFunction = (_data, _context) => 42;
    const wrappedHandler = wrapEventFunction(handler);
    await handleEvent(wrappedHandler);
    // @ts-expect-error see "Why @ts-expect-error" note
    expect(SentryNode.fakeScope.setContext).toBeCalledWith('gcp.function.context', {
      eventType: 'event.type',
      resource: 'some.resource',
    });
  });

  describe('wrapCloudEventFunction() without callback', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const func: CloudEventFunction = _context => {
        return 42;
      };
      const wrappedHandler = wrapCloudEventFunction(func);
      await expect(handleCloudEvent(wrappedHandler)).resolves.toBe(42);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.cloud_event',
        origin: 'auto.function.serverless.gcp_cloud_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('capture error', async () => {
      expect.assertions(6);

      const error = new Error('wat');
      const handler: CloudEventFunction = _context => {
        throw error;
      };
      const wrappedHandler = wrapCloudEventFunction(handler);
      await expect(handleCloudEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.cloud_event',
        origin: 'auto.function.serverless.gcp_cloud_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });
  });

  describe('wrapCloudEventFunction() with callback', () => {
    test('successful execution', async () => {
      expect.assertions(5);

      const func: CloudEventFunctionWithCallback = (_context, cb) => {
        cb(null, 42);
      };
      const wrappedHandler = wrapCloudEventFunction(func);
      await expect(handleCloudEvent(wrappedHandler)).resolves.toBe(42);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.cloud_event',
        origin: 'auto.function.serverless.gcp_cloud_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalledWith(2000);
    });

    test('capture error', async () => {
      expect.assertions(6);

      const error = new Error('wat');
      const handler: CloudEventFunctionWithCallback = (_context, cb) => {
        cb(error);
      };
      const wrappedHandler = wrapCloudEventFunction(handler);
      await expect(handleCloudEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.cloud_event',
        origin: 'auto.function.serverless.gcp_cloud_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);
      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeTransaction.finish).toBeCalled();
      expect(SentryNode.flush).toBeCalled();
    });

    test('capture exception', async () => {
      expect.assertions(4);

      const error = new Error('wat');
      const handler: CloudEventFunctionWithCallback = (_context, _cb) => {
        throw error;
      };
      const wrappedHandler = wrapCloudEventFunction(handler);
      await expect(handleCloudEvent(wrappedHandler)).rejects.toThrowError(error);

      const fakeTransactionContext = {
        name: 'event.type',
        op: 'function.gcp.cloud_event',
        origin: 'auto.function.serverless.gcp_cloud_event',
        metadata: { source: 'component' },
      };
      // @ts-expect-error see "Why @ts-expect-error" note
      const fakeTransaction = { ...SentryNode.fakeTransaction, ...fakeTransactionContext };

      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeHub.startTransaction).toBeCalledWith(fakeTransactionContext);
      // @ts-expect-error see "Why @ts-expect-error" note
      expect(SentryNode.fakeScope.setSpan).toBeCalledWith(fakeTransaction);

      expect(SentryNode.captureException).toBeCalledWith(error, expect.any(Function));
    });
  });

  test('wrapCloudEventFunction scope data', async () => {
    expect.assertions(1);

    const handler: CloudEventFunction = _context => 42;
    const wrappedHandler = wrapCloudEventFunction(handler);
    await handleCloudEvent(wrappedHandler);
    // @ts-expect-error see "Why @ts-expect-error" note
    expect(SentryNode.fakeScope.setContext).toBeCalledWith('gcp.function.context', { type: 'event.type' });
  });

  describe('init()', () => {
    test('calls Sentry.init with correct sdk info metadata', () => {
      Sentry.GCPFunction.init({});

      expect(Sentry.init).toBeCalledWith(
        expect.objectContaining({
          _metadata: {
            sdk: {
              name: 'sentry.javascript.serverless',
              integrations: ['GCPFunction'],
              packages: [
                {
                  name: 'npm:@sentry/serverless',
                  version: '6.6.6',
                },
              ],
              version: '6.6.6',
            },
          },
        }),
      );
    });

    test('enhance event with correct mechanism value', () => {
      const eventWithSomeData = {
        exception: {
          values: [{}],
        },
      };

      // @ts-expect-error see "Why @ts-expect-error" note
      Sentry.addGlobalEventProcessor.mockImplementationOnce(cb => cb(eventWithSomeData));
      Sentry.GCPFunction.init({});

      expect(eventWithSomeData).toEqual({
        exception: {
          values: [
            {
              mechanism: {
                handled: false,
                type: 'generic',
              },
            },
          ],
        },
      });
    });
  });
});
