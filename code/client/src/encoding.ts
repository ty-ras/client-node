/**
 * @file This file contains types and functionality related to string encoding to be used for HTTP requests and responses.
 */

import type * as http from "node:http";
import * as http2 from "node:http2";

/**
 * This is generic interface encapsulating functionality related to string encodings for both HTTP1 and HTTP2 protocols.
 * @see HTTPEncodingOptions1
 * @see HTTPEncodingOptions2
 */
export interface HTTPEncodingOptions<
  TOutgoingHeaders extends http.OutgoingHttpHeaders,
  TIncomingHeaders extends http.IncomingHttpHeaders,
> {
  /**
   * Optional property to get string encoding when writing request body.
   */
  encodingForWriting?: HTTPEncodingFunctionality<TOutgoingHeaders>;

  /**
   * Optional property to get string encoding when reading response body.
   */
  encodingForReading?: HTTPEncodingFunctionality<TIncomingHeaders>;
}

/**
 * This type specializes generic {@link HTTPEncodingOptions} for HTTP1 protocol.
 */
export type HTTPEncodingOptions1 = HTTPEncodingOptions<
  http.OutgoingHttpHeaders,
  http.IncomingHttpHeaders
>;

/**
 * This type specializes generic {@link HTTPEncodingOptions} for HTTP2 protocol.
 */
export type HTTPEncodingOptions2 = HTTPEncodingOptions<
  http2.OutgoingHttpHeaders,
  http2.IncomingHttpHeaders
>;

/**
 * This is generic type which captures common functionality related to string encoding, used by {@link HTTPEncodingOptions}.
 */
export type HTTPEncodingFunctionality<THeaders> =
  | BufferEncoding
  | ((headers: Readonly<THeaders>) => BufferEncoding);

/**
 * This is the default fallback encoding used by {@link DEFAULT_HTTP_ENCODING_OPTIONS}: `utf8`.
 */
export const DEFAULT_ENCODING = "utf8" as const satisfies BufferEncoding;

const tryGetEncoding = (headers: Record<string, unknown>): BufferEncoding => {
  let encoding: BufferEncoding | undefined;
  for (const x in headers) {
    const val = headers[x];
    if (typeof val === "string") {
      if (/^content-type$/i.test(x)) {
        encoding = /;\s*charset=(?<encoding>[^\s;]+)/i.exec(val)?.groups?.[
          "encoding"
        ] as BufferEncoding | undefined;
      }
      if (encoding !== undefined) {
        break;
      }
    }
  }
  return encoding ?? DEFAULT_ENCODING;
};

const _DEFAULT_HTTP_ENCODING_OPTIONS = {
  encodingForWriting: tryGetEncoding,
  encodingForReading: tryGetEncoding,
} as const satisfies HTTPEncodingOptions1;

/**
 * This is the default {@link HTTPEncodingOptions} functionality which checks the `Content-Type` headers to see if it has `;<any amount of whitespaces>charset=xyz` in it, and use encoding from here if such specifier is present.
 * If that fails, the encoding value will be the one of {@link DEFAULT_ENCODING}: `utf8`.
 */
export const DEFAULT_HTTP_ENCODING_OPTIONS = Object.freeze(
  _DEFAULT_HTTP_ENCODING_OPTIONS,
);
