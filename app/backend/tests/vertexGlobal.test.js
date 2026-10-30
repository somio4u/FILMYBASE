import test from "node:test";
import assert from "node:assert/strict";
import { GoogleGenAI } from "@google/genai";
import { cleanLocation, vertexHttpOptions } from "../aiCredentials.js";

test("the 'global' Vertex location is allowed and the library is given the real host for it", () => {
  assert.equal(cleanLocation("global"), "global");
  assert.equal(vertexHttpOptions("global").baseUrl, "https://aiplatform.googleapis.com/");
  assert.equal(vertexHttpOptions("us-central1"), undefined);
  const make = (location) => new GoogleGenAI({ vertexai: true, project: "p", location, googleAuthOptions: { credentials: { client_email: "a@b", private_key: "x" } }, httpOptions: vertexHttpOptions(location) });
  assert.equal(make("global").apiClient.clientOptions.httpOptions.baseUrl, "https://aiplatform.googleapis.com/");
  assert.equal(make("us-central1").apiClient.clientOptions.httpOptions.baseUrl, "https://us-central1-aiplatform.googleapis.com/");
});
