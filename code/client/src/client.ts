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
 * @returns A {@link dataFE.CallHTTPEndpoint} callback which can be used to create instances of {@link dataFE.APICallFactoryBase}.
 * It will throw {@link errors.InvalidPathnameError} or {@link errors.Non2xxStatusCodeError} if invoked with wrong arguments, and also whatever the {@link URL} constructor might throw on invalid URLs.
 */
export const createCallHTTPEndpoint = (
  callerArgs: HTTPEndpointCallerArgs,
): dataFE.CallHTTPEndpoint => {
  // If some garbage provided as args, then this will throw
  const baseURLInfo = validateBaseURL(callerArgs);
  const allowProtoProperty =
    typeof callerArgs == "string"
      ? true
      : callerArgs.allowProtoProperty === true;
  const reviver = data.getJSONParseReviver(allowProtoProperty);
  const isHttp2 =
    typeof callerArgs !== "string" && callerArgs.httpVersion === 2;
  const rejectUnauthorized =
    typeof callerArgs !== "string" && callerArgs.rejectUnauthorized === true;
  return callUsingHttp1(baseURLInfo, reviver, rejectUnauthorized);
};

/**
 * This type is the argument of {@link createCallHTTPEndpoint}.
 * It can be either string, which is then interpreted as full URL.
 * Alternatively, it can be a structured object {@link HTTPEndpointCallerArgs}.
 */
export type HTTPEndpointCallerArgs = string | HTTPEndpointCallerOptions;

export type HTTPEndpointCallerOptions =
  | HTTPEndpointCallerOptions1
  | HTTPEndpointCallerOptions2;

export interface HTTPEndpointCallerOptionsBase {
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

  /**
   * If set to `true`, will NOT strip the `__proto__` properties of the result.
   */
  allowProtoProperty?: boolean;

  /**
   * Set this to `true` in order to accept secure connections with invalid (e.g. self-signed) certificate.
   */
  rejectUnauthorized?: boolean;
}

export interface HTTPConnectionUsageOptions<TConnection> {
  acquire: () => Promise<TConnection>;
  release: (connection: TConnection) => Promise<void>;
}

/**
 * This type is the structured version of URL string passed to {@link createCallHTTPEndpoint}, extending {@link HTTPEndpointCallerOptionsBase} and using HTTP1 protocol.
 */
export interface HTTPEndpointCallerOptions1
  extends HTTPEndpointCallerOptionsBase {
  /**
   * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
   * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
   */
  httpVersion?: 1;
}

/**
 * This type is the structured version of URL string passed to {@link createCallHTTPEndpoint}, extending {@link HTTPEndpointCallerOptionsBase} and using HTTP2 protocol.
 */
export interface HTTPEndpointCallerOptions2
  extends HTTPEndpointCallerOptionsBase {
  /**
   * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
   * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
   */
  httpVersion?: 2;
}

/**
 * This is exported for the tests only - it is not exported via index.ts
 * @param args The {@link HTTPEndpointCallerArgs}.
 * @returns The constructed URL string.
 */
export const validateBaseURL = (args: HTTPEndpointCallerArgs) => {
  const baseURLString =
    typeof args === "string"
      ? args
      : `${args.scheme}://${args.host}${"port" in args ? `:${args.port}` : ""}${
          args.path ?? ""
        }`;

  return {
    baseURLString,
    // Validate by trying to construct URL object. Will throw on invalid things.
    url: new url.URL(baseURLString),
  };
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
  { url: baseURL, baseURLString }: ReturnType<typeof validateBaseURL>,
  reviver: ReturnType<typeof data.getJSONParseReviver>,
  rejectUnauthorized: boolean,
): dataFE.CallHTTPEndpoint => {
  // eslint-disable-next-line sonarjs/cognitive-complexity
  return ({ headers, url, method, query, ...args }) => {
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
    const agent =
      baseURL.protocol.startsWith("https") && rejectUnauthorized
        ? new https.Agent({
            rejectUnauthorized: true,
          })
        : undefined;
    return new Promise((resolve, reject) => {
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
                    data === undefined ? undefined : JSON.parse(data, reviver),
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
  };
};

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
