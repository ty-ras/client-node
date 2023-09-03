/**
 * @file This file contains function to create {@link dataFE.CallHTTPEndpoint} which will use `fetch` API to do the requests.
 */

import * as data from "@ty-ras/data";
import type * as dataFE from "@ty-ras/data-frontend";
import * as http from "node:http";
import * as https from "node:https";
import * as http2 from "node:http2";
import * as url from "node:url";
import type * as stream from "node:stream";
import * as errors from "./errors";
import * as encoding from "./encoding";

/**
 * This function will create a {@link dataFE.CallHTTPEndpoint} callback using Node-native HTTP1 and HTTP2 -related modules.
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
  const reviver = data.getJSONParseReviver(allowProtoProperty === true);

  return callerArgs.httpVersion === 2
    ? callUsingHttp2(callerArgs, commonPathPrefix ?? "", reviver)
    : callUsingHttp1(
        "acquire" in callerArgs && "release" in callerArgs
          ? callerArgs
          : constructSingletonPool(callerArgs),
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

/**
 * These options used to create callback thru {@link createCallHTTPEndpoint} should be either {@link HTTPEndpointCallerOptions1} for HTTP1 protocol, or {@link HTTPEndpointCallerOptions2} for HTTP2 protocol.
 */
export type HTTPEndpointCallerOptions =
  | HTTPEndpointCallerOptions1
  | HTTPEndpointCallerOptions2;

/**
 * This interface contains properties common for both {@link HTTPEndpointCallerOptions1} and {@link HTTPEndpointCallerOptions2}.
 */
export interface HTTPEndpointCallerOptionsBase {
  /**
   * If set to `true`, will NOT strip the `__proto__` properties of the result.
   */
  allowProtoProperty?: boolean;

  /**
   * The optional path prefix for backend HTTP endpoints.
   * If provided, typically should include the last `/` character - the given URL paths will be concatenated directly after this without putting any logic in concatenation.
   */
  commonPathPrefix?: string;
}

/**
 * This is generic interface encapsulating pool-like behaviour for when using {@link HTTP1ConnectionAbstraction}, or {@link HTTP2ConnectionAbstraction}.
 */
export interface HTTPConnectionUsageOptions<TConnection> {
  /**
   * Should asynchronously acquire the connection abstraction to be used in single HTTP call.
   * @returns The instance of connection abstraction for HTTP calls.
   */
  acquire: () => Promise<TConnection>;

  /**
   * Should asynchronously mark the given connection as free to be used in subsequent {@link acquire} calls.
   * @param connection The connection abstraction returned by {@link acquire}.
   * @returns Asynchronously returns nothing.
   */
  release: (connection: TConnection) => Promise<void>;
}

/**
 * This interface contains properties used in {@link createCallHTTPEndpoint} when HTTP1 protocol is used, but no pool-like functionality for {@link http.Agent} is provided.
 * It will cause for single {@link HTTP1ConnectionAbstraction} to be used for all HTTP calls.
 * If {@link scheme} is `https`, then {@link https.Agent} will be used instead.
 */
export interface HTTPEndpointCallerOptions1WithoutAgent {
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
   * Set this to `true` in order to accept secure connections with invalid (e.g. self-signed) certificate.
   */
  rejectUnauthorized?: boolean;
}

/**
 * This type is used in {@link createCallHTTPEndpoint} when using HTTP1 protocol.
 */
export type HTTPEndpointCallerOptions1 = HTTPEndpointCallerOptionsBase &
  encoding.HTTPEncodingOptions1 &
  (
    | HTTPConnectionUsageOptions<HTTP1ConnectionAbstraction>
    | HTTPEndpointCallerOptions1WithoutAgent
  ) & {
    /**
     * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
     * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
     */
    httpVersion?: 1;
  };

/**
 * This type is used in {@link createCallHTTPEndpoint} when using HTTP2 protocol.
 */
export interface HTTPEndpointCallerOptions2
  extends HTTPEndpointCallerOptionsBase,
    encoding.HTTPEncodingOptions2,
    HTTPConnectionUsageOptions<HTTP2ConnectionAbstraction> {
  /**
   * Forces the argument of {@link createCallHTTPEndpoint} to use HTTP1 connections.
   * This needs to be done explicitly, auto-upgrade scenarios are not trivial, see [discussion on GitHub](https://github.com/nodejs/node/issues/31759).
   */
  httpVersion: 2;
}

/**
 * This type is connection abstraction for when HTTP1 protocol is used for calling REST API endpoints.
 *
 * Notice that for `https` secure connections, the {@link https.Agent} can be returned.
 * Since it is subclass of {@link http.Agent}, it will work with this type.
 */
export type HTTP1ConnectionAbstraction = http.Agent;

/**
 * This type is connection abstraction for when HTTP2 protocol is used for calling REST API endpoints.
 *
 * Since only `request` function is needed from the {@link http2.ClientHttp2Session} by the code, this type narrows it down to that.
 * This allows easier customizations e.g. if some additional parameters are needed to be passed to real {@link http2.ClientHttp2Session.request} method.
 */
export type HTTP2ConnectionAbstraction = {
  [P in "request"]: http2.ClientHttp2Session[P];
};

const constructSingletonPool = ({
  scheme,
  host,
  port,
  rejectUnauthorized,
}: HTTPEndpointCallerOptions1WithoutAgent): HTTPConnectionUsageOptions<HTTP1ConnectionAbstraction> => {
  const opts: http.AgentOptions = Object.assign(
    {
      host,
    },
    port === undefined ? {} : { port },
  );

  const agent =
    scheme === "https"
      ? new https.Agent({
          ...opts,
          rejectUnauthorized,
        })
      : new http.Agent(opts);

  return {
    acquire: () => Promise.resolve(agent),
    // Release is no-op
    release: () => Promise.resolve(),
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
  {
    acquire,
    release,
    encodingForReading: _encodingForReading,
    encodingForWriting: _encodingForWriting,
  }: HTTPConnectionUsageOptions<HTTP1ConnectionAbstraction> &
    encoding.HTTPEncodingOptions1,
  commonPathPrefix: string,
  reviver: JSONReviver,
): dataFE.CallHTTPEndpoint => {
  const encodingForReading =
    _encodingForReading ??
    encoding.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForReading;
  const encodingForWriting =
    _encodingForWriting ??
    encoding.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForWriting;
  return async ({ headers, url, method, query, ...args }) => {
    const { pathname, search } = constructURLObject(
      commonPathPrefix,
      url,
      query,
    );
    // If rejectUnauthorized is specified, we must construct separate https.Agent.
    // Do it per request to avoid possible congestion.
    const agent = await acquire();
    try {
      const outgoingHeaders = getOutgoingHeaders(headers);
      return await new Promise((resolve, reject) => {
        try {
          const writeable = http
            .request(
              {
                agent,
                protocol: agent instanceof https.Agent ? "https:" : "http:",
                method,
                path: `${pathname}${search}`,
                headers: outgoingHeaders,
              },
              (resp) => {
                setReadableEncoding(resp, encodingForReading, resp.headers);
                handleResolvingOfResponse(
                  reviver,
                  resp,
                  resolve,
                  reject,
                  () => resp.statusCode,
                  resp.headers,
                );
              },
            )
            .on("error", (err) => {
              reject(err);
            });

          writeBodyAndEnd(
            writeable,
            args,
            encodingForWriting,
            outgoingHeaders ?? {},
          );
        } catch (e) {
          /* c8 ignore next 2 */
          reject(e);
        }
      });
    } finally {
      await release(agent);
    }
  };
};

const callUsingHttp2 = (
  {
    acquire,
    release,
    encodingForReading: _encodingForReading,
    encodingForWriting: _encodingForWriting,
  }: HTTPConnectionUsageOptions<HTTP2ConnectionAbstraction> &
    encoding.HTTPEncodingOptions2,
  commonPathPrefix: string,
  reviver: JSONReviver,
): dataFE.CallHTTPEndpoint => {
  const encodingForReading =
    _encodingForReading ??
    encoding.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForReading;
  const encodingForWriting =
    _encodingForWriting ??
    encoding.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForWriting;
  return async ({ headers, url, method, query, ...args }) => {
    const { pathname, search } = constructURLObject(
      commonPathPrefix,
      url,
      query,
    );
    const session = await acquire();
    try {
      const outgoingHeaders = {
        ...getOutgoingHeaders(headers),
        [http2.constants.HTTP2_HEADER_METHOD]: method,
        [http2.constants.HTTP2_HEADER_PATH]: `${pathname}${search}`,
      };
      const request = session.request(outgoingHeaders);

      let incomingHeaders: http2.IncomingHttpHeaders = {};
      request.on("response", (hdrs) => {
        incomingHeaders = hdrs;
        setReadableEncoding(request, encodingForReading, hdrs);
      });
      return await new Promise((resolve, reject) => {
        try {
          handleResolvingOfResponse(
            reviver,
            request,
            resolve,
            reject,
            () => {
              const statusCodeVal =
                incomingHeaders[http2.constants.HTTP2_HEADER_STATUS];
              return typeof statusCodeVal === "number"
                ? statusCodeVal
                : undefined;
            },
            () => incomingHeaders,
          );

          // Couldn't figure out how to produce this scenario in test bed, hence the C8 ignore
          request.on("error", (error) => {
            /* c8 ignore next */
            reject(error);
          });

          writeBodyAndEnd(request, args, encodingForWriting, outgoingHeaders);
        } catch (e) {
          /* c8 ignore next 2 */
          reject(e);
        }
      });
    } finally {
      await release(session);
    }
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

const constructURLObject = (
  commonPathPrefix: string,
  path: string,
  query: Record<string, unknown> | undefined,
): { pathname: string; search: string } => {
  const pathname = `${commonPathPrefix}${path}`.replaceAll(
    /\?|#/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const search = getURLSearchParams(query ?? {});
  return {
    pathname: pathname,
    search: search.length > 0 ? `?${search}` : "",
  };
};

const writeBodyAndEnd = <THeaders extends http.OutgoingHttpHeaders>(
  writable: stream.Writable,
  args: { body?: unknown },
  encodingForWriting: encoding.HTTPEncodingFunctionality<THeaders>,
  headers: THeaders,
) => {
  const body = "body" in args ? JSON.stringify(args.body) : undefined;
  if (body !== undefined) {
    // Notice that despite what typings claim, the 'setDefaultEncoding' method will not be present on HTTP1 client request!
    // Therefore, just use write overload, since we call write only once anyway.
    try {
      writable.write(
        body,
        typeof encodingForWriting === "function"
          ? encodingForWriting(headers)
          : encodingForWriting,
      );
    } catch (e) {
      /* c8 ignore next 9 */
      // Adding to C8 ignore because can't test since Node crashes...
      // No idea why 'code' isn't exposed in typings...
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      if (e instanceof Error && (e as any).code === "ERR_UNKNOWN_ENCODING") {
        writable.write(body, encoding.DEFAULT_ENCODING);
      } else {
        throw e;
      }
    }
  }
  writable.end();
};

const handleResolvingOfResponse = (
  reviver: JSONReviver,
  source: stream.Stream,
  resolve: (result: dataFE.HTTPInvocationResult) => void,
  reject: (error: unknown) => void,
  getStatusCode: () => number | undefined,
  getHeaders: http.IncomingHttpHeaders | (() => http.IncomingHttpHeaders),
) => {
  let data: string | undefined;
  source.on("data", (chunk: string) => {
    if (data === undefined) {
      data = chunk;
    } else {
      /* c8 ignore next 3 */
      // Looks like on localhost even sending very large data bodies does not cause this to happen, hence C8 ignore.
      data += chunk;
    }
  });
  source.on("end", () => {
    const statusCode = getStatusCode();
    if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
      reject(new errors.Non2xxStatusCodeError(statusCode ?? -1));
    } else {
      resolve({
        headers: typeof getHeaders === "function" ? getHeaders() : getHeaders,
        body: data === undefined ? undefined : JSON.parse(data, reviver),
      });
    }
  });
};

type JSONReviver = ReturnType<typeof data.getJSONParseReviver>;

const setReadableEncoding = <THeaders extends http.IncomingHttpHeaders>(
  readable: stream.Readable,
  encodingForReading: encoding.HTTPEncodingFunctionality<THeaders>,
  headers: THeaders,
) => {
  try {
    readable.setEncoding(
      typeof encodingForReading === "function"
        ? encodingForReading(headers)
        : encodingForReading,
    );
  } catch {
    /* c8 ignore next 4 */
    // Can't test since Node crashes on this or when doing it for writable.
    // Probably some garbage returned from the function / value
    readable.setEncoding(encoding.DEFAULT_ENCODING);
  }
};
