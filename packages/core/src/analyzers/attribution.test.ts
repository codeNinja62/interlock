import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { SEMANTIC } from '../../../../eval/fixtures/semantic.js';
import {
  ATTRIBUTION_RULES,
  UNATTRIBUTED_RATIONALES,
  UNATTRIBUTED_REASONS,
  arityOf,
  decide,
  hunkAddsNew,
  hunkTouchesOld,
  mapLine,
  mapRange,
  moduleCandidates,
  recognise,
  ruleFor,
} from './attribution.js';
import type { SideFacts } from './attribution.js';

describe('recognise', () => {
  it.each([
    [2304, 'name', 'local'],
    [2552, 'name', 'local'],
    [2339, 'name', 'property'],
    [2551, 'name', 'property'],
    [2305, 'name', 'import'],
    [2614, 'name', 'import'],
    [2724, 'name', 'import'],
    [2554, 'arity', null],
    [2555, 'arity', null],
  ])('reads TS%i as a %s that is looked for as %s', (code, family, shape) => {
    expect(recognise(code)).toEqual({ family, shape });
  });

  it.each([2307, 2322, 2345, 1005, 0])('does not read TS%i', (code) => {
    expect(recognise(code)).toBeNull();
  });
});

describe('rules', () => {
  it('are the names the evaluation suite labels typecheck conflicts with', () => {
    const labelled = new Set(
      SEMANTIC.flatMap((fixture) =>
        fixture.expected
          .filter((label) => label.analyzer === 'typecheck')
          .map((label) => label.class),
      ),
    );
    expect(
      new Set([
        ATTRIBUTION_RULES.rename,
        ATTRIBUTION_RULES.signature,
        ATTRIBUTION_RULES.movedExport,
      ]),
    ).toEqual(labelled);
  });

  it('are never a compiler code', () => {
    for (const rule of Object.values(ATTRIBUTION_RULES)) {
      expect(rule).toMatch(/^[a-z]+(?:-[a-z]+)+$/u);
      expect(rule).not.toMatch(/ts\d/iu);
    }
  });

  it.each([
    ['renamed', 'rename-vs-callsite'],
    ['moved', 'moved-export-vs-import'],
    ['signature-changed', 'signature-vs-caller'],
    ['removed', 'merge-breaks-typecheck'],
  ] as const)('name a declaration %s as %s', (change, rule) => {
    expect(ruleFor(change)).toBe(rule);
  });

  it('give every reason a rationale of its own', () => {
    const rationales = UNATTRIBUTED_REASONS.map((reason) => UNATTRIBUTED_RATIONALES[reason]);
    expect(rationales.every((text) => text.length > 0)).toBe(true);
    expect(new Set(rationales).size).toBe(UNATTRIBUTED_REASONS.length);
  });
});

describe('hunkTouchesOld', () => {
  // A declaration on lines 3–5.
  it.each([
    ['a line before it', { oldStart: 2, oldLines: 1 }, false],
    ['its first line', { oldStart: 3, oldLines: 1 }, true],
    ['its last line', { oldStart: 5, oldLines: 1 }, true],
    ['the line after it', { oldStart: 6, oldLines: 1 }, false],
    ['lines running into it', { oldStart: 1, oldLines: 3 }, true],
    ['lines running out of it', { oldStart: 5, oldLines: 4 }, true],
    ['an insertion before its first line', { oldStart: 2, oldLines: 0 }, false],
    ['an insertion after its first line', { oldStart: 3, oldLines: 0 }, true],
    ['an insertion after its second line', { oldStart: 4, oldLines: 0 }, true],
    ['an insertion after its last line', { oldStart: 5, oldLines: 0 }, false],
    ['an insertion at the top of the file', { oldStart: 0, oldLines: 0 }, false],
  ])('%s: %s', (_, old, touches) => {
    expect(hunkTouchesOld({ ...old, newStart: 1, newLines: 1 }, 3, 5)).toBe(touches);
  });
});

describe('hunkAddsNew', () => {
  const hunk = { oldStart: 3, oldLines: 0, newStart: 4, newLines: 3 };
  it.each([
    [3, false],
    [4, true],
    [6, true],
    [7, false],
  ])('line %i: %s', (line, adds) => {
    expect(hunkAddsNew(hunk, line)).toBe(adds);
  });

  it('adds nothing for a deletion', () => {
    expect(hunkAddsNew({ oldStart: 4, oldLines: 2, newStart: 3, newLines: 0 }, 3)).toBe(false);
  });
});

describe('mapLine', () => {
  const file = ['a', 'b', 'c', 'd', 'e'];

  it('maps a line of an identical file to itself', () => {
    expect(mapLine(file, file, 3)).toEqual({ kind: 'exact', line: 3 });
  });

  it('follows lines inserted above', () => {
    expect(mapLine(file, ['x', 'y', ...file], 3)).toEqual({ kind: 'exact', line: 5 });
  });

  it('follows lines removed above', () => {
    expect(mapLine(file, ['a', 'c', 'd', 'e'], 4)).toEqual({ kind: 'exact', line: 3 });
  });

  it('places a changed line between its neighbours', () => {
    expect(mapLine(file, ['a', 'b', 'C', 'd', 'e'], 3)).toEqual({
      kind: 'between',
      from: 3,
      to: 3,
    });
  });

  it('places a line the other file lacks in an empty gap', () => {
    expect(mapLine(file, ['a', 'b', 'd', 'e'], 3)).toEqual({ kind: 'between', from: 3, to: 2 });
  });

  it('bounds a gap at the start and the end of the file', () => {
    expect(mapLine(file, ['A', 'b', 'c', 'd', 'e'], 1)).toEqual({
      kind: 'between',
      from: 1,
      to: 1,
    });
    expect(mapLine(file, ['a', 'b', 'c', 'd', 'E'], 5)).toEqual({
      kind: 'between',
      from: 5,
      to: 5,
    });
  });

  it('gives up on files too far apart to align', () => {
    const far = Array.from({ length: 1200 }, (_, index) => `line ${String(index)}`);
    expect(mapLine(file, [...far, ...file.slice(1)], 1)).toBeNull();
  });
});

describe('mapRange', () => {
  const base = ['// head', 'function a() {', '  return 1;', '}', '', 'function b() {}'];

  it('covers a range whose first line changed', () => {
    const renamed = ['// head', 'function z() {', '  return 1;', '}', '', 'function b() {}'];
    expect(mapRange(base, renamed, 2, 4)).toEqual({ from: 2, to: 4 });
  });

  it('follows the range past inserted lines', () => {
    const shifted = ['// new', '// new', ...base];
    expect(mapRange(base, shifted, 2, 4)).toEqual({ from: 4, to: 6 });
  });

  it('is empty where the range was removed', () => {
    const removed = ['// head', '', 'function b() {}'];
    expect(mapRange(base, removed, 2, 4)).toEqual({ from: 2, to: 1 });
  });

  it('gives up on files too far apart to align', () => {
    const far = Array.from({ length: 1200 }, (_, index) => `line ${String(index)}`);
    expect(mapRange(base, far, 2, 4)).toBeNull();
  });
});

describe('moduleCandidates', () => {
  it('tries the source extensions, then an index', () => {
    expect(moduleCandidates('src/support.ts', './payments')).toEqual([
      'src/payments.ts',
      'src/payments.tsx',
      'src/payments.d.ts',
      'src/payments.js',
      'src/payments.jsx',
      'src/payments/index.ts',
      'src/payments/index.tsx',
      'src/payments/index.d.ts',
      'src/payments/index.js',
    ]);
  });

  it('reads an emitted name as the source beside it first', () => {
    expect(moduleCandidates('src/support.ts', './payments.js')).toEqual([
      'src/payments.ts',
      'src/payments.tsx',
      'src/payments.d.ts',
      'src/payments.js',
    ]);
    expect(moduleCandidates('src/a.ts', './b.mjs')).toEqual([
      'src/b.mts',
      'src/b.d.mts',
      'src/b.mjs',
    ]);
    expect(moduleCandidates('src/a.ts', './b.cjs')).toEqual([
      'src/b.cts',
      'src/b.d.cts',
      'src/b.cjs',
    ]);
    expect(moduleCandidates('src/a.tsx', './b.jsx')).toEqual(['src/b.tsx', 'src/b.jsx']);
  });

  it('takes a source extension as written', () => {
    expect(moduleCandidates('src/a/b.ts', '../lib/x.ts')).toEqual(['src/lib/x.ts']);
  });

  it('resolves nothing bare, and nothing outside the tree', () => {
    expect(moduleCandidates('src/a.ts', 'lodash')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '@/payments')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '#payments')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '../../x')).toEqual([]);
    expect(moduleCandidates('a.ts', '..')).toEqual([]);
  });
});

describe('arityOf', () => {
  const first = (source: string): ts.Node => {
    const file = ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
    const statement = file.statements[0]!;
    return ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]!
      : ts.isClassDeclaration(statement)
        ? statement.members[0]!
        : statement;
  };

  it.each([
    ['function f(a: number, b: string) {}', { min: 2, max: 2 }],
    ['function f(a: number, b?: string) {}', { min: 1, max: 2 }],
    ['function f(a: number, b = "x") {}', { min: 1, max: 2 }],
    ['function f(a = 1, b: string) {}', { min: 2, max: 2 }],
    ['function f(this: Window, a: number) {}', { min: 1, max: 1 }],
    ['function f(a: number, ...rest: string[]) {}', { min: 1, max: null }],
    ['function f() {}', { min: 0, max: 0 }],
    ['const f = (a: number) => a;', { min: 1, max: 1 }],
    ['const f = function (a: number, b?: number) { return a; };', { min: 1, max: 2 }],
    ['class C { m(a: number, b: number) {} }', { min: 2, max: 2 }],
    ['class C { m = (a: number) => a; }', { min: 1, max: 1 }],
  ])('%s takes %o', (source, arity) => {
    expect(arityOf(ts, first(source))).toEqual(arity);
  });

  it.each(['const x = 1;', 'class C { x = 1; }', 'interface I { x: number }'])(
    'reads %s as no function',
    (source) => {
      expect(arityOf(ts, first(source))).toBeNull();
    },
  );
});

describe('decide', () => {
  /** Branch `a` renamed the declaration; branch `b` added the call. */
  const declaring: SideFacts = { touches: true, change: 'renamed', adds: 'no', holds: false };
  const referencing: SideFacts = { touches: false, change: null, adds: 'yes', holds: true };

  it('names the branch that changed the declaration, whichever side it is', () => {
    expect(decide(declaring, referencing)).toEqual({
      kind: 'attributed',
      origin: 'a',
      referencing: 'b',
      change: 'renamed',
    });
    expect(decide(referencing, declaring)).toEqual({
      kind: 'attributed',
      origin: 'b',
      referencing: 'a',
      change: 'renamed',
    });
  });

  it.each([
    [
      'the reference was in the base',
      { ...declaring, adds: 'no', holds: true },
      { ...referencing, adds: 'no', holds: true },
      'reference-in-base',
    ],
    [
      'both changed the declaration',
      declaring,
      { ...referencing, touches: true },
      'both-changed-declaration',
    ],
    [
      'neither changed it',
      { ...declaring, touches: false },
      referencing,
      'neither-changed-declaration',
    ],
    [
      'its change does not explain it',
      { ...declaring, change: null },
      referencing,
      'change-does-not-explain',
    ],
    [
      "the reference's side is unsure",
      declaring,
      { ...referencing, adds: 'unsure' },
      'mapping-unsure',
    ],
    [
      "the declaring side's is unsure",
      { ...declaring, adds: 'unsure' },
      referencing,
      'mapping-unsure',
    ],
    [
      'both added the reference',
      { ...declaring, adds: 'yes', holds: true },
      referencing,
      'both-hold-reference',
    ],
    ['neither added it', declaring, { ...referencing, adds: 'no' }, 'neither-holds-reference'],
    [
      'the declaring branch added it too',
      { ...declaring, adds: 'yes', holds: true },
      { ...referencing, adds: 'no', holds: false },
      'same-branch',
    ],
  ] as const)('names no branch when %s', (_, a, b, reason) => {
    expect(decide(a, b)).toEqual({ kind: 'unattributed', reason });
  });

  it('asks about the declaration before the reference, and the base before both', () => {
    // Every reason holds at once, each pair of them in turn: the earlier one wins.
    expect(
      decide(
        { touches: true, change: 'renamed', adds: 'no', holds: true },
        { touches: true, change: 'renamed', adds: 'no', holds: true },
      ),
    ).toEqual({ kind: 'unattributed', reason: 'reference-in-base' });
    expect(
      decide(
        { touches: true, change: 'renamed', adds: 'yes', holds: true },
        { touches: true, change: null, adds: 'yes', holds: true },
      ),
    ).toEqual({ kind: 'unattributed', reason: 'both-changed-declaration' });
    expect(
      decide({ ...declaring, change: null, adds: 'unsure' }, { ...referencing, adds: 'unsure' }),
    ).toEqual({ kind: 'unattributed', reason: 'change-does-not-explain' });
    expect(decide({ ...declaring, adds: 'unsure' }, { ...referencing, adds: 'yes' })).toEqual({
      kind: 'unattributed',
      reason: 'mapping-unsure',
    });
  });
});

describe('importing @interlock/core', () => {
  it('does not load the compiler, which only attribution and a type-check worker use', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('typescript was loaded by importing @interlock/core');
    });
    try {
      await expect(import('../index.js')).resolves.toBeDefined();
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});
