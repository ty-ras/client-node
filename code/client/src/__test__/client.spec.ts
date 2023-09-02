/**
 * @file This file contains tests for file `../client.ts`.
 */

import test, { type ExecutionContext } from "ava";
import getPort from "@ava/get-port";
import * as http from "node:http";
import * as http2 from "node:http2";
import type * as stream from "node:stream";
import type * as net from "node:net";

import * as spec from "../client";

test("Verify that http1 non-pooling variant works", async (c) => {
  c.plan(2);
  const host = "localhost";
  const port = await getPort();
  const callback = spec.createCallHTTPEndpoint({
    host,
    port,
    scheme: "http",
  });

  const capturedInfo = await createTrackingServerAndListen(1, host, port, [
    undefined,
  ]);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: getExpectedServerIncomingHeaders(1, {
        host,
        port,
        scheme: "http",
        method,
        path: url,
      }),
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: getExpectedClientIncomingHeaders(1),
  });
});

test("Verify that http1 pooling variant works", async (c) => {
  c.plan(5);
  const { callback, capturedInfo, acquired, released, ...settings } =
    await prepareForTest(1);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: getExpectedServerIncomingHeaders(1, {
        ...settings,
        method,
        path: url,
        scheme: "http",
      }),
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: getExpectedClientIncomingHeaders(1),
  });
  c.deepEqual(acquired.length, 1);
  c.deepEqual(released.length, 1);
  c.true(acquired[0] === released[0]);
});

test("Verify that http2 variant works", async (c) => {
  c.plan(5);
  const { callback, capturedInfo, acquired, released, ...settings } =
    await prepareForTest(2);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: getExpectedServerIncomingHeaders(2, {
        ...settings,
        method,
        path: url,
        scheme: "http",
      }),
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: getExpectedClientIncomingHeaders(2),
  });
  c.deepEqual(acquired.length, 1);
  c.deepEqual(released.length, 1);
  c.true(acquired[0] === released[0]);
});

const testHTTPProtocolAspects = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(2);
  const responseBody = { theResponseBody: "that" };
  const { callback, capturedInfo, ...settings } = await prepareForTest(
    httpVersion,
    [JSON.stringify(responseBody)],
  );

  const method = "POST";
  const url = "/hello";
  const query = {
    x: "1",
    y: 2,
  };
  const body = {
    theBody: "this",
  };
  const headers = {
    someCustomHeader: "someRandomValue",
  };
  const result = await callback({ method, url, query, body, headers });
  const path = `${url}?${Object.entries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join("&")}`;
  c.deepEqual(capturedInfo, [
    {
      method,
      url: path,
      headers: getExpectedServerIncomingHeaders(
        httpVersion,
        {
          ...settings,
          method,
          path,
          scheme: "http",
        },
        {
          additionalHeaders: headers,
          hasBody: true,
        },
      ),
    },
  ]);
  c.deepEqual(result, {
    body: responseBody,
    headers: getExpectedClientIncomingHeaders(httpVersion, 200),
  });
};

test("Test HTTP 1 protocol aspects", testHTTPProtocolAspects, 1);
test("Test HTTP 2 protocol aspects", testHTTPProtocolAspects, 2);

test("Test that using full URL is detected and exception thrown", async (c) => {
  c.plan(2);
  const host = "localhost";
  const port = await getPort();
  const callback = spec.createCallHTTPEndpoint({
    host,
    port,
    scheme: "http",
  });
  await c.throwsAsync(
    async () => await callback({ method: "GET", url: "http://example.com" }),
    {
      instanceOf: Error,
      message: 'Invalid pathname supplied: "http://example.com".',
    },
  );
  await c.throwsAsync(
    async () =>
      await callback({ method: "GET", url: "http://example.com/xyz" }),
    {
      instanceOf: Error,
      message: 'Invalid pathname supplied: "http://example.com/xyz".',
    },
  );
});

const prepareForTest = async (
  httpVersion: HTTPVersion,
  responses: ReadonlyArray<string | undefined | number> = [undefined],
) => {
  const host = "localhost";
  const port = await getPort();
  const acquired: Array<
    spec.HTTP2ConnectionAbstraction | spec.HTTP1ConnectionAbstraction
  > = [];
  const released: Array<
    spec.HTTP2ConnectionAbstraction | spec.HTTP1ConnectionAbstraction
  > = [];
  const callback = spec.createCallHTTPEndpoint(
    httpVersion === 2
      ? {
          httpVersion,
          acquire: () => {
            const connection = http2.connect(`http://${host}:${port}`);
            acquired.push(connection);
            return Promise.resolve(connection);
          },
          release: (connection: spec.HTTP2ConnectionAbstraction) => {
            released.push(connection);
            return Promise.resolve();
          },
        }
      : {
          httpVersion,
          acquire: () => {
            const agent = new http.Agent({ host, port });
            acquired.push(agent);
            return Promise.resolve(agent);
          },
          release: (agent: spec.HTTP1ConnectionAbstraction) => {
            released.push(agent);
            return Promise.resolve();
          },
        },
  );

  const capturedInfo = await createTrackingServerAndListen(
    httpVersion,
    host,
    port,
    responses,
  );
  return {
    host,
    port,
    acquired,
    released,
    callback,
    capturedInfo,
  };
};

const listenAsync = (server: net.Server, host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    try {
      server.addListener("error", reject);
      server.listen({ host, port }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });

const createTrackingServerAndListen = async (
  httpVersion: HTTPVersion,
  host: string,
  port: number,
  responses: ReadonlyArray<string | undefined | number>,
) => {
  const capturedInfo: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, unknown>;
  }> = [];
  let idx = 0;
  const handleResponse = (
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
  ) => {
    capturedInfo.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    });
    const responseInfo = responses[idx++];
    res.sendDate = false; // Makes life easier
    if (responseInfo === undefined) {
      res.statusCode = 204;
    } else if (typeof responseInfo === "string") {
      res.statusCode = 200;
      (res as stream.Writable).write(responseInfo);
    } else {
      res.statusCode = responseInfo;
    }
    res.end();
  };
  const server =
    httpVersion === 2
      ? http2.createServer(handleResponse)
      : http.createServer(handleResponse);
  await listenAsync(server, host, port);
  return capturedInfo;
};

const getExpectedServerIncomingHeaders = (
  httpVersion: HTTPVersion,
  {
    host,
    port,
    scheme,
    method,
    path,
  }: Pick<Awaited<ReturnType<typeof prepareForTest>>, "host" | "port"> & {
    path: string;
    method: string;
    scheme: string;
  },
  {
    additionalHeaders,
    hasBody,
  }: { additionalHeaders: Record<string, unknown>; hasBody: boolean } = {
    additionalHeaders: {},
    hasBody: false,
  },
): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(additionalHeaders).map(
      ([k, v]) => [k.toLowerCase(), v] as const,
    ),
  ),
  ...(httpVersion === 2
    ? {
        [http2.constants.HTTP2_HEADER_AUTHORITY]: `${host}:${port}`,
        [http2.constants.HTTP2_HEADER_METHOD]: method,
        [http2.constants.HTTP2_HEADER_PATH]: path,
        [http2.constants.HTTP2_HEADER_SCHEME]: scheme,
        [http2.sensitiveHeaders]: [],
      }
    : {
        connection: "close",
        host,
        ...(hasBody ? { "transfer-encoding": "chunked" } : {}),
      }),
});

const getExpectedClientIncomingHeaders = (
  httpVersion: HTTPVersion,
  statusCode: number = 204,
): Record<string, unknown> =>
  httpVersion === 2
    ? {
        [http2.constants.HTTP2_HEADER_STATUS]: statusCode,
        [http2.sensitiveHeaders]: [],
      }
    : {
        connection: "close",
        ...(statusCode === 200 ? { "transfer-encoding": "chunked" } : {}),
      };

type HTTPVersion = 1 | 2;
