import test from "node:test";
import assert from "node:assert/strict";
import { selectC1DescriptionParts } from "../lib/c1-description-content.mjs";

test("description preserves original text and selects each additional bullet once with its review index", () => {
  const description = "Жилет для кошек.\n\nМатериал: Оксфорд.";
  const bullets = ["Материал:  Оксфорд.", "Регулируемая застежка.", "Регулируемая   застежка.", "Для кошек и собак."];
  const before = structuredClone(bullets);
  assert.deepEqual(selectC1DescriptionParts(description, bullets), [
    { source: "description", index: 0, text: description },
    { source: "bullet", index: 1, text: bullets[1] }, { source: "bullet", index: 3, text: bullets[3] }
  ]);
  assert.deepEqual(bullets, before);
});

test("missing text is explicit and distinct claims are not semantically rewritten", () => {
  for (const [description, bullets] of [["", []], ["Текст", null], ["Текст", [null]], ["Текст", [" "]]]) {
    assert.throws(() => selectC1DescriptionParts(description, bullets), /C1_DESCRIPTION_CONTENT_INVALID/);
  }
  assert.equal(selectC1DescriptionParts("Для кошек.", ["Не для кошек."]).length, 2);
  assert.equal(selectC1DescriptionParts("Текст", []).length, 1);
});
