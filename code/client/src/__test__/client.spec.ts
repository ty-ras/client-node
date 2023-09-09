/**
 * @file This file contains tests for file `../client.ts`.
 */

import test, { type ExecutionContext } from "ava";
import getPort from "@ava/get-port";
import * as dataFE from "@ty-ras/data-frontend";
import * as http from "node:http";
import * as http2 from "node:http2";
import type * as stream from "node:stream";
import type * as net from "node:net";

import * as spec from "../client";
import * as encoding from "../encoding";

test("Verify that http1 raw string variant works", async (c) => {
  c.plan(2);
  const host = "localhost";
  const port = await getPort();
  const callback = spec.createCallHTTPEndpoint(`http://${host}:${port}`);
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
      body: undefined,
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
      body: undefined,
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

test("Verify that http1 non-pooling variant can use secure agent", async (c) => {
  c.plan(1);
  const host = "localhost";
  const port = await getPort();
  const callback = spec.createCallHTTPEndpoint({
    host,
    port,
    scheme: "https",
  });

  await createTrackingServerAndListen(1, host, port, []);

  const method = "GET";
  const url = "/hello";
  // Trying to connect to http server using https should throw EPROTO error.
  await c.throwsAsync(async () => await callback({ method, url }), {
    instanceOf: Error,
    code: "EPROTO",
  });
});

const testSimpleUsecase = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(5);
  const { callback, capturedInfo, acquired, released, ...settings } =
    await prepareForTest(httpVersion);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      body: undefined,
      headers: getExpectedServerIncomingHeaders(httpVersion, {
        ...settings,
        method,
        path: url,
        scheme: "http",
      }),
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: getExpectedClientIncomingHeaders(httpVersion),
  });
  c.deepEqual(acquired.length, 1);
  c.deepEqual(released.length, 1);
  c.true(acquired[0] === released[0]);
};

test(
  "Verify that HTTP1 pooling variant work for simple usecase",
  testSimpleUsecase,
  1,
);
test(
  "Verify that HTTP2 pooling variant work for simple usecase",
  testSimpleUsecase,
  2,
);

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
    theBody: "this is \u00e4",
  };
  const headers = {
    someCustomHeader: "someRandomValue",
    theArrayHeader: ["one", "two"],
  };
  const result = await callback({ method, url, query, body, headers });
  const path = `${url}?${Object.entries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join("&")}`;
  c.deepEqual(capturedInfo, [
    {
      method,
      url: path,
      body: JSON.stringify(body),
      headers: getExpectedServerIncomingHeaders(
        httpVersion,
        {
          ...settings,
          method,
          path,
          scheme: "http",
        },
        {
          additionalHeaders: {
            ...headers,
            theArrayHeader: headers.theArrayHeader.join(", "),
          },
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

const testTrickyPathNames = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(2);
  const { callback, capturedInfo, ...settings } =
    await prepareForTest(httpVersion);

  const method = "GET";
  const result = await callback({
    method,
    url: "/hello/?injected-query-#-and-fragment/",
  });
  const url = "/hello/%3Finjected-query-%23-and-fragment/";
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      body: undefined,
      headers: getExpectedServerIncomingHeaders(httpVersion, {
        ...settings,
        method,
        path: url,
        scheme: "http",
      }),
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: getExpectedClientIncomingHeaders(httpVersion),
  });
};

test(
  "Test that using tricky path names in HTTP1 will be handled correctly",
  testTrickyPathNames,
  1,
);

test(
  "Test that using tricky path names in HTTP2 will be handled correctly",
  testTrickyPathNames,
  2,
);

const testHandlingConnectionErrors = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(1);
  // Create server which always just disconnects
  const { callback } = await prepareForTest(httpVersion, [
    (req, res) => {
      res.socket?.end();
    },
  ]);

  await c.throwsAsync(
    async () => await callback({ method: "GET", url: "/hello" }),
    { instanceOf: Error, message: "socket hang up" },
  );
};

test(
  "Test that connectivity errors in HTTP1 are handled correctly",
  testHandlingConnectionErrors,
  1,
);

// Since direct socket manipulation in HTTP2 is not possible (e.g. ERR_HTTP2_NO_SOCKET_MANIPULATION ), this test is disabled for now, as I don't know how else to produce an error in client-side stream
// test(
//   "Test that connectivity errors in HTTP2 are handled correctly",
//   testHandlingConnectionErrors,
//   2,
// );

const testNon2xxStatusCode = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(1);

  const statusCode = 404;
  const { callback } = await prepareForTest(httpVersion, [statusCode]);

  await c.throwsAsync(
    async () => await callback({ method: "GET", url: "/hello" }),
    {
      instanceOf: dataFE.Non2xxStatusCodeError,
      message: `Status code ${statusCode} was returned.`,
    },
  );
};

test(
  "Test that non-2xx status code in HTTP1 is handled correctly",
  testNon2xxStatusCode,
  1,
);
test(
  "Test that non-2xx status code in HTTP2 is handled correctly",
  testNon2xxStatusCode,
  2,
);

// const testBadEncodings = async (
//   c: ExecutionContext,
//   httpVersion: HTTPVersion,
// ) => {
//   const responseBody = "The body \u00f6";
//   const { callback, capturedInfo, ...settings } = await prepareForTest(
//     httpVersion,
//     [JSON.stringify(responseBody)],
//     {
//       encodingForReading: "blaa" as BufferEncoding,
//       encodingForWriting: "blee" as BufferEncoding,
//     },
//   );
//   const method = "POST";
//   const url = "/hello";
//   const body = {
//     theBody: "this is \u00e4",
//   };
//   const result = await callback({ method, url, body });
//   c.deepEqual(capturedInfo, [
//     {
//       method,
//       url,
//       headers: getExpectedServerIncomingHeaders(
//         httpVersion,
//         {
//           ...settings,
//           method,
//           path: url,
//           scheme: "http",
//         },
//         {
//           additionalHeaders: {},
//           hasBody: true,
//         },
//       ),
//     },
//   ]);
//   c.deepEqual(result, {
//     body: responseBody,
//     headers: getExpectedClientIncomingHeaders(httpVersion, 200),
//   });
// };

// Unfortunately, both of these tests causes another instance of this error:
// FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
// test(
//   "Test that bad encodings in HTTP1 are handled correctly",
//   testBadEncodings,
//   1,
// );
// test(
//   "Test that bad encodings in HTTP2 are handled correctly",
//   testBadEncodings,
//   2,
// );

const testThatCustomRequestConfigIsCalled = async (
  c: ExecutionContext,
  httpVersion: HTTPVersion,
) => {
  c.plan(1);
  let called: boolean = false;
  const { callback } = await prepareForTest(httpVersion, [undefined], {
    encodingInfo: undefined,
    processConfig: () => {
      called = true;
    },
  });

  const method = "GET";
  await callback({
    method,
    url: "/hello/?injected-query-#-and-fragment/",
  });
  c.deepEqual(called, true);
};

test(
  "Test that HTTP1 invokes custom request config",
  testThatCustomRequestConfigIsCalled,
  1,
);
test(
  "Test that HTTP2 invokes custom request config",
  testThatCustomRequestConfigIsCalled,
  2,
);

const prepareForTest = async (
  httpVersion: HTTPVersion,
  responses: PreparedServerRespones = [undefined],
  opts: {
    encodingInfo: EncodingInfo;
    processConfig:
      | spec.HTTPRequestConfigProcessor<
          spec.HTTP1RequestConfig | spec.HTTP2RequestConfig
        >
      | undefined;
  } = { encodingInfo: undefined, processConfig: undefined },
) => {
  const host = "localhost";
  const port = await getPort();

  const capturedInfo = await createTrackingServerAndListen(
    httpVersion,
    host,
    port,
    responses,
  );
  return {
    host,
    port,
    capturedInfo,
    ...createCallback(
      httpVersion,
      host,
      port,
      opts.encodingInfo,
      opts.processConfig,
    ),
  };
};

const createCallback = (
  httpVersion: HTTPVersion,
  host: string,
  port: number,
  encodingInfo: EncodingInfo,
  processRequestConfig:
    | spec.HTTPRequestConfigProcessor<
        spec.HTTP1RequestConfig | spec.HTTP2RequestConfig
      >
    | undefined,
) => {
  const acquired: Array<
    spec.HTTP2ConnectionAbstraction | spec.HTTP1ConnectionAbstraction
  > = [];
  const released: Array<
    spec.HTTP2ConnectionAbstraction | spec.HTTP1ConnectionAbstraction
  > = [];
  const callback = spec.createCallHTTPEndpoint(
    httpVersion === 2
      ? {
          ...(encodingInfo ?? {}),
          ...(processRequestConfig ? { processRequestConfig } : {}),
          httpVersion,
          acquire: () => {
            const connection = http2.connect(`http://${host}:${port}`);
            acquired.push(connection);
            // If we simply do Promise.resolve(connection), and if there is nothing listening on target address, the Node will crash:
            // FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal.
            return new Promise<spec.HTTP2ConnectionAbstraction>(
              (resolve, reject) => {
                connection.once("connect", resolve);
                connection.once("error", reject);
              },
            );
          },
          release: (connection: spec.HTTP2ConnectionAbstraction) => {
            released.push(connection);
            return Promise.resolve();
          },
        }
      : {
          ...(encodingInfo ?? {}),
          ...(processRequestConfig ? { processRequestConfig } : {}),
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
  return { acquired, released, callback };
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
  responses: PreparedServerRespones,
  // eslint-disable-next-line sonarjs/cognitive-complexity
) => {
  const capturedInfo: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, unknown>;
    body: string | undefined;
  }> = [];
  let idx = 0;
  const handleResponse = (
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
  ) => {
    let body: string | undefined;
    req.on("data", (chunk: string | Uint8Array) => {
      if (chunk instanceof Uint8Array) {
        chunk = Buffer.from(chunk).toString(encoding.DEFAULT_ENCODING);
      }
      if (body === undefined) {
        body = chunk;
      } else {
        body += chunk;
      }
    });
    req.on("end", () => {
      capturedInfo.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const responseInfo = responses[idx++];
      res.sendDate = false; // Makes life easier
      let callEnd = true;
      if (responseInfo === undefined) {
        res.statusCode = 204;
      } else if (typeof responseInfo === "string") {
        res.statusCode = 200;
        (res as stream.Writable).write(responseInfo);
      } else if (typeof responseInfo === "number") {
        res.statusCode = responseInfo;
      } else {
        responseInfo(req, res);
        callEnd = false;
      }

      if (callEnd) {
        res.end();
      }
    });
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
  ...(hasBody
    ? {
        "content-type": "application/json; charset=utf-8",
        "content-length": "24",
      }
    : {}),
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
        ...(statusCode === 200
          ? {
              "transfer-encoding": "chunked",
            }
          : {}),
      };

type HTTPVersion = 1 | 2;

type PreparedServerRespones = ReadonlyArray<
  | string
  | undefined
  | number
  | ((
      req: http.IncomingMessage | http2.Http2ServerRequest,
      res: http.ServerResponse | http2.Http2ServerResponse,
    ) => void)
>;

type EncodingInfo =
  | encoding.HTTPEncodingOptions1
  | encoding.HTTPEncodingOptions2
  | undefined;
