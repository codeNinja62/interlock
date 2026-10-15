import { isInterlockError, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  Finding,
  ProcessOutputEvidence,
  SpanEvidence,
  SpeculativeRunId,
  SymbolTrailStep,
} from '@interlock/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEMANTIC } from '../../../eval/fixtures/semantic.js';
import { matches } from '../../../eval/fixtures/score.js';
import {
  ATTRIBUTION_RULES,
  MAX_PARSED_BYTES,
  MAX_SCANNED_FILES,
  TSC_ERROR_EXIT,
  UNATTRIBUTED_CONFIDENCE,
  UNATTRIBUTED_RATIONALES,
  attributeDiagnostics,
} from '../src/analyzers/attribution.js';
import type { UnattributedReason } from '../src/analyzers/attribution.js';
import { createTypecheckRegistry } from '../src/analyzers/typecheck.js';
import type { FileDiagnostic, TypecheckRegistry } from '../src/analyzers/typecheck.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  MAX_FINDINGS_PER_RUN,
} from '../src/merge/conflict-classifier.js';
import {
  CHECKOUT,
  NO_CHANGE,
  PAYMENTS,
  PROJECT,
  SEMANTIC_CASES,
  attributionFixtures,
  lines,
} from './support/attribution-fixtures.js';
import type { AttributionFixtures, BranchSpec, Pair } from './support/attribution-fixtures.js';

/**
 * Attribution against real pairs: repositories built in temporary directories,
 * merged in their shadows, each side's ChangeSet extracted as the watcher
 * extracts it, and — wherever the compiler can produce one — the diagnostic
 * the type-check service reports for the merged slot.
 */

let registry: TypecheckRegistry;
let fixtures: AttributionFixtures;

beforeAll(() => {
  registry = createTypecheckRegistry();
});
afterAll(async () => {
  await registry.close();
});
beforeEach(() => {
  fixtures = attributionFixtures();
});
afterEach(() => {
  fixtures.dispose();
});

/** Repository content that must never reach a field the CLI prints unwrapped. */
const NAMES = ['processRefund', 'refundPayment', 'formatPrice', 'slugify', 'Ledger', 'src/'];

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  for (const field of [finding!.title, finding!.description, finding!.attribution.rationale]) {
    for (const name of NAMES) expect(field).not.toContain(name);
  }
  return finding!;
}

function spans(
  finding: Finding,
  branch: BranchRefId,
): Pick<SpanEvidence, 'path' | 'startLine' | 'endLine'>[] {
  return finding.evidence
    .filter((item): item is SpanEvidence => item.type === 'span' && item.branchRefId === branch)
    .map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
}

function trail(finding: Finding): readonly SymbolTrailStep[] {
  const evidence = finding.evidence.find((item) => item.type === 'symbol-trail');
  return evidence?.type === 'symbol-trail' ? evidence.steps : [];
}

function toolOutput(finding: Finding): ProcessOutputEvidence {
  const evidence = finding.evidence.find((item) => item.type === 'process-output');
  if (evidence?.type !== 'process-output') throw new Error('no process output');
  return evidence;
}

function expectUnattributed(finding: Finding, reason: UnattributedReason): void {
  expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
  expect(finding.attribution.originBranch).toBeNull();
  expect(finding.confidence).toBe(UNATTRIBUTED_CONFIDENCE);
  expect(finding.attribution.rationale).toBe(UNATTRIBUTED_RATIONALES[reason]);
  // Never nothing: the compiler's output is evidence however little else is known.
  expect(toolOutput(finding).exitCode).toBe(TSC_ERROR_EXIT);
}

/** The eval rename case, which most of the cases here vary. */
const rename = SEMANTIC_CASES.find((each) => each.id === 'rename-vs-callsite')!;

/** `src/support.ts` calling `processRefund` through a named import, as the eval case adds it. */
const SUPPORT = lines(
  'import { processRefund } from "./payments";',
  '',
  'export function escalate(orderId: string): string {',
  '  return processRefund(orderId);',
  '}',
);

const write = (path: string, content: string): BranchSpec['committed'][number] => ({
  op: 'write',
  path,
  content,
});
const committed = (...operations: BranchSpec['committed']): BranchSpec => ({
  committed: operations,
  uncommitted: [],
});

async function checkedPair(
  base: Record<string, string>,
  a: BranchSpec,
  b: BranchSpec,
): Promise<Pair> {
  return fixtures.pair(base, a, b, { registry });
}

describe("the evaluation suite's typecheck cases", () => {
  it('are mirrored here exactly as the read-only suite has them', () => {
    for (const mirrored of SEMANTIC_CASES) {
      const original = SEMANTIC.find((fixture) => fixture.id === mirrored.id);
      expect(original, mirrored.id).toBeDefined();
      expect(mirrored).toEqual({
        id: original!.id,
        base: original!.base,
        a: original!.a,
        b: original!.b,
        expected: original!.expected,
        twinOf: original!.twinOf,
      });
    }
    const typecheckCases = SEMANTIC.filter(
      (fixture) =>
        fixture.expected.some((label) => label.analyzer === 'typecheck') ||
        SEMANTIC.find((other) => other.id === fixture.twinOf)?.expected.some(
          (label) => label.analyzer === 'typecheck',
        ),
    );
    expect(SEMANTIC_CASES.map((each) => each.id).sort()).toEqual(
      typecheckCases.map((fixture) => fixture.id).sort(),
    );
  });

  const actions: Readonly<Record<string, SymbolTrailStep['action']>> = {
    'rename-vs-callsite': 'renamed',
    'signature-vs-caller': 'signature-changed',
    'moved-export-vs-import': 'moved',
  };

  for (const fixture of SEMANTIC_CASES.filter((each) => each.twinOf === null)) {
    it(`attributes ${fixture.id} as its label says`, async () => {
      const pair = await checkedPair(fixture.base, fixture.a, fixture.b);
      expect(pair.diagnostics).toHaveLength(1);
      const { findings, dropped } = await pair.attribute();
      expect(dropped).toBe(0);
      const finding = only(findings);
      const label = fixture.expected[0]!;

      expect(finding.kind).toBe('typecheck');
      expect(finding.rule).toBe(label.class);
      expect(finding.severity).toBe('high');
      expect(finding.confidence).toBe(1);
      expect(finding.attribution.originBranch).toBe(pair.branchA);
      expect(spans(finding, pair.branchA)).toEqual([
        { path: label.spanA!.path, startLine: label.spanA!.start, endLine: label.spanA!.end },
      ]);
      expect(spans(finding, pair.branchB)).toEqual([
        { path: label.spanB!.path, startLine: label.spanB!.start, endLine: label.spanB!.end },
      ]);
      expect(
        trail(finding).map(({ branchRefId, symbol, action }) => ({ branchRefId, symbol, action })),
      ).toEqual([
        { branchRefId: pair.branchA, symbol: label.symbol, action: actions[label.class] },
        { branchRefId: pair.branchB, symbol: label.symbol, action: 'referenced' },
      ]);
      const output = toolOutput(finding);
      expect(output.exitCode).toBe(TSC_ERROR_EXIT);
      expect(output.locations).toEqual([
        { path: label.path, line: pair.diagnostics[0]!.line, column: pair.diagnostics[0]!.column },
      ]);
      expect(output.output).toContain(`TS${String(pair.diagnostics[0]!.code)}`);
      // The suite's own matching rule, read from it rather than restated.
      expect(matches(label, finding, { a: pair.branchA, b: pair.branchB })).toBe(true);
    });
  }

  for (const twin of SEMANTIC_CASES.filter((each) => each.twinOf !== null)) {
    it(`is never asked about ${twin.id}: the merged tree compiles`, async () => {
      const pair = await checkedPair(twin.base, twin.a, twin.b);
      expect(pair.diagnostics).toEqual([]);
      expect((await pair.attribute()).findings).toEqual([]);
    });
  }
});

describe("each branch's own lines", () => {
  /** A ledger long enough that git still calls it renamed after one line changes. */
  const LEDGER = lines(
    'export function processRefund(orderId: string): string {',
    '  return `refund:${orderId}`;',
    '}',
    '',
    'export function chargeCard(orderId: string, cents: number): string {',
    '  return `charge:${orderId}:${String(cents)}`;',
    '}',
    '',
    'export function voidCharge(orderId: string): string {',
    '  return `void:${orderId}`;',
    '}',
    '',
    'export function settleBatch(batchId: string): string {',
    '  return `settle:${batchId}`;',
    '}',
  );
  const ESCALATE = lines(
    '',
    'export function escalate(orderId: string): string {',
    '  return processRefund(orderId);',
    '}',
  );
  const HEADER = '// Refunds go through the provider.\n// Amounts are in cents.\n';

  it('places a reference in a file both branches edited in the referencing branch', async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS },
      committed(
        write('src/payments.ts', HEADER + PAYMENTS.replace('processRefund', 'refundPayment')),
      ),
      committed(write('src/payments.ts', PAYMENTS + ESCALATE)),
    );
    const [diagnostic] = pair.diagnostics;
    expect(pair.diagnostics).toHaveLength(1);
    // Merged, the call sits under both the header and the call's own lines.
    expect(diagnostic!.line).toBe(8);

    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 3, endLine: 3 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 6, endLine: 6 },
    ]);
    expect(trail(finding).map((step) => step.location)).toEqual([
      { path: 'src/payments.ts', line: 3, column: 17 },
      { path: 'src/payments.ts', line: 6, column: null },
    ]);
  });

  it("names the referencing branch's own path when the declaring branch renamed the file", async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': LEDGER },
      {
        committed: [
          { op: 'rename', from: 'src/payments.ts', to: 'src/billing.ts' },
          write('src/billing.ts', HEADER + LEDGER.replace('processRefund', 'refundPayment')),
        ],
        uncommitted: [],
      },
      committed(write('src/payments.ts', LEDGER + ESCALATE)),
    );
    expect(pair.changeSetA.files).toContainEqual(
      expect.objectContaining({
        kind: 'renamed',
        path: 'src/billing.ts',
        previousPath: 'src/payments.ts',
      }),
    );
    const [diagnostic] = pair.diagnostics;
    expect(pair.diagnostics).toHaveLength(1);
    expect(diagnostic!.file).toBe('src/billing.ts');
    expect(diagnostic!.line).toBe(20);

    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/billing.ts', startLine: 3, endLine: 3 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 18, endLine: 18 },
    ]);
  });

  it('reads a ChangeSet against its own base when that is not the pair merge base', async () => {
    // The default branch puts five lines above the declaration after `a`
    // forks, and `b` forks from there and edits one of them. In `b`'s base the
    // declaration sits at lines 9–11 and `b`'s hunk at line 4; read in the
    // pair base's lines, 4–6, the hunk would cross it and both branches would
    // seem to have changed it.
    const prefix = lines('// Payments.', '', '');
    const owned = lines('// Owned by billing.', '// -', '// -', '// -', '// -');
    const reviewed = lines('// Owned by billing.', '// -', '// -', '// reviewed', '// -');
    const pair = await fixtures.pair(
      { ...PROJECT, 'src/payments.ts': prefix + PAYMENTS, 'src/checkout.ts': CHECKOUT },
      committed(
        write('src/payments.ts', prefix + PAYMENTS.replace('processRefund', 'refundPayment')),
        write('src/checkout.ts', CHECKOUT.replaceAll('processRefund', 'refundPayment')),
      ),
      {
        committed: [write('src/payments.ts', reviewed + prefix + PAYMENTS)],
        uncommitted: [write('src/support.ts', SUPPORT)],
      },
      { registry, forkB: committed(write('src/payments.ts', owned + prefix + PAYMENTS)) },
    );
    expect(pair.changeSetB.mergeBaseSha).not.toBe(pair.merge.mergeBaseSha);
    expect(pair.changeSetB.files).toContainEqual(
      expect.objectContaining({
        path: 'src/payments.ts',
        hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }],
      }),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 4, endLine: 4 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 4 },
    ]);
  });
});

describe('references', () => {
  it('follows an aliased import to the name it imports', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import { processRefund as refund } from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return refund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 4 },
    ]);
    expect(trail(finding).map((step) => step.symbol)).toEqual(['processRefund', 'processRefund']);
  });

  it("reads a namespace import's property as that module's export", async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import * as payments from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return payments.processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics).toHaveLength(1);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('finds a renamed method as the one member of that name either branch changed', async () => {
    const ledger = lines(
      'export class Ledger {',
      '  processRefund(orderId: string): string {',
      '    return `refund:${orderId}`;',
      '  }',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/ledger.ts': ledger },
      committed(write('src/ledger.ts', ledger.replace('processRefund', 'refundPayment'))),
      committed(
        write(
          'src/support.ts',
          lines(
            'import { Ledger } from "./ledger";',
            '',
            'export function escalate(ledger: Ledger, orderId: string): string {',
            '  return ledger.processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/ledger.ts', startLine: 2, endLine: 2 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('names a removal under the generic rule, with an empty span where it was', async () => {
    const settle = lines(
      'export function settleBatch(batchId: string): string {',
      '  return batchId;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': `${PAYMENTS}\n${settle}` },
      committed(write('src/payments.ts', settle)),
      committed(write('src/support.ts', SUPPORT)),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.confidence).toBe(1);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 1, endLine: 0 },
    ]);
    expect(trail(finding).map((step) => step.action)).toEqual(['deleted', 'referenced']);
  });

  it('attributes too many arguments, reported over the extra one, to the changed signature', async () => {
    const format = lines(
      'export function formatPrice(amount: number, currency: string): string {',
      '  return `${currency} ${amount.toFixed(2)}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/format.ts': format },
      committed(
        write(
          'src/format.ts',
          lines(
            'export function formatPrice(amount: number): string {',
            '  return amount.toFixed(2);',
            '}',
          ),
        ),
      ),
      committed(
        write(
          'src/invoice.ts',
          lines(
            'import { formatPrice } from "./format";',
            '',
            'export function line(amount: number): string {',
            '  return formatPrice(',
            '    amount,',
            '    "EUR",',
            '  );',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => [each.code, each.line])).toEqual([[2554, 6]]);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.signature);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/invoice.ts', startLine: 4, endLine: 7 },
    ]);
  });

  it('keeps a path holding a space as the path', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/my support.ts', SUPPORT)),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/my support.ts', startLine: 1, endLine: 4 },
    ]);
  });
});

describe('when it cannot tell, it names no branch', () => {
  it('when both branches changed the declaration', async () => {
    const declaration = lines(
      'export function processRefund(',
      '  orderId: string,',
      '): string {',
      '  const id = orderId.trim();',
      '  return `refund:${id}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': declaration },
      committed(write('src/payments.ts', declaration.replace('processRefund', 'refundPayment'))),
      committed(
        write('src/payments.ts', declaration.replace('`refund:${id}`', '`refund:${id}:queued`')),
        write('src/support.ts', SUPPORT),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expectUnattributed(finding, 'both-changed-declaration');
    // What is known still stands: the reference is on the branch that holds it.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 4 },
    ]);
  });

  it('when the reference was already in the merge base', async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS, 'src/checkout.ts': CHECKOUT },
      committed(write('src/payments.ts', PAYMENTS.replace('processRefund', 'refundPayment'))),
      committed(write('src/other.ts', 'export const other = 1;\n')),
    );
    expect(pair.diagnostics.map((each) => each.file)).toEqual(['src/checkout.ts']);
    expectUnattributed(only((await pair.attribute()).findings), 'reference-in-base');
  });

  it("when the diagnostic's code is not one it reads", async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const diagnostic = { ...pair.diagnostics[0]!, code: 2322 };
    const finding = only((await pair.attribute({ diagnostics: [diagnostic] })).findings);
    expectUnattributed(finding, 'unrecognised-code');
    expect(finding.evidence.map((item) => item.type)).toEqual(['process-output']);
  });

  it('when a ChangeSet is missing, or is another branch’s', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    expectUnattributed(
      only((await pair.attribute({ changeSetB: null })).findings),
      'missing-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetA: null })).findings),
      'missing-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetA: pair.changeSetB })).findings),
      'missing-change-set',
    );
  });

  it('when a ChangeSet describes some other commit than the one merged', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    // As a ChangeSet captured before either branch wrote anything reads.
    expectUnattributed(
      only((await pair.attribute({ changeSetA: { ...pair.changeSetA, files: [] } })).findings),
      'stale-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetB: { ...pair.changeSetB, files: [] } })).findings),
      'stale-change-set',
    );
  });

  it('when the import is bare, and resolving it would need the project', async () => {
    const tsconfig = PROJECT['tsconfig.json']!.replace(
      '"moduleResolution": "bundler"',
      '"moduleResolution": "bundler",\n    "paths": { "@/*": ["./src/*"] }',
    );
    const pair = await checkedPair(
      { ...rename.base, 'tsconfig.json': tsconfig },
      rename.a,
      committed(write('src/support.ts', SUPPORT.replace('"./payments"', '"@/payments"'))),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2305]);
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('when the file holding the reference is past the parse cap, and not at it', async () => {
    // ASCII, so characters are bytes: the file is exactly `size` bytes long.
    const sized = (size: number): string =>
      `${SUPPORT}// ${'x'.repeat(size - SUPPORT.length - 4)}\n`;
    expect(sized(MAX_PARSED_BYTES)).toHaveLength(MAX_PARSED_BYTES);

    const over = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/support.ts', sized(MAX_PARSED_BYTES + 1))),
    );
    expect(over.diagnostics.map((each) => each.code)).toEqual([2305]);
    expectUnattributed(only((await over.attribute()).findings), 'unreadable-location');

    const at = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/support.ts', sized(MAX_PARSED_BYTES))),
    );
    const finding = only((await at.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(at.branchA);
  });

  it('when the diagnostic is not where it says it is', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const [diagnostic] = pair.diagnostics;
    for (const moved of [
      { ...diagnostic!, column: diagnostic!.column + 1 },
      { ...diagnostic!, start: diagnostic!.start + 1, column: diagnostic!.column + 1 },
      { ...diagnostic!, start: 1_000_000 },
      { ...diagnostic!, file: 'node_modules/typescript/lib/lib.d.ts' },
    ]) {
      expectUnattributed(
        only((await pair.attribute({ diagnostics: [moved] })).findings),
        'unreadable-location',
      );
    }
  });

  it('when the file nests deeper than the parser holds, without failing the batch', async () => {
    // The compiler overflows on this too, so the diagnostic is written by hand.
    const deep = `import { processRefund } from "./payments";\nexport const x = ${'['.repeat(1000)}1${']'.repeat(1000)};\n`;
    const pair = await fixtures.pair(rename.base, rename.a, committed(write('src/deep.ts', deep)));
    const diagnostic: FileDiagnostic = {
      code: 2305,
      category: 'error',
      message: "Module '\"./payments\"' has no exported member 'processRefund'.",
      file: 'src/deep.ts',
      start: 9,
      length: 13,
      line: 1,
      column: 10,
    };
    expectUnattributed(
      only((await pair.attribute({ diagnostics: [diagnostic] })).findings),
      'unreadable-location',
    );
  });

  it('when the branch that changed the declaration also added the reference', async () => {
    const pair = await checkedPair(
      rename.base,
      committed(...rename.a.committed, write('src/support.ts', SUPPORT)),
      committed(write('src/other.ts', 'export const other = 1;\n')),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'same-branch');
  });

  it('when both branches added the reference', async () => {
    const pair = await checkedPair(
      rename.base,
      committed(...rename.a.committed, write('src/support.ts', SUPPORT)),
      committed(write('src/support.ts', SUPPORT)),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'both-hold-reference');
  });

  it('when the branch that changed the declaration still has it as the diagnostic needs', async () => {
    // `a` reformats the function and `b` calls it with too few arguments: the
    // arity was never `a`'s to break.
    const format = lines(
      'export function formatPrice(amount: number, currency: string): string {',
      '  return `${currency} ${amount.toFixed(2)}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/format.ts': format },
      committed(write('src/format.ts', format.replace('return `', 'return  `'))),
      committed(
        write(
          'src/invoice.ts',
          lines('import { formatPrice } from "./format";', 'export const total = formatPrice(1);'),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2554]);
    expectUnattributed(only((await pair.attribute()).findings), 'change-does-not-explain');
  });

  it("when a branch's file is too far from the merged one to place the line, widening its span", async () => {
    const filler = Array.from({ length: 1100 }, (_, index) => `// note ${String(index)}`).join(
      '\n',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS },
      committed(
        write(
          'src/payments.ts',
          `${filler}\n${PAYMENTS.replace('processRefund', 'refundPayment')}`,
        ),
      ),
      committed(
        write(
          'src/payments.ts',
          PAYMENTS +
            lines(
              '',
              'export function escalate(orderId: string): string {',
              '  return processRefund(orderId);',
              '}',
            ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expectUnattributed(finding, 'mapping-unsure');
    // Where `b` wrote in the file, the call among it — not a line it cannot vouch for.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 4, endLine: 7 },
    ]);
  });
});

describe('evidence', () => {
  it('keeps an excerpt redacted and short, whatever the reference file holds', async () => {
    const token = `ghp_${'a1b2c3d4e5'.repeat(4)}`;
    const noise = Array.from(
      { length: 20 },
      (_, index) => `// \u001b[2J\u001b[31m line ${String(index)} ${'y'.repeat(80)}`,
    );
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import { processRefund } from "./payments";',
            `// ${token}`,
            ...noise,
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    const span = finding.evidence.find(
      (item): item is SpanEvidence => item.type === 'span' && item.branchRefId === pair.branchB,
    )!;
    expect(span.startLine).toBe(1);
    expect(span.endLine).toBe(24);
    expect(span.excerpt).not.toContain(token);
    expect(span.excerpt).toContain('[redacted]');
    expect(span.excerpt.split('\n').length).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect([...span.excerpt].length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });

  it("redacts the compiler's output", async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const token = `ghp_${'a1b2c3d4e5'.repeat(4)}`;
    const diagnostic = { ...pair.diagnostics[0]!, message: `has no exported member ${token}` };
    const output = toolOutput(only((await pair.attribute({ diagnostics: [diagnostic] })).findings));
    expect(output.output).not.toContain(token);
    expect(output.output).toContain('[redacted]');
  });
});

describe('the batch', () => {
  it('attributes at most the bound and counts the rest', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const diagnostics = Array.from(
      { length: MAX_FINDINGS_PER_RUN + 3 },
      () => pair.diagnostics[0]!,
    );
    const { findings, dropped } = await pair.attribute({ diagnostics });
    expect(findings).toHaveLength(MAX_FINDINGS_PER_RUN);
    expect(dropped).toBe(3);
  });

  it('stops with REQUEST_CANCELLED once its signal is aborted', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const controller = new AbortController();
    controller.abort();
    const attempt = attributeDiagnostics(
      {
        runId: ulid<SpeculativeRunId>(),
        branchA: pair.branchA,
        branchB: pair.branchB,
        changeSetA: pair.changeSetA,
        changeSetB: pair.changeSetB,
        merge: pair.merge,
        mergedTreeOid: pair.merged.treeOid,
        diagnostics: pair.diagnostics,
        now: new Date().toISOString(),
      },
      { runner: createGitRunner(), signal: controller.signal },
    );
    await expect(attempt).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('throws the runner’s infrastructure error rather than make a Finding from nothing', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const error: unknown = await pair.attribute({ mergedTreeOid: '0'.repeat(40) }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isInterlockError(error) && error.infra).toBe(true);
  });

  it('looks for a move in no more changed files than its bound', async () => {
    const extra = Array.from({ length: MAX_SCANNED_FILES }, (_, index) =>
      write(
        `src/extra-${String(index)}.ts`,
        `export const extra${String(index)} = ${String(index)};\n`,
      ),
    );
    const moved = SEMANTIC_CASES.find((each) => each.id === 'moved-export-vs-import')!;
    const pair = await checkedPair(moved.base, committed(...moved.a.committed, ...extra), moved.b);
    const finding = only((await pair.attribute()).findings);
    // Past the bound the move is not found: the narrower rule is lost, never the branch.
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
  });

  it('answers the same for a pair with no work on one side', async () => {
    const pair = await checkedPair(rename.base, rename.a, NO_CHANGE);
    expect(pair.diagnostics).toEqual([]);
  });
});
