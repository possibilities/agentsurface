import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { intentKeyBindings } from "../src/launch/app.ts";

/**
 * Pins the OpenTUI Textarea behavior the intent field relies on: plain
 * typing (including letters the default map also binds bare, like a and z),
 * the readline motions and kills, paste, and the keys it must NOT consume
 * so the shell keeps them (tab, escape, plain enter handled by the shell).
 */

async function field() {
  const setup = await createTestRenderer({ width: 60, height: 12 });
  const intent = new core.TextareaRenderable(setup.renderer, {
    id: "intent",
    width: 40,
    minHeight: 1,
    height: 1,
    wrapMode: "word",
    keyBindings: intentKeyBindings(core.defaultTextareaKeyBindings),
  });
  setup.renderer.root.add(intent);
  intent.focus();
  const press = (name: string, mods: Record<string, boolean> = {}): boolean =>
    intent.handleKeyPress({ name, sequence: name.length === 1 ? name : "", ...mods } as never);
  const type = (text: string): void => {
    for (const character of text) press(character);
  };
  return { setup, intent, press, type };
}

describe("the intent textarea", () => {
  test("types plainly, including letters the default map binds bare", async () => {
    const { setup, intent, type } = await field();
    type("za pizzazz");
    expect(intent.plainText).toBe("za pizzazz");
    setup.renderer.destroy();
  });

  test("readline motions, kills, and words behave", async () => {
    const { setup, intent, press, type } = await field();
    type("alpha beta");
    press("a", { ctrl: true });
    press("k", { ctrl: true });
    expect(intent.plainText).toBe("");
    type("one two");
    press("b", { meta: true });
    press("d", { meta: true });
    expect(intent.plainText).toBe("one ");
    press("w", { ctrl: true });
    expect(intent.plainText).toBe("");
    setup.renderer.destroy();
  });

  test("newlines come from shift+enter and paste; plain text getters round-trip", async () => {
    const { setup, intent, press, type } = await field();
    type("one");
    press("return", { shift: true });
    type("two");
    expect(intent.plainText).toBe("one\ntwo");
    intent.handlePaste(new core.PasteEvent(new TextEncoder().encode("P\nQ")));
    expect(intent.plainText).toBe("one\ntwoP\nQ");
    intent.setText("reset");
    expect(intent.plainText).toBe("reset");
    setup.renderer.destroy();
  });

  test("undo and redo ride the native history, every alias included", async () => {
    const { setup, intent, press, type } = await field();
    type("alpha beta");
    const killAndRestore = (undoName: string): void => {
      press("a", { ctrl: true });
      press("k", { ctrl: true });
      expect(intent.plainText).toBe("");
      press(undoName, { ctrl: true });
      expect(intent.plainText).toBe("alpha beta");
    };
    killAndRestore("-");
    press(".", { ctrl: true });
    expect(intent.plainText).toBe("");
    press("-", { ctrl: true });
    killAndRestore("_");
    killAndRestore("/");
    setup.renderer.destroy();
  });

  test("plain enter submits instead of inserting a newline", async () => {
    const { setup, intent, press, type } = await field();
    let submitted = 0;
    intent.onSubmit = () => {
      submitted += 1;
    };
    type("one");
    press("return");
    expect(intent.plainText).toBe("one");
    expect(submitted).toBe(1);
    setup.renderer.destroy();
  });

  test("leaves tab and escape to the shell", async () => {
    const { setup, press } = await field();
    expect(press("tab")).toBe(false);
    expect(press("escape")).toBe(false);
    setup.renderer.destroy();
  });
});
