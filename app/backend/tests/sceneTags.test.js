import test from "node:test";
import assert from "node:assert/strict";
import { allowedChange, TAGS } from "../sceneTags.js";

test("there are four tags: change, check, new, done", () => {
  assert.deepEqual(TAGS, ["change", "check", "new", "done"]);
});

test("the admin may set any tag, change it, or clear it — but not invent one", () => {
  for (const tag of TAGS) assert.equal(allowedChange("admin", undefined, tag), true);
  assert.equal(allowedChange("admin", "change", null), true);
  assert.equal(allowedChange("admin", "done", "change"), true);
  assert.equal(allowedChange("admin", undefined, "purple"), false);
});

test("the writer may only turn a tagged, unfinished scene into done", () => {
  assert.equal(allowedChange("screenplay_writer", "change", "done"), true);
  assert.equal(allowedChange("screenplay_writer", "new", "done"), true);
  assert.equal(allowedChange("screenplay_writer", undefined, "done"), false); // nothing was asked of him
  assert.equal(allowedChange("screenplay_writer", "done", "done"), false);
  assert.equal(allowedChange("screenplay_writer", "change", null), false); // cannot clear
  assert.equal(allowedChange("screenplay_writer", "change", "check"), false);
  assert.equal(allowedChange("screenplay_writer", "change", "change"), false);
});

test("no other login may touch tags", () => {
  for (const role of ["director", "production_manager", "production", "designer", undefined]) assert.equal(allowedChange(role, "change", "done"), false);
});
