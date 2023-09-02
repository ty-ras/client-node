/**
 * @file This file contains tests for file `../client.ts`.
 */

import test from "ava";
import getPort from "@ava/get-port";
import * as http from "node:http";
import * as http2 from "node:http2";
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

  const capturedInfo = await createTrackingServer1AndListen(host, port);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: {
        connection: "close",
        host: "localhost",
      },
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: {
      connection: "close",
    },
  });
});

test("Verify that http1 pooling variant works", async (c) => {
  c.plan(5);
  const host = "localhost";
  const port = await getPort();
  const acquired: Array<spec.HTTP1ConnectionAbstraction> = [];
  const release: Array<spec.HTTP1ConnectionAbstraction> = [];
  const callback = spec.createCallHTTPEndpoint({
    httpVersion: 1,
    acquire: () => {
      const agent = new http.Agent({ host, port });
      acquired.push(agent);
      return Promise.resolve(agent);
    },
    release: (agent) => {
      release.push(agent);
      return Promise.resolve();
    },
  });

  const capturedInfo = await createTrackingServer1AndListen(host, port);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: {
        connection: "close",
        host: "localhost",
      },
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: {
      connection: "close",
    },
  });
  c.deepEqual(acquired.length, 1);
  c.deepEqual(release.length, 1);
  c.true(acquired[0] === release[0]);
});

test("Verify that http2 variant works", async (c) => {
  c.plan(5);
  const host = "localhost";
  const port = await getPort();
  const acquired: Array<spec.HTTP2ConnectionAbstraction> = [];
  const release: Array<spec.HTTP2ConnectionAbstraction> = [];
  const callback = spec.createCallHTTPEndpoint({
    httpVersion: 2,
    acquire: () => {
      const connection = http2.connect(`http://${host}:${port}`);
      acquired.push(connection);
      return Promise.resolve(connection);
    },
    release: (connection) => {
      release.push(connection);
      return Promise.resolve();
    },
  });

  const capturedInfo = await createTrackingServer2AndListen(host, port);

  const method = "GET";
  const url = "/hello";
  const result = await callback({ method, url });
  c.deepEqual(capturedInfo, [
    {
      method,
      url,
      headers: {
        [http2.constants.HTTP2_HEADER_AUTHORITY]: `${host}:${port}`,
        [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_GET,
        [http2.constants.HTTP2_HEADER_PATH]: url,
        [http2.constants.HTTP2_HEADER_SCHEME]: "http",
        [http2.sensitiveHeaders]: [],
      },
    },
  ]);
  c.deepEqual(result, {
    body: undefined,
    headers: {
      [http2.constants.HTTP2_HEADER_STATUS]: 204,
      [http2.sensitiveHeaders]: [],
    },
  });
  c.deepEqual(acquired.length, 1);
  c.deepEqual(release.length, 1);
  c.true(acquired[0] === release[0]);
});

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

const createTrackingServer1AndListen = async (host: string, port: number) => {
  const capturedInfo: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, unknown>;
  }> = [];
  const server = http.createServer((req, res) => {
    capturedInfo.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    });
    res.statusCode = 204;
    res.sendDate = false; // Makes life easier
    res.end();
  });
  await listenAsync(server, host, port);
  return capturedInfo;
};

const createTrackingServer2AndListen = async (host: string, port: number) => {
  const capturedInfo: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, unknown>;
  }> = [];
  const server = http2.createServer((req, res) => {
    capturedInfo.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    });
    res.statusCode = 204;
    res.sendDate = false; // Makes life easier
    res.end();
  });
  await listenAsync(server, host, port);
  return capturedInfo;
};
