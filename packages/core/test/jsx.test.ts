/**
 * JSX.
 *
 * Regression for a gap found by pointing the analyzer at a TSX repository: 25 of
 * 686 files lost their imports, and none of them reported a diagnostic.
 *
 * The cause was that JSX was never lexed. A `<` was either a bracket or a type
 * argument, and in `<Trigger onClick={(e) => f(e)} />` the braces are attributes,
 * not a block, while `/>` does not close a type argument list. Counting them
 * skewed the depth balance of every statement scanner, which ran to the end of
 * the file and dropped the statements after it.
 *
 * A JSX element is now skipped as a single token, the same way a template
 * literal is, so the balance never sees its interior. Deciding that a `<` opens
 * an element rather than type arguments uses the position: after an identifier
 * or a closing bracket it is type arguments, in expression position it is an
 * element. "Expression position" turned out to be three tokens narrower than
 * expected — `=>`, `&&`, `||` and `??` were all missing from it, and each one
 * costs a file that returns an element or renders a conditional child.
 *
 * As with the template-literal defects, an import written above the construct
 * parses either way. Every case below writes it after, which is the only
 * position that fails when the scanner loses its place.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { runPipeline } from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const PROBE = 'src/probe.tsx';
const MARKER = './zz-marker.js';
const HEAD = "import * as React from 'react';\n";

/** Reports whether an import written after `body` was recorded. */
async function keeps(body: string): Promise<boolean> {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  const { writeFileSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  rmSync(path.join(root, 'src', 'probe.ts'), { force: true });
  writeFileSync(path.join(root, 'src', 'zz-marker.ts'), 'export const marker = 1;\n');
  writeFileSync(path.join(root, PROBE), `${HEAD}${body}\nimport {marker} from '${MARKER}';\n`);

  const result = await runPipeline({ root, dryRun: true, force: true });
  const specifiers = (result.parsed.get(PROBE)?.imports ?? []).map((record) => record.specifier);
  return specifiers.includes(MARKER);
}

describe('jsx', () => {
  test('elements and attributes', async () => {
    for (const statement of [
      'const v = <div className="a" />;',
      'const v = <A.B><C.D>x</C.D></A.B>;',
      'const v = <C {...props} />;',
      'const v = <C title={`a-${b}`} />;',
      'const v = <C onClick={(e) => f(e)} />;',
      'const v = <C onClick={(e) => { f(e); }} />;',
      'const v = <div>{a ? <A /> : <B />}</div>;',
      'const v = <div>{/* a comment child */}</div>;',
      'const v = <div>{text}</div>;',
      'class A extends React.Component { render() { return <div />; } }',
    ]) {
      assert.ok(await keeps(statement), `${statement} lost the trailing import`);
    }
  });

  test('fragments, including self-closing children', async () => {
    // A fragment has no tag name, so what follows `<>` is children. Treating
    // that region as attributes consumed the first child and, when it was
    // self-closing, ended the fragment one element too early.
    for (const statement of [
      'const v = <><A /><B /></>;',
      'const v = <>{items.map((item) => <Row key={item.id} {...item} />)}</>;',
      'const v = <><A.B><C.D /></A.B><E /></>;',
      'const v = (\n  <>\n    <A />\n    <B />\n  </>\n);',
    ]) {
      assert.ok(await keeps(statement), `${statement} lost the trailing import`);
    }
  });

  test('elements returned from an arrow function', async () => {
    // `=>` is an expression position, which the set of them did not include.
    for (const statement of [
      'const v = React.forwardRef<A>((p) => <div ref={p.r} />);',
      'const render = () => <div />;',
      'const render = async () => <div>{await f()}</div>;',
    ]) {
      assert.ok(await keeps(statement), `${statement} lost the trailing import`);
    }
  });

  test('conditional and logical children', async () => {
    // Same gap: `&&`, `||` and `??` are tokenized as single two-character
    // punctuators, and the set is matched against token values.
    for (const statement of [
      'const v = <div>{ok && <Error />}</div>;',
      'const v = <div>{a || <B />}</div>;',
      'const v = <div>{a ?? <C />}</div>;',
      'const v = <div>{ok && <A.B>{x}</A.B>}</div>;',
    ]) {
      assert.ok(await keeps(statement), `${statement} lost the trailing import`);
    }
  });

  test('type arguments are still type arguments', async () => {
    // The discriminator is position, and these are the cases that would break if
    // it were loosened: `<` after an identifier or a closing bracket.
    for (const statement of [
      'const v = React.useState<HTMLElement>();',
      'const v = React.forwardRef<A, B>(function C() { return null; });',
      'const v = a < b > c;',
      'const v = new Map<string, Set<number>>();',
      'const v = f<A>();',
    ]) {
      assert.ok(await keeps(statement), `${statement} lost the trailing import`);
    }
  });

  test('a type argument list spanning lines still closes', async () => {
    assert.ok(
      await keeps('const v = React.forwardRef<\n  AElement,\n  AProps\n>(\n  function A() { return null; }\n);'),
    );
  });

  test('an unbalanced angle bracket in a type still parses', async () => {
    // A `a < b` comparison is not an element; the shape check declines it.
    assert.ok(await keeps('const v = count < limit ? "few" : "many";'));
  });
});