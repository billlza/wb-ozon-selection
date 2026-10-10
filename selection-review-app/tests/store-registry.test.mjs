import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isKnownStore, listStores, PLATFORMS, platformOfStore, profitRuleKeyOfStore, STORES, storeLabel, storesOfPlatform
} from "../lib/store-registry.mjs";
import { STORE_PLATFORMS } from "../lib/store-binding.mjs";
import { resolveLifecycleBProfitRule } from "../lib/lifecycle-b-evidence-runtime.mjs";
import { STORE_LABELS } from "../src/constants.js";
import { candidatePlatform } from "../src/formState.js";
import { normalizeStoreBindings } from "../lib/runtime-configuration.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("WB is a platform with its own store; every store answers its platform from one registry", () => {
  assert.deepEqual(PLATFORMS.map(item => item.platform), ["ozon", "wb"]);
  assert.deepEqual(storesOfPlatform("ozon"), ["dandanshu", "miska"]);
  assert.deepEqual(storesOfPlatform("wb"), ["wb"]);
  assert.equal(platformOfStore("miska"), "ozon");
  assert.equal(platformOfStore("wb"), "wb");
  assert.equal(platformOfStore("nope"), null, "不认识的店铺不兜底成 Ozon");
  assert.equal(platformOfStore(undefined), null);
  assert.equal(isKnownStore("constructor"), false);
  assert.equal(storeLabel("dandanshu"), "蛋蛋鼠");
  assert.equal(STORES.find(store => store.storeId === "wb").labelConfirmed, false, "WB 店名还没定，只是占位");
});

test("existing callers see exactly the values they saw before the registry", () => {
  assert.deepEqual(STORE_PLATFORMS, { dandanshu: "ozon", miska: "ozon", wb: "wb" });
  assert.deepEqual(Object.entries(STORE_LABELS), [["dandanshu", "蛋蛋鼠"], ["miska", "Miska"], ["wb", "WB"]]);
  const rules = { ozonDandanshu: { name: "d" }, ozonMiska: { name: "m" }, wbCrossListing: { name: "w" } };
  assert.equal(resolveLifecycleBProfitRule({ targetStore: "miska" }, rules).name, "m");
  assert.equal(resolveLifecycleBProfitRule({ targetStore: "wb" }, rules).name, "w");
  assert.throws(() => resolveLifecycleBProfitRule({ targetStore: "nope" }, rules), /B_EVIDENCE_COST_POLICY_INCOMPLETE/);
  assert.equal(profitRuleKeyOfStore("dandanshu"), "ozonDandanshu");
  assert.equal(candidatePlatform({ targetStore: "wb" }), "wb");
  assert.throws(() => candidatePlatform({ targetStore: "nope" }), /平台与目标店铺不一致/);
});

test("the store list says whether each store's identity is configured without handing out seller ids", () => {
  const bindings = normalizeStoreBindings([{ targetStore: "miska", platform: "ozon",
    storeRef: { stableStoreId: "miska", platformStoreId: "3852479", mappingVersion: "stores-v1" } }]);
  const view = listStores({ storeBindings: bindings });
  assert.equal(view.registryVersion, "stores-v1");
  assert.deepEqual(view.platforms, [
    { platform: "ozon", label: "Ozon", storeIds: ["dandanshu", "miska"] },
    { platform: "wb", label: "WB", storeIds: ["wb"] }
  ]);
  assert.deepEqual(view.stores.map(store => [store.storeId, store.platform, store.identityConfigured]),
    [["dandanshu", "ozon", false], ["miska", "ozon", true], ["wb", "wb", false]]);
  assert.equal(JSON.stringify(view).includes("3852479"), false);
  assert.deepEqual(listStores().stores.map(store => store.identityConfigured), [false, false, false]);
  assert.throws(() => listStores({ storeBindings: {} }), /STORE_REGISTRY_BINDINGS_INVALID/);
});

test("no business module guesses the platform from the WB store key any more", async () => {
  const files = ["lib/lifecycle-b-evidence-context.mjs", "lib/lifecycle-b-evidence-runtime.mjs", "lib/lifecycle-b-input-bundle.mjs",
    "lib/real-a-b-c1-flow.mjs", "lib/legacy-candidate-adapter.mjs", "lib/workflow.mjs", "lib/codex-dispatcher.mjs",
    "src/formState.js", "src/components/UserInspector.jsx"];
  for (const file of files) {
    const source = await readFile(path.join(appDir, file), "utf8");
    assert.doesNotMatch(source, /targetStore === "wb" \? "wb" : "ozon"/, file);
    assert.doesNotMatch(source, /\["dandanshu", "miska"(, "wb")?\]/, file);
    assert.doesNotMatch(source, /targetStore === "wb"/, file);
  }
});
