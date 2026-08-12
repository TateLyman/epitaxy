import csv
import pathlib

P = pathlib.Path('docs/FAILURE_REGISTER.csv')
rows = list(csv.reader(P.open(encoding='utf-8')))
header = rows[0]
existing = {r[0] for r in rows[1:]}

NEW = [
    dict(
        id='O037',
        category='strategy',
        failure='the daily loss cap is permanent, not daily, and halts the engine indefinitely',
        trigger='Ledger.dayStartUtcMs was assigned once in restoreLedger and read by nothing; realizedTodayLamports therefore accumulated from process start and never released at midnight UTC',
        detection='found by asking why pnpm status showed 145 eligible candidates and 0 open positions; sizePosition was refusing every entry with daily_loss_cap against -0.248 SOL realised on earlier days',
        impact='paper mode stopped opening positions for the entire first measurement window and continued to look healthy - it screened, scored and logged normally. Zero closed trades were added to the sample while the process reported itself live. A cap that never releases is indistinguishable from a hang',
        prevention='rollDayIfNeeded is called every cycle before any entry work and recomputes realizedTodayLamports from the database for the new UTC day; the cap value itself is unchanged',
        recovery='no data to repair - no trade was taken or mispriced, the engine simply refused to act',
        retry_policy='n/a',
        metric_alert='an engine reporting eligible candidates with zero open positions for more than one discovery interval, while below maxSimultaneousPositions, is a defect signal',
        test_fixture='tests/unit/ledger.test.ts',
        status='implemented',
        owner_module='apps/engine/src/ledger.ts',
    ),
    dict(
        id='O038',
        category='storage',
        failure='realised P&L summed through a double, defeating the reason the column is TEXT',
        trigger='restoreLedger used SUM(CAST(realized_lamports AS INTEGER)) and read the result as a JS number before passing it to BigInt()',
        detection='found while extracting the ledger helpers into a testable module',
        impact='amounts above 2^53 silently lose precision and any non-integral sum makes the subsequent BigInt() throw. Paper NAV is far below that today, so this had not yet produced a wrong number - it was a latent violation of the bigint invariant sitting in the NAV path',
        prevention='sumRealized selects the TEXT values and accumulates in bigint; a test sums 2^53+1 across two rows and asserts the double answer is wrong',
        recovery='n/a - no stored value was affected',
        retry_policy='n/a',
        metric_alert='none; the property is enforced by test rather than by monitoring',
        test_fixture='tests/unit/ledger.test.ts',
        status='implemented',
        owner_module='apps/engine/src/ledger.ts',
    ),
    dict(
        id='O039',
        category='observability',
        failure='the resolution of the entire exit corpus was set by the discovery budget',
        trigger='the paper loop had one interval; open positions were re-quoted only when discovery ran, so the mark cadence was discoveryIntervalMs - about 31s as measured',
        detection='found in P1 while attributing losses: every one of the four liquidity collapses did all of its damage inside a single mark interval',
        impact='the corpus cannot distinguish a one-block rug from a 25-second drain, so it cannot say whether any prospective exit signal existed. This is an instrument limitation and it blocks the central question of P2, not a market finding',
        prevention='markIntervalMs is a separate config field defaulting to 10s; the loop ticks at the mark cadence and discovery gates itself on its own longer interval. Paper maxSimultaneousPositions is 1 during the measurement phase so exit monitoring is never starved by candidate scanning',
        recovery='the 150 existing marks keep their ~31s spacing and are labelled as such; they are not reinterpreted at the finer resolution',
        retry_policy='n/a',
        metric_alert='observed spacing between consecutive position_marks rows exceeding 2x markIntervalMs',
        test_fixture='tests/unit/ledger.test.ts',
        status='partial',
        owner_module='apps/engine/src/paper.ts',
    ),
]

added = 0
with P.open('a', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=header, lineterminator='\n')
    for row in NEW:
        if row['id'] in existing:
            print('skip', row['id'], '(already present)')
            continue
        assert set(row) == set(header), set(row) ^ set(header)
        w.writerow(row)
        added += 1

rows = list(csv.reader(P.open(encoding='utf-8')))
bad = [i for i, r in enumerate(rows) if len(r) != len(header)]
print(f'added {added}; {len(rows)-1} rows, {len(header)} cols, malformed: {bad}')
assert not bad
