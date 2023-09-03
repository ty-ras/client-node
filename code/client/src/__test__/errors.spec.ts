/**
 * @file This file contains tests for file `../errors.ts`.
 */

import test from "ava";
import * as spec from "../errors";

test("Validate that isNon2xxStatusCodeError method works", (c) => {
  c.plan(2);
  c.true(spec.isNon2xxStatusCodeError(new spec.Non2xxStatusCodeError(999)));
  c.false(spec.isNon2xxStatusCodeError(new Error()));
});
