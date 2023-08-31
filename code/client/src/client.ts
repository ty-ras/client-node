/**
 * @file This file contains function to create {@link dataFE.CallHTTPEndpoint} which will use `fetch` API to do the requests.
 */

import * as data from "@ty-ras/data";
import type * as dataFE from "@ty-ras/data-frontend";
import * as http from "node:http";
import * as https from "node:https";
import * as http2 from "node:http2";
import * as url from "node:url";
import * as errors from "./errors";

/**
 * This function will create a {@link dataFE.CallHTTPEndpoint} callback which is locked on certain backend (scheme, hostname, etc).
 * It will throw whatever {@link URL} constructors throws if provided with invalid backend information.
 * @param callerArgs The {@link HTTPEndpointCallerArgs}: either base URL string, or structured information about the scheme, hostname, etc of the backend.
 * @param callerArgs.commonPathPrefix Privately deconstructed variable.
 * @param callerArgs.allowProtoProperty Privately deconstructed variable.
 * @returns A {@link dataFE.CallHTTPEndpoint} callback which can be used to create instances of {@link dataFE.APICallFactoryBase}.
 * It will throw {@link errors.InvalidPathnameError} or {@link errors.Non2xxStatusCodeError} if invoked with wrong arguments, and also whatever the {@link URL} constructor might throw on invalid URLs.
 */
export const createCallHTTPEndpoint = ({
  commonPathPrefix,
  allowProtoProperty,
  ...callerArgs
}: HTTPEndpointCallerArgs): dataFE.CallHTTPEndpoint => {
  // If some garbage provided as args, then this will throw
  const baseURLString = validateBaseURL(callerArgs);
  const reviver = data.getJSONParseReviver(allowProtoProperty === true);

  return callerArgs.httpVersion === 2
    ? callUsingHttp2(
        { acquire: callerArgs.acquire, release: callerArgs.release },
        commonPathPrefix ?? "",
        reviver,
      )
    : callUsingHttp1(
        "acquire" in callerArgs && "release" in callerArgs
          ? { acquire: callerArgs.acquire, release: callerArgs.release }
          : {},
        commonPathPrefix ?? "",
        reviver,
      );
};

/**
 * This type is the argument of {@link createCallHTTPEndpoint}.
 * It can be either string, which is then interpreted as full URL.
 * Alternatively, it can be a structured object {@link HTTPEndpointCallerArgs}.
 */
export type HTTPEndpointCallerArgs = HTTPEndpointCallerOptions;

export type HTTPEndpointCallerOptions =
  | HTTPEndpointCallerOptions1
  | HTTPEndpointCallerOptions2;

export interface HTTPEndpointCallerOptionsBase {
  /**
   * If set to `true`, will NOT strip the `__proto__` properties of the result.
   */
  allowProtoProperty?: boolean;

  commonPathPrefix?: string;
}

export interface HTTPConnectionUsageOptions<TConnection> {
  acquire: () => Promise<TConnection>;
  release: (connection: TConnection) => Promise<void>;
}

export interface HTTPEndpointCallerOptionsWithoutAgent {
  /**
   * Which scheme should be used for URL.
   * Typically either `http` or `https`.
   */
  scheme: string;
  /**
   * The host name of the backend HTTP endpoints.
   */
  host: string;
  /**
   * The optional port to use.
   */
  port?: number;

  /**
   * The optional path prefix for backend HTTP endpoints.
   * If provided, typically should include the last `/` character - the given URL paths will be concatenated directly after this without putting any logic in concatenation.
   */
  path?: string;
}

/**
 * This type is the structured version of URL string passed to {@link createCallHTTPEndpoint}, extending {@link HTTPEndpointCallerOptionsBase} and using HTTP1 protocol.
 */
export type HTTPEndpointCallerOptions1 = HTTPEndpointCallerOptionsBase &
  (
    | HTTPConnectionUsageOptions<http.Agent>
    | HTTPEndpointCallerOptionsWithoutAgent
  ) & {
    /**
     * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
     * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
     */
    httpVersion?: 1;
  };

/**
 * This type is the structured version of URL string passed to {@link createCallHTTPEndpoint}, extending {@link HTTPEndpointCallerOptionsBase} and using HTTP2 protocol.
 */
export interface HTTPEndpointCallerOptions2
  extends HTTPEndpointCallerOptionsBase,
    HTTPConnectionUsageOptions<http2.ClientHttp2Session> {
  /**
   * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
   * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
   */
  httpVersion: 2;
}

/**
 * This is exported for the tests only - it is not exported via index.ts
 * @param args The {@link HTTPEndpointCallerArgs}.
 * @returns The constructed URL string.
 */
export const constructDummyPool = (
  args: HTTPEndpointCallerOptionsWithoutAgent,
) => {
  const baseURLString =
    typeof args === "string"
      ? args
      : `${args.scheme}://${args.host}${"port" in args ? `:${args.port}` : ""}${
          args.path ?? ""
        }`;
  // Validate by trying to construct URL object. Will throw on invalid things.
  new url.URL(baseURLString);

  return baseURLString;
};

const getURLSearchParams = (query: Record<string, unknown>) =>
  new url.URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .flatMap<[string, string]>(([qKey, qValue]) =>
        Array.isArray(qValue)
          ? qValue.map<[string, string]>((value) => [qKey, `${value}`])
          : [[qKey, `${qValue}`]],
      ),
  ).toString();

const callUsingHttp1 = (
  pool: HTTPConnectionUsageOptions<http.Agent>,
  baseURLString: string,
  reviver: ReturnType<typeof data.getJSONParseReviver>,
): dataFE.CallHTTPEndpoint => {
  // eslint-disable-next-line sonarjs/cognitive-complexity
  return async ({ headers, url, method, query, ...args }) => {
    const body = "body" in args ? JSON.stringify(args.body) : undefined;

    const urlObject = new URL(`${baseURLString}${url}`);
    if (urlObject.search.length > 0 || urlObject.hash.length > 0) {
      throw new errors.InvalidPathnameError(url);
    }
    if (query) {
      urlObject.search = getURLSearchParams(query);
    }
    // If rejectUnauthorized is specified, we must construct separate https.Agent.
    // Do it per request to avoid possible congestion.
    const agent = await pool.acquire();
    try {
      return await new Promise((resolve, reject) => {
        const writeable = http
          .request(
            {
              agent,
              method,
              href: urlObject.href,
              headers: getOutgoingHeaders(headers),
            },
            (resp) => {
              resp.setEncoding("utf8");
              let data: string | undefined;
              const headers = resp.headers;
              const statusCode = resp.statusCode;

              // A chunk of data has been received.
              resp.on("data", (chunk: string) => {
                if (data === undefined) {
                  data = chunk;
                } else {
                  data += chunk;
                }
              });

              resp.on("end", () => {
                if (
                  statusCode === undefined ||
                  (statusCode !== 200 && statusCode !== 204)
                ) {
                  reject(new errors.Non2xxStatusCodeError(statusCode ?? -1));
                } else {
                  resolve({
                    headers,
                    body:
                      data === undefined
                        ? undefined
                        : JSON.parse(data, reviver),
                  });
                }
              });
            },
          )
          .on("error", (err) => {
            reject(err);
          });

        if (body !== undefined) {
          writeable.write(body);
        }

        writeable.end();
      });
    } finally {
      await pool.release(agent);
    }
  };
};

const callUsingHttp2 = (
  pool: HTTPConnectionUsageOptions<http2.ClientHttp2Session>,
  baseURLString: string,
  reviver: ReturnType<typeof data.getJSONParseReviver>,
): dataFE.CallHTTPEndpoint => {
  return async ({ headers, url, method, query, ...args }) => {
    const body = "body" in args ? JSON.stringify(args.body) : undefined;

    const urlObject = new URL(`${baseURLString}${url}`);
    if (urlObject.search.length > 0 || urlObject.hash.length > 0) {
      throw new errors.InvalidPathnameError(url);
    }
    if (query) {
      urlObject.search = getURLSearchParams(query);
    }
    const session = await pool.acquire();
    try {
      const request = session.request({
        ...getOutgoingHeaders(headers),
        // [http2.constants.HTTP2_HEADER_SCHEME]: "https",
        [http2.constants.HTTP2_HEADER_METHOD]: method,
        [http2.constants
          .HTTP2_HEADER_PATH]: `${urlObject.pathname}${urlObject.search}`,
      });
      request.setEncoding("utf8");

      let incomingHeaders: http2.IncomingHttpHeaders = {};
      request.on("response", (hdrs) => {
        incomingHeaders = hdrs;
      });
      let data: string | undefined;
      request.on("data", (chunk) => {
        if (data === undefined) {
          data = chunk as string;
        } else {
          data += chunk;
        }
      });
      return await new Promise((resolve, reject) => {
        let data: string | undefined;
        request.on("data", (chunk) => {
          if (data === undefined) {
            data = chunk as string;
          } else {
            data += chunk;
          }
        });
        request.on("end", () => {
          const statusCodeVal =
            incomingHeaders[http2.constants.HTTP2_HEADER_STATUS];
          const statusCode =
            typeof statusCodeVal === "number" ? statusCodeVal : undefined;
          if (
            statusCode === undefined ||
            (statusCode !== 200 && statusCode !== 204)
          ) {
            reject(new errors.Non2xxStatusCodeError(statusCode ?? -1));
          } else {
            resolve({
              headers: Object.entries(incomingHeaders).reduce<
                typeof incomingHeaders
              >(
                (acc, [k, v]) =>
                  typeof k == "symbol" ||
                  k === http2.constants.HTTP2_HEADER_STATUS
                    ? acc
                    : ((acc[k] = v), acc),
                {},
              ),
              body: data === undefined ? undefined : JSON.parse(data, reviver),
            });
          }
        });
        request.on("error", (error) => {
          reject(error);
        });

        if (body !== undefined) {
          request.write(body);
        }
        request.end();
      });
    } finally {
      await pool.release(session);
    }
  };
};

export type Optionalize<T> = { [P in keyof T]?: T[P] };

const getOutgoingHeaders = (headers: Record<string, unknown> | undefined) =>
  headers === undefined
    ? undefined
    : data.transformEntries(headers, getOutgoingHeader);

const getOutgoingHeader = (header: unknown): http.OutgoingHttpHeader =>
  typeof header === "string" || typeof header === "number"
    ? header
    : Array.isArray(header)
    ? header.filter((v) => v !== undefined).map((v) => `${v}`)
    : `${header}`;
