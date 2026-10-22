import test from "node:test";
import assert from "node:assert/strict";
import { applyNameMap, dismissKey, mergeIntoMap, normalizeLocation, resolveName, skeleton, suggestArtistGroups, suggestLocationGroups } from "../nameCleanup.js";

test("Temple Interior and Temple Exterior are one place (the in/out word is not part of the name)", () => {
  assert.equal(normalizeLocation("Temple Interior"), "TEMPLE");
  assert.equal(normalizeLocation("TEMPLE EXTERIOR"), "TEMPLE");
  assert.equal(normalizeLocation("INT./EXT. Temple Sanctum"), "TEMPLE SANCTUM");
  assert.equal(normalizeLocation("Temple Kutiyar"), "TEMPLE KUTIYAR");
  assert.equal(normalizeLocation("INTERIOR"), "INTERIOR"); // never an empty name
});

test("spellings of one name share a skeleton", () => {
  assert.equal(skeleton("Soumya"), skeleton("Saumia"));
  assert.notEqual(skeleton("Soumya"), skeleton("Nayana"));
});

test("artists written two ways are suggested, different people are not", () => {
  const groups = suggestArtistGroups(["SOUMYA", "SAUMIA", "NAYANA", "MALATI", "SULOCHANA", "SULOCHONA", "VILLAGER 1", "VILLAGER 2", "RATAN", "RAM"]);
  assert.deepEqual(groups.map((g) => g.sort()), [["SAUMIA", "SOUMYA"], ["SULOCHANA", "SULOCHONA"]]);
});

test("places of one set are suggested; two houses of two people are not", () => {
  const names = ["TEMPLE", "TEMPLE SANCTUM", "TEMPLE KUTIYAR", "MALATI HOUSE", "BALARAM HOUSE", "MALATI CLINIC", "CLINIC", "KALI TEMPLE GROUNDS"];
  const groups = suggestLocationGroups(names, ["MALATI", "BALARAM", "SOUMYA"]).map((g) => g.sort());
  const temple = groups.find((g) => g.includes("TEMPLE"));
  assert.ok(temple && ["TEMPLE KUTIYAR", "TEMPLE SANCTUM"].every((n) => temple.includes(n)));
  assert.ok(!groups.flat().includes("MALATI HOUSE"));
  assert.ok(!groups.flat().includes("BALARAM HOUSE"));
});

test("a typo of a place is suggested", () => {
  assert.deepEqual(suggestLocationGroups(["CONSTRUCTION SITE", "CONSTRUCTION SITTE", "CLINIC"]).map((g) => g.sort()), [["CONSTRUCTION SITE", "CONSTRUCTION SITTE"]]);
});

test("merging keeps the map flat and follows to the final name", () => {
  let map = mergeIntoMap({}, ["SAUMIA", "SOUMYA"], "SOUMYA");
  assert.deepEqual(map, { SAUMIA: "SOUMYA" });
  map = mergeIntoMap(map, ["SOUMYA", "SOMYA"], "SOMYA"); // SOUMYA now joins SOMYA, and SAUMIA follows
  assert.deepEqual(map, { SOUMYA: "SOMYA", SAUMIA: "SOMYA" });
  assert.equal(resolveName(map, "SAUMIA"), "SOMYA");
  assert.equal(resolveName(map, "UNKNOWN"), "UNKNOWN");
  assert.deepEqual(mergeIntoMap({}, ["TEMPLE", "TEMPLE SANCTUM"], "Temple"), { "TEMPLE SANCTUM": "TEMPLE" });
});

test("the owner's names are applied to the scenes; the original place name stays visible", () => {
  const rows = [
    { id: "a", location: "TEMPLE SANCTUM", artists: ["SAUMIA", "NAYANA"] },
    { id: "b", location: "TEMPLE KUTIYAR", artists: ["SOUMYA"] },
  ];
  const out = applyNameMap(rows, { location: { "TEMPLE SANCTUM": "TEMPLE", "TEMPLE KUTIYAR": "TEMPLE" }, artist: { SAUMIA: "SOUMYA" } });
  assert.deepEqual(out.map((r) => r.location), ["TEMPLE", "TEMPLE"]);
  assert.deepEqual(out.map((r) => r.rawLocation), ["TEMPLE SANCTUM", "TEMPLE KUTIYAR"]);
  assert.deepEqual(out[0].artists, ["NAYANA", "SOUMYA"]);
  assert.deepEqual(applyNameMap(out, { artist: {} })[0].rawArtists, ["SAUMIA", "NAYANA"]);
});

test("a dismissed suggestion has a stable key", () => {
  assert.equal(dismissKey(["b", "A"]), dismissKey(["A", "B"]));
});
