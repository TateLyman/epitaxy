# -*- coding: utf-8 -*-
import io

p = 'tests/unit/worker-exactness-p3.test.ts'
s = io.open(p, encoding='utf-8').read()

old = """  it('resets the host byte counter, so job two does not inherit job one', async () => {
    const { worker } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i2' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'one' });
    const spent = (worker as unknown as { bytesSeen: number }).bytesSeen;
    expect(spent).toBeGreaterThan(0);
    await worker.init(SNAPSHOT, { jobId: 'two' });
    // Only init's own response is counted against the new job.
    expect((worker as unknown as { bytesSeen: number }).bytesSeen).toBeLessThanOrEqual(spent);
  });"""

new = """  it('resets the host byte counter, so job two does not inherit job one', async () => {
    const { worker } = wiredWorker([
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i1' },
      { ok: true, runtime_identity: IDENTITY, instance_id: 'i2' },
    ]);
    await worker.init(SNAPSHOT, { jobId: 'one' });

    // Stand in for a job that spent most of the allowance. The scripted child
    // does not go through the readline path that counts real bytes, so the
    // spend is set directly — the claim under test is the RESET, not the
    // counting, and the real counting is proved by worker:exactness-proof.
    (worker as unknown as { bytesSeen: number }).bytesSeen = 127 * 1024 * 1024;

    await worker.init(SNAPSHOT, { jobId: 'two' });

    // THE assertion. Without the reset, job two starts one megabyte from a
    // 128 MB bound it never approached, and dies for job one's spending.
    expect((worker as unknown as { bytesSeen: number }).bytesSeen).toBeLessThan(1024);
  });"""

assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
