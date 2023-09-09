/**
 * @file This file contains tests for file `../encoding.ts`.
 */

import test, { type ExecutionContext } from "ava";
import * as spec from "../encoding";
import type * as http from "node:http";

test("Test that default encoding is what is expected", (c) => {
  c.plan(1);
  c.deepEqual(spec.DEFAULT_ENCODING, "utf-8");
});

test("Test that default encoding options find the encoding from content-type header", (c) => {
  const doTest = createDoTest(c);
  c.plan(10);
  doTest(
    {},
    spec.DEFAULT_ENCODING,
    "Without headers, default encoding should be used",
  );
  doTest(
    { hello: "nothing" },
    spec.DEFAULT_ENCODING,
    "With some headers but without content-type header, the default encoding should be used",
  );
  doTest(
    { "content-type": "application/json" },
    spec.DEFAULT_ENCODING,
    "When no encoding information present in content-type header, the default encoding should be used",
  );
  doTest(
    { "content-type": "application/json; charset=utf16le" },
    "utf16le",
    "When encoding specified in content-type header, it must be used",
  );
  doTest(
    {
      "content-type":
        "application/json; charset=utf16le ; somethingElse=should-be-ignored",
    },
    "utf16le",
    "Whatever comes after charset should be ignored",
  );
});

test("Verify that casing should not matter for encoding detection", (c) => {
  const doTest = createDoTest(c);
  c.plan(2);
  doTest(
    { "Content-Type": "text/xml;Charset=ascii" },
    "ascii",
    "The encoding should be picked up from content-type header even when not fully lowercased (both header and charset mark).",
  );
});

const createDoTest =
  (
    c: ExecutionContext,
  ): ((
    input: http.IncomingHttpHeaders,
    output: BufferEncoding,
    message: string,
  ) => void) =>
  (input, output, message) => {
    c.deepEqual(
      spec.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForReading(input),
      output,
      `Reading: ${message}`,
    );
    c.deepEqual(
      spec.DEFAULT_HTTP_ENCODING_OPTIONS.encodingForWriting(input),
      output,
      `Writing: ${message}`,
    );
  };
