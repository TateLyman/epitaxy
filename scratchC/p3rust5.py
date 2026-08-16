# -*- coding: utf-8 -*-
import io

p = 'offline-worker/src/main.rs'
lines = io.open(p, encoding='utf-8').read().split('\n')

start = next(i for i, l in enumerate(lines) if l.strip() == 'let mut response = response;')
end = next(i for i, l in enumerate(lines) if 'writeln!(stdout, "{text}")' in l)

new = '''        // F8 -- the budget is per JOB. A process-lifetime total lets job one
        // spend the whole allowance and job two die for it, and lets a long
        // session pass a bound no single experiment ever approached.
        let draft = serde_json::to_string(&response).unwrap_or_default();
        job_output_bytes = job_output_bytes.saturating_add(draft.len() as u64 + 1);

        let mut response = if job_output_bytes > max_job_output_bytes {
            // Refuse with a small response rather than emit the large one.
            // Truncating the payload would hand back a partial observation that
            // still looks like an observation.
            Response::err(format!(
                "job output budget exhausted: {job_output_bytes} bytes emitted, bound is {max_job_output_bytes}. Name fewer economic accounts, or raise max_job_output_bytes on init."
            ))
        } else {
            response
        };
        response.job_output_bytes = Some(job_output_bytes.to_string());
        let text = serde_json::to_string(&response).unwrap_or_default();
'''.split('\n')

out = lines[:start] + new + lines[end:]
io.open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('replaced lines', start + 1, '..', end)
