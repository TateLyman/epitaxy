# -*- coding: utf-8 -*-
import io, sys

p = 'offline-worker/src/main.rs'
s = io.open(p, encoding='utf-8').read()
orig = s


def sub(old, new, n=1):
    global s
    if s.count(old) < 1:
        print('MISS:', old[:100].replace('\n', ' | '))
        sys.exit(1)
    s = s.replace(old, new, n)


# ------------------------------------------------------------ Command enum ---
sub(
    '''    /// Execute one transaction and COMMIT it.
    Step { step: Step },
    /// Read accounts WITHOUT executing anything, so the host can build the next
    /// transaction from the state that actually exists right now.
    Observe { observe: Vec<String> },''',
    '''    /// Execute one transaction and COMMIT it.
    Step { step: Step },
    /// Read accounts WITHOUT executing anything, so the host can build the next
    /// transaction from the state that actually exists right now.
    Observe {
        observe: Vec<String>,
        /// F8 -- which of them the caller needs the bytes of. See `Step`.
        #[serde(default)]
        economic: Option<Vec<String>>,
    },''',
)

# --------------------------------------------------------------- Response ---
sub(
    '''    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    incompleteness: Vec<String>,
}''',
    '''    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    incompleteness: Vec<String>,
    /// P3 -- which runtime instance answered.
    ///
    /// A quote and the execution it priced must come from ONE runtime. Nothing
    /// proved that: an `Init` between them replaced the world and the host had
    /// no field to notice with, so a sell built against instance A could be
    /// executed and settled in instance B and every hash comparison would
    /// simply compare the wrong things.
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    /// Bytes this JOB has emitted so far. Reset by `Init`, not at process exit.
    #[serde(skip_serializing_if = "Option::is_none")]
    job_output_bytes: Option<String>,
}''',
)

sub(
    '''            state_hash: None,
            incompleteness: vec![],
        }
    }
    fn blank() -> Self {''',
    '''            state_hash: None,
            incompleteness: vec![],
            instance_id: None,
            job_output_bytes: None,
        }
    }
    fn blank() -> Self {''',
)

sub(
    '''            state_hash: None,
            incompleteness: vec![],
        }
    }
}''',
    '''            state_hash: None,
            incompleteness: vec![],
            instance_id: None,
            job_output_bytes: None,
        }
    }
}''',
)

# ------------------------------------------------------------------ serve ---
sub(
    '''    let mut live: Option<LiveRuntime> = None;
    // Every account the host has ever named, so the state hash covers the whole
    // economically relevant surface rather than whatever this call asked for.
    let mut known: Vec<String> = Vec::new();
''',
    '''    let mut live: Option<LiveRuntime> = None;
    // Every account the host has named SINCE THE CURRENT INIT, so the state
    // hash covers the whole economically relevant surface rather than whatever
    // this call asked for.
    //
    // F8 -- this used to accumulate for the life of the PROCESS. Job two's
    // state hash then covered job one's accounts, which in a fresh runtime are
    // absent; the hash changed for reasons that had nothing to do with job two,
    // and "the state moved" became a claim about a previous experiment.
    let mut known: Vec<String> = Vec::new();
    // Which instance is answering, and what this job has cost so far. Both are
    // job-scoped, and `Init` is the only thing that moves them.
    let mut instance_id: Option<String> = None;
    let mut instance_seq: u64 = 0;
    let mut job_output_bytes: u64 = 0;
    let mut max_job_output_bytes: u64 = DEFAULT_MAX_JOB_OUTPUT_BYTES;
''',
)

sub(
    '''            Command::Init(job) => {
                let rt = build_runtime(&job);
                for a in &job.accounts {
                    known.push(a.pubkey.clone());
                }
                let mut r = Response::blank();
                r.runtime_identity = Some(RuntimeIdentity {
                    runtime: "litesvm".into(),
                    runtime_version: env!("CARGO_PKG_VERSION").into(),
                    litesvm_version: "0.6.1".into(),
                    binary_sha256: binary_hash(),
                    programs_loaded: rt.programs_loaded.clone(),
                });
                r.incompleteness = rt.incompleteness.clone();
                r.state_hash = Some(state_hash(&rt.svm, &known));
                live = Some(rt);
                r
            }''',
    '''            Command::Init(job) => {
                let rt = build_runtime(&job);

                // P3 -- required incompleteness REFUSES. A runtime missing an
                // account the transaction needs produces a failure that reads
                // as a fact about the token rather than about us.
                let mut fatal: Vec<String> = Vec::new();
                for want in &job.required_accounts {
                    let present = want
                        .parse::<Pubkey>()
                        .ok()
                        .and_then(|k| rt.svm.get_account(&k))
                        .is_some();
                    if !present {
                        fatal.push(format!("required account {want} is not in the runtime"));
                    }
                }
                for want in &job.required_programs {
                    if !rt.programs_loaded.iter().any(|p| p.starts_with(want)) {
                        fatal.push(format!("required program {want} was not loaded"));
                    }
                }
                if job.require_exact_sysvars {
                    if job.clock.is_none() {
                        fatal.push("exact sysvars required but no Clock was captured".into());
                    }
                    if job.rent.is_none() {
                        fatal.push("exact sysvars required but no Rent was captured".into());
                    }
                    if job.epoch_schedule.is_none() {
                        fatal.push("exact sysvars required but no EpochSchedule was captured".into());
                    }
                }

                if fatal.is_empty() {
                    // Everything job-scoped resets HERE and nowhere else.
                    known.clear();
                    for a in &job.accounts {
                        known.push(a.pubkey.clone());
                    }
                    instance_seq += 1;
                    job_output_bytes = 0;
                    max_job_output_bytes =
                        job.max_job_output_bytes.unwrap_or(DEFAULT_MAX_JOB_OUTPUT_BYTES);
                    let id = format!("{}:{}:{}", job.job_id, std::process::id(), instance_seq);
                    instance_id = Some(id.clone());

                    let mut r = Response::blank();
                    r.runtime_identity = Some(RuntimeIdentity {
                        runtime: "litesvm".into(),
                        runtime_version: env!("CARGO_PKG_VERSION").into(),
                        litesvm_version: "0.6.1".into(),
                        binary_sha256: binary_hash(),
                        programs_loaded: rt.programs_loaded.clone(),
                    });
                    r.incompleteness = rt.incompleteness.clone();
                    r.state_hash = Some(state_hash(&rt.svm, &known));
                    r.instance_id = Some(id);
                    live = Some(rt);
                    r
                } else {
                    // A refused init leaves NO runtime, so the next command
                    // cannot quietly run against a half-built world.
                    live = None;
                    instance_id = None;
                    known.clear();
                    Response::err(format!("init refused: {}", fatal.join("; ")))
                }
            }''',
)

sub(
    '''                Some(rt) => {
                    for a in &step.observe {
                        if !known.contains(a) {
                            known.push(a.clone());
                        }
                    }
                    let result = execute_step(&mut rt.svm, &step);
                    let mut r = Response::blank();
                    r.ok = result.status == "SIMULATED_OK";
                    r.state_hash = Some(state_hash(&rt.svm, &known));
                    r.step = Some(result);
                    r
                }''',
    '''                Some(rt) => {
                    for a in &step.observe {
                        if !known.contains(a) {
                            known.push(a.clone());
                        }
                    }
                    let result = execute_step(&mut rt.svm, &step);
                    let mut r = Response::blank();
                    r.ok = result.status == "SIMULATED_OK";
                    r.state_hash = Some(state_hash(&rt.svm, &known));
                    r.step = Some(result);
                    r.instance_id = instance_id.clone();
                    r
                }''',
)

sub(
    '''            Command::Observe { observe } => match live.as_ref() {
                None => Response::err("no runtime: init first".into()),
                Some(rt) => {
                    let (accounts, missing) = observe_accounts(&rt.svm, &observe);
                    let mut r = Response::blank();
                    r.accounts = Some(accounts);
                    r.unobserved = Some(missing);
                    // The hash is over the SAME set the caller asked about, so
                    // it can be compared directly with the sell step's own
                    // pre-state hash.
                    r.state_hash = Some(state_hash(&rt.svm, &observe));
                    r
                }
            },
        };

        let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap_or_default());
        let _ = stdout.flush();
    }
}''',
    '''            Command::Observe { observe, economic } => match live.as_ref() {
                None => Response::err("no runtime: init first".into()),
                Some(rt) => {
                    let set: Option<HashSet<String>> =
                        economic.as_ref().map(|e| e.iter().cloned().collect());
                    let (accounts, missing) = observe_accounts(&rt.svm, &observe, set.as_ref());
                    let mut r = Response::blank();
                    r.accounts = Some(accounts);
                    r.unobserved = Some(missing);
                    // The hash is over the SAME set the caller asked about, so
                    // it can be compared directly with the sell step's own
                    // pre-state hash.
                    r.state_hash = Some(state_hash(&rt.svm, &observe));
                    r.instance_id = instance_id.clone();
                    r
                }
            },
        };

        let mut response = response;
        let mut text = serde_json::to_string(&response).unwrap_or_default();

        // F8 -- the budget is per JOB. A process-lifetime total lets job one
        // spend the whole allowance and job two die for it, and lets a long
        // session pass a bound that no single experiment ever approached.
        job_output_bytes = job_output_bytes.saturating_add(text.len() as u64 + 1);
        if job_output_bytes > max_job_output_bytes {
            // Refuse with a small response rather than emit the large one.
            // Truncating the payload would hand back a partial observation that
            // still looks like an observation.
            response = Response::err(format!(
                "job output budget exhausted: {job_output_bytes} bytes emitted, bound is \
                 {max_job_output_bytes}. Name fewer economic accounts, or raise \
                 max_job_output_bytes on init."
            ));
            response.job_output_bytes = Some(job_output_bytes.to_string());
            text = serde_json::to_string(&response).unwrap_or_default();
        } else {
            response.job_output_bytes = Some(job_output_bytes.to_string());
            text = serde_json::to_string(&response).unwrap_or_default();
        }

        let _ = writeln!(stdout, "{text}");
        let _ = stdout.flush();
    }
}''',
)

# The one-shot path builds Steps that no longer carry `economic`; nothing to do
# there -- `None` means full bytes, which is what it always emitted.

sub(
    '''fn binary_hash() -> String {''',
    '''/// Default response budget for ONE job.
///
/// 64 MiB is well above any legitimate sequence -- a buy, a sell and their
/// observations -- and well below the ~280 MB that killed the worker on a size
/// surface. It is a bound on our own apparatus, not on the experiment.
const DEFAULT_MAX_JOB_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

fn binary_hash() -> String {''',
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('rust part 3 ok', len(orig), '->', len(s))
