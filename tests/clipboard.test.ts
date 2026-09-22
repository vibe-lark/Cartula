/**
 * Copying out of a host that will not allow it.
 *
 * The failure this pins down was reported from a real MCP card: every 复制
 * button answered 无法复制, while the same page in a browser copied fine. That
 * is the `clipboard-write` permission policy — its default allowlist is `self`,
 * and a card runs in an iframe the host owns — so `navigator.clipboard` is not
 * a capability Cartula can assume, ask for, or treat as the only route.
 *
 * What is asserted here is the ladder: the async API when it works, the old
 * selection-based command when it is refused, and an honest `unavailable` when
 * neither does — never a rejected promise, because the surface has to render
 * the third case as "here is the text" rather than as an error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, selectAll } from '../src/web/components/clipboard.js';

interface FakeField {
  value: string;
  readonly attributes: Record<string, string>;
  style: { cssText: string };
  focused: boolean;
  selection: [number, number] | undefined;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
}

/**
 * Just enough DOM for the fallback path, plus a record of what it did — the
 * point of the older route is that it touches the document, so the test has to
 * see the field appear, get selected and then leave again.
 */
function fakeDom(options: { copyCommand?: (field: FakeField) => boolean } = {}) {
  const created: FakeField[] = [];
  const body = {
    children: [] as FakeField[],
    appendChild(field: FakeField) { body.children.push(field); return field; },
  };
  let copied: string | undefined;
  const document = {
    body,
    createElement(): FakeField {
      const field: FakeField = {
        value: '', attributes: {}, style: { cssText: '' }, focused: false, selection: undefined, removed: false,
        setAttribute(name: string, value: string) { field.attributes[name] = value; },
        focus() { field.focused = true; },
        setSelectionRange(start: number, end: number) { field.selection = [start, end]; },
        remove() { field.removed = true; body.children = body.children.filter(item => item !== field); },
      };
      created.push(field);
      return field;
    },
    getSelection: () => null,
    execCommand(command: string) {
      const field = created.at(-1)!;
      // The real command copies whatever is selected, which is why a field that
      // was never selected must not count as a success.
      if (command !== 'copy' || !field.focused || !field.selection) return false;
      const allowed = options.copyCommand ? options.copyCommand(field) : true;
      if (allowed) copied = field.value;
      return allowed;
    },
  };
  return { document, created, copied: () => copied, attached: () => body.children.length };
}

/**
 * Swap in fake globals for one call. `defineProperty` rather than assignment:
 * Node's own `globalThis.navigator` is an accessor with no setter, so plain
 * assignment throws before the code under test ever runs.
 */
function withGlobals<T>(patch: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(patch).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[key];
    }
  };
  return run().finally(restore);
}

test('the async clipboard is used when the host allows it', async () => {
  const written: string[] = [];
  const dom = fakeDom();
  const result = await withGlobals(
    { navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } }, document: dom.document },
    () => copyText('https://cartula.test/map/m1#preview=cpt_1'),
  );
  assert.equal(result, 'clipboard');
  assert.deepEqual(written, ['https://cartula.test/map/m1#preview=cpt_1']);
  assert.equal(dom.created.length, 0, 'the fallback does not run when the first route worked');
});

test('a host that refuses the clipboard permission still copies through the selection', async () => {
  const dom = fakeDom();
  const refused = { clipboard: { writeText: async () => { throw Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }); } } };
  const result = await withGlobals({ navigator: refused, document: dom.document }, () => copyText('分享链接'));
  assert.equal(result, 'selection');
  assert.equal(dom.copied(), '分享链接');
  const field = dom.created.at(-1)!;
  assert.equal(field.attributes.readonly, '');
  assert.equal(field.attributes['aria-hidden'], 'true');
  // Hidden by opacity rather than display/visibility: an unrendered field
  // cannot be selected, and the copy would silently do nothing.
  assert.ok(!/display\s*:\s*none|visibility\s*:\s*hidden/.test(field.style.cssText));
  assert.equal(field.removed, true, 'the scratch field never outlives the copy');
  assert.equal(dom.attached(), 0);
});

test('a webview without the clipboard API at all falls straight through', async () => {
  const dom = fakeDom();
  const result = await withGlobals({ navigator: {}, document: dom.document }, () => copyText('分享给 Agent'));
  assert.equal(result, 'selection');
  assert.equal(dom.copied(), '分享给 Agent');
});

test('when neither route works the answer is unavailable, not a rejection', async () => {
  const dom = fakeDom({ copyCommand: () => false });
  const refused = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  const result = await withGlobals({ navigator: refused, document: dom.document }, () => copyText('分享链接'));
  assert.equal(result, 'unavailable');
  assert.equal(dom.copied(), undefined);
  assert.equal(dom.created.at(-1)!.removed, true, 'a failed copy cleans up after itself too');

  // A command that throws is the same outcome as one that returns false.
  const throwing = fakeDom({ copyCommand: () => { throw new Error('unsupported'); } });
  assert.equal(await withGlobals({ navigator: refused, document: throwing.document }, () => copyText('x')), 'unavailable');
  assert.equal(throwing.created.at(-1)!.removed, true);
});

test('selectAll selects the whole value so the reader only has to press the shortcut', () => {
  const field = { value: '分享链接', focused: false, selection: undefined as [number, number] | undefined,
    focus() { field.focused = true; }, setSelectionRange(start: number, end: number) { field.selection = [start, end]; } };
  selectAll(field as unknown as HTMLInputElement);
  assert.equal(field.focused, true);
  assert.deepEqual(field.selection, [0, 4]);
  // Nothing on screen to select is not a crash.
  selectAll(null);
});
