/**
 * `require()` and dynamic `import()`, wherever they are written.
 *
 * The statement scanners skip what they do not need to read: the initializer of
 * a declaration, the body of a function, of a class or of an arrow. Those are
 * where nearly every module load lives — `const fs = require('node:fs')` at the
 * top of a CommonJS file, `() => import('./page')` for a lazy route — and the
 * scan that only looked at the tokens the statement scanners visit saw almost
 * none of them. Measured before the fix: 2 of the 410 `require()` calls in
 * `express`, 21 of the 89 dynamic `import()` calls in `@nestjs/nest`.
 *
 * Nothing reported it. An import the analyzer never records cannot be
 * unresolved, so the resolution rate stayed at 100%.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext, extractModuleFacts } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** The specifiers of the `require` / dynamic `import` records of a source text. */
const loads = (source: string): Array<[string, string, number]> =>
  extractModuleFacts(source)
    .imports.filter((record) => record.syntax === 'require' || record.syntax === 'dynamic')
    .map((record) => [record.syntax, record.specifier, record.line]);

const CASES: Record<string, string> = {
  'at the top of a CommonJS file': "const fs = require('node:fs');\nconst helpers = require('./helpers');\nmodule.exports = { helpers };\n",
  'in a destructuring declaration': "const { join } = require('node:path');\nconst [first] = require('./list');\nmodule.exports.first = first;\n",
  'in a let or var declaration': "let config = require('../config');\nvar path = require('node:path');\nmodule.exports = { config, path };\n",
  'in a ternary': "const impl = process.env.NODE_ENV === 'test' ? require('./fake') : require('./real');\nmodule.exports.impl = impl;\n",
  'in a function body': "function load() {\n  const fs = require('node:fs');\n  return fs;\n}\nmodule.exports.load = load;\n",
  'in a class method': "class Loader {\n  load() {\n    return require('./mod');\n  }\n}\nmodule.exports.Loader = Loader;\n",
  'in an object literal': "module.exports = {\n  load: () => require('./mod'),\n};\n",
  'in a declaration with a call on the result': "const routes = require('express').Router();\nmodule.exports.routes = routes;\n",
};

describe('require()', () => {
  for (const [label, source] of Object.entries(CASES)) {
    test(`is recorded ${label}`, () => {
      const facts = extractModuleFacts(source);
      assert.equal(facts.parseStatus, 'ok');
      const specifiers = facts.imports.filter((record) => record.syntax === 'require').map((record) => record.specifier);
      const expected = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]!);
      assert.deepEqual(specifiers, expected, 'every require() call of the source, in order');
    });
  }

  test('a require() is a dependency of the graph', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    for (const file of ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
      deleteRepoFile(root, file);
    }
    writeRepoFile(root, 'src/consumer/a.ts', "const { helper } = require('../dep/b');\nmodule.exports = { helper };\n");
    writeRepoFile(root, 'src/dep/b.ts', 'exports.helper = () => 1;\n');
    const repository = await (await AgentContext.load({ root })).getRepository();
    assert.deepEqual(repository.files.find((file) => file.path === 'src/consumer/a.ts')?.importSpecifiers, ['../dep/b']);
  });
});

describe('dynamic import()', () => {
  const DYNAMIC: Record<string, string> = {
    'in a declaration at the top level': "const m = import('./top');\nexport default m;\n",
    'in a function body': "export async function load() {\n  const m = await import('./lazy');\n  return m;\n}\n",
    'as an arrow body': "export const load = () => import('./lazy');\n",
    'in a class method': "export class Service {\n  async init() {\n    return import('./mod');\n  }\n}\n",
    'in a callback': "useEffect(() => {\n  import('./effect');\n});\n",
    'in a condition': "if (enabled) {\n  import('./cond');\n}\n",
  };

  for (const [label, source] of Object.entries(DYNAMIC)) {
    test(`is recorded ${label}`, () => {
      const facts = extractModuleFacts(source);
      assert.equal(facts.parseStatus, 'ok');
      assert.deepEqual(
        facts.imports.filter((record) => record.syntax === 'dynamic').map((record) => record.specifier),
        [...source.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1]!),
      );
    });
  }
});

describe('what is not a module load', () => {
  test('a method named require or import on an object', () => {
    assert.deepEqual(loads("const schema = config.require('./schema');\nconst page = loader.import('./page');\nexport { schema, page };\n"), []);
  });

  test('a call whose specifier is not a literal', () => {
    assert.deepEqual(loads("const a = require(name);\nconst b = import(`./${part}`);\nexport { a, b };\n"), []);
  });

  test('a require() in a comment or a string', () => {
    assert.deepEqual(loads("// const a = require('./commented');\nconst text = \"require('./in-a-string')\";\nexport { text };\n"), []);
  });
});

describe('the module-load scan does not disturb the rest', () => {
  test('a load is recorded once, with its line, and the statements after it are kept', () => {
    const facts = extractModuleFacts("const fs = require('node:fs');\nimport { join } from 'node:path';\nexport const later = join;\n");
    assert.deepEqual(
      facts.imports.map((record) => [record.syntax, record.specifier, record.line]),
      [
        ['require', 'node:fs', 1],
        ['static', 'node:path', 2],
      ],
    );
    assert.deepEqual(facts.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name), ['later']);
    assert.equal(facts.parseStatus, 'ok');
  });

  test('a bare require() statement is not recorded twice', () => {
    assert.deepEqual(loads("require('./side-effect');\nmodule.exports = {};\n"), [['require', './side-effect', 1]]);
  });
});

describe('type-only star re-exports', () => {
  test('export type * from is a re-export, not a declaration', () => {
    const facts = extractModuleFacts(
      "export type * from './types';\nexport type * as ns from './namespace';\n",
    );
    assert.equal(facts.parseStatus, 'ok');
    assert.deepEqual(
      facts.imports.map((record) => [record.specifier, record.syntax, record.typeOnly]),
      [
        ['./types', 'reexport', true],
        ['./namespace', 'reexport', true],
      ],
    );
    assert.ok(facts.exports.some((entry) => entry.name === '*' && entry.fromSpecifier === './types' && entry.typeOnly));
    assert.ok(facts.exports.some((entry) => entry.name === 'ns' && entry.fromSpecifier === './namespace' && entry.typeOnly));
  });

  test('export * from stays a value re-export', () => {
    const facts = extractModuleFacts("export * from './values';\n");
    assert.deepEqual(
      facts.imports.map((record) => [record.specifier, record.syntax, record.typeOnly]),
      [['./values', 'reexport', false]],
    );
  });
});
