//! P2/P3/P15 — the sequential local market runtime.
//!
//! The previous worker restored program accounts with `set_account(executable =
//! true)` and called that program loading. It is not: an upgradeable program
//! account holds loader state and a ProgramData pointer, not executable code,
//! and LiteSVM's program cache is populated by `add_program`. A route through a
//! program restored that way fails with an invalid-program error that looks
//! like a fact about the token.
//!
//! The property this exists to provide, which no pair of fresh JIT requests can:
//!
//!   the sell executes against the exact state the buy committed
//!
//! `send_transaction` commits to the runtime's own state, so a job carries a
//! LIST of steps and each one sees what the previous one did. Pool reserves,
//! vaults, the volume accumulator, fee state and every other writable carry
//! forward because they are the same accounts, not re-fetched copies.
//!
//! One process per job, no network, immutable file in and out. Every result
//! carries the runtime identity and the binary's own hash: there is no global
//! parity boolean, and a result is comparable only to another from the same
//! named runtime.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;

use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;

/// A program, with its ACTUAL executable bytes.
#[derive(Debug, Deserialize)]
struct ProgramInput {
    program_id: String,
    /// Base64 ELF, read from the chain's ProgramData account. Not the
    /// upgradeable program account, which holds only a pointer to it.
    elf_base64: String,
}

#[derive(Debug, Deserialize)]
struct SnapshotAccount {
    pubkey: String,
    data_base64: String,
    owner: String,
    lamports: u64,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    rent_epoch: u64,
}

/// One transaction in the sequence. Each sees the previous one's state.
#[derive(Debug, Deserialize)]
struct Step {
    label: String,
    transaction_base64: String,
    /// Accounts whose state the caller wants before and after THIS step.
    #[serde(default)]
    observe: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Job {
    job_id: String,
    #[serde(default)]
    programs: Vec<ProgramInput>,
    #[serde(default)]
    accounts: Vec<SnapshotAccount>,
    /// The slot and wall time the snapshot was taken at. A program that reads
    /// Clock behaves differently at a different slot, and "the default" is a
    /// silent third answer.
    #[serde(default)]
    slot: Option<u64>,
    #[serde(default)]
    unix_timestamp: Option<i64>,
    steps: Vec<Step>,
    #[serde(default)]
    max_compute_units: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct ObservedAccount {
    pubkey: String,
    lamports: u64,
    owner: String,
    data_base64: String,
    data_sha256: String,
}

#[derive(Debug, Serialize)]
struct StepResult {
    label: String,
    status: String,
    transaction_error: Option<String>,
    compute_units_consumed: Option<u64>,
    logs: Vec<String>,
    pre_accounts: Vec<ObservedAccount>,
    post_accounts: Vec<ObservedAccount>,
    /// Accounts named for observation that did not exist. A fact, not a zero.
    unobserved: Vec<String>,
}

#[derive(Debug, Serialize)]
struct JobResult {
    job_id: String,
    runtime: String,
    runtime_version: String,
    litesvm_version: String,
    binary_sha256: String,
    programs_loaded: Vec<String>,
    /// True only when EVERY step committed. A sequence with a failed step is
    /// not a lifecycle, and the steps after it saw a state no trade produced.
    sequential_complete: bool,
    steps: Vec<StepResult>,
    incompleteness: Vec<String>,
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, c) in T.iter().enumerate() {
        rev[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = rev[c as usize];
        if v == 255 {
            return Err(format!("invalid base64 byte {c}"));
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn binary_hash() -> String {
    match std::env::current_exe().and_then(std::fs::read) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => "unreadable".to_string(),
    }
}

fn observe(svm: &LiteSVM, names: &[String]) -> (Vec<ObservedAccount>, Vec<String>) {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for name in names {
        let key = match name.parse::<Pubkey>() {
            Ok(k) => k,
            Err(_) => {
                missing.push(format!("{name} is not a pubkey"));
                continue;
            }
        };
        match svm.get_account(&key) {
            Some(a) => out.push(ObservedAccount {
                pubkey: name.clone(),
                lamports: a.lamports,
                owner: a.owner.to_string(),
                data_base64: b64_encode(&a.data),
                data_sha256: sha256_hex(&a.data),
            }),
            None => missing.push(name.clone()),
        }
    }
    (out, missing)
}

fn run(job: Job) -> JobResult {
    let mut incompleteness: Vec<String> = Vec::new();

    // Sysvars and SPL programs first, then OUR programs override anything that
    // collides. Blockhash checking is off: these transactions were built
    // against a mainnet blockhash this runtime has never seen, and rejecting
    // them for that would refuse every real transaction.
    // Signature verification is OFF, and that is a property of this system
    // rather than a shortcut: nothing here ever signs. The transactions are
    // built, policy-checked and simulated unsigned, because a signer that
    // exists is a signer that can be called. Blockhash checking is off for the
    // same class of reason: these bytes carry a mainnet blockhash this runtime
    // has never seen, and refusing them for that would refuse every real one.
    // Transaction history is OFF too, and the reason is the same fact.
    //
    // The runtime deduplicates on `signature()`, and an unsigned transaction
    // carries the ZERO signature - so the second step of any sequence is
    // rejected as AlreadyProcessed no matter how different its content. That
    // is correct replay protection answering a question nobody asked here:
    // this is a counterfactual sequence, not a chain, and no signature exists
    // to protect.
    let mut svm = LiteSVM::new()
        .with_blockhash_check(false)
        .with_sigverify(false)
        .with_transaction_history(0);

    // ---- the actual executable code -------------------------------------
    let mut programs_loaded = Vec::new();
    for p in &job.programs {
        let key = match p.program_id.parse::<Pubkey>() {
            Ok(k) => k,
            Err(_) => {
                incompleteness.push(format!("program id {} is not a pubkey", p.program_id));
                continue;
            }
        };
        match b64_decode(&p.elf_base64) {
            Ok(elf) if !elf.is_empty() => {
                // THE fix. `set_account(executable = true)` populates no
                // program cache; `add_program` is what makes the code callable.
                svm.add_program(key, &elf);
                programs_loaded.push(format!("{} ({} bytes)", p.program_id, elf.len()));
            }
            Ok(_) => incompleteness.push(format!("program {} has empty ELF", p.program_id)),
            Err(e) => incompleteness.push(format!("program {} ELF did not decode: {e}", p.program_id)),
        }
    }

    // ---- the frozen account state ---------------------------------------
    for a in &job.accounts {
        let key = match a.pubkey.parse::<Pubkey>() {
            Ok(k) => k,
            Err(_) => {
                incompleteness.push(format!("account {} is not a pubkey", a.pubkey));
                continue;
            }
        };
        let owner = match a.owner.parse::<Pubkey>() {
            Ok(k) => k,
            Err(_) => {
                incompleteness.push(format!("owner of {} is not a pubkey", a.pubkey));
                continue;
            }
        };
        let data = match b64_decode(&a.data_base64) {
            Ok(d) => d,
            Err(e) => {
                incompleteness.push(format!("data of {} did not decode: {e}", a.pubkey));
                continue;
            }
        };
        // Executable accounts are skipped here when we already loaded their
        // ELF: overwriting the cache entry with loader bytes undoes the load.
        if a.executable && programs_loaded.iter().any(|p| p.starts_with(&a.pubkey)) {
            continue;
        }
        let acct = Account { lamports: a.lamports, data, owner, executable: a.executable, rent_epoch: a.rent_epoch };
        if let Err(e) = svm.set_account(key, acct) {
            incompleteness.push(format!("set_account({}) failed: {e:?}", a.pubkey));
        }
    }

    // ---- the clock the snapshot was taken at ----------------------------
    if let Some(slot) = job.slot {
        svm.warp_to_slot(slot);
        let clock = Clock {
            slot,
            epoch_start_timestamp: job.unix_timestamp.unwrap_or(0),
            epoch: slot / 432_000,
            leader_schedule_epoch: slot / 432_000,
            unix_timestamp: job.unix_timestamp.unwrap_or(0),
        };
        svm.set_sysvar(&clock);
    } else {
        // Named, because a program that reads Clock behaves differently at the
        // default slot and the difference is invisible in the result.
        incompleteness.push("no slot supplied; Clock is the runtime default".into());
    }

    if let Some(limit) = job.max_compute_units {
        let mut c = svm.get_compute_budget().unwrap_or_default();
        c.compute_unit_limit = limit;
        svm = svm.with_compute_budget(c);
    }

    // ---- the sequence ----------------------------------------------------
    let mut steps = Vec::new();
    let mut sequential_complete = true;

    for step in &job.steps {
        let (pre_accounts, pre_missing) = observe(&svm, &step.observe);

        let bytes = match b64_decode(&step.transaction_base64) {
            Ok(b) => b,
            Err(e) => {
                sequential_complete = false;
                steps.push(StepResult {
                    label: step.label.clone(),
                    status: "REFUSED".into(),
                    transaction_error: Some(format!("transaction did not decode: {e}")),
                    compute_units_consumed: None,
                    logs: vec![],
                    pre_accounts,
                    post_accounts: vec![],
                    unobserved: pre_missing,
                });
                // Everything after this would run against a state no trade
                // produced, so the sequence stops rather than continuing.
                break;
            }
        };

        let tx: VersionedTransaction = match bincode::deserialize(&bytes) {
            Ok(t) => t,
            Err(e) => {
                sequential_complete = false;
                steps.push(StepResult {
                    label: step.label.clone(),
                    status: "REFUSED".into(),
                    transaction_error: Some(format!("not a versioned transaction: {e}")),
                    compute_units_consumed: None,
                    logs: vec![],
                    pre_accounts,
                    post_accounts: vec![],
                    unobserved: pre_missing,
                });
                break;
            }
        };

        // COMMITS. The next step sees exactly this state.
        let (status, err, logs, cu) = match svm.send_transaction(tx) {
            Ok(meta) => ("SIMULATED_OK".to_string(), None, meta.logs, Some(meta.compute_units_consumed)),
            Err(failed) => (
                "SIMULATION_FAILED".to_string(),
                Some(format!("{:?}", failed.err)),
                failed.meta.logs,
                Some(failed.meta.compute_units_consumed),
            ),
        };
        if status != "SIMULATED_OK" {
            sequential_complete = false;
        }

        let (post_accounts, post_missing) = observe(&svm, &step.observe);
        let mut unobserved = pre_missing;
        for m in post_missing {
            if !unobserved.contains(&m) {
                unobserved.push(m);
            }
        }

        let failed = status != "SIMULATED_OK";
        steps.push(StepResult {
            label: step.label.clone(),
            status,
            transaction_error: err,
            compute_units_consumed: cu,
            logs,
            pre_accounts,
            post_accounts,
            unobserved,
        });
        if failed {
            break;
        }
    }

    if steps.len() < job.steps.len() {
        incompleteness.push(format!("{} of {} steps did not run", job.steps.len() - steps.len(), job.steps.len()));
    }

    JobResult {
        job_id: job.job_id,
        runtime: "litesvm".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        // Pinned in Cargo.toml and repeated here so a result names it without
        // anyone reading the manifest.
        litesvm_version: "0.6.1".into(),
        binary_sha256: binary_hash(),
        programs_loaded,
        sequential_complete,
        steps,
        incompleteness,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: epitaxy-offline-worker <job.json> [result.json]");
        std::process::exit(2);
    }
    let mut input = String::new();
    if let Err(e) = std::fs::File::open(&args[1]).and_then(|mut f| f.read_to_string(&mut input)) {
        eprintln!("cannot read job file: {e}");
        std::process::exit(2);
    }
    let job: Job = match serde_json::from_str(&input) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("job file is not a valid job: {e}");
            std::process::exit(2);
        }
    };

    let result = run(job);
    let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into());
    match args.get(2) {
        Some(path) => {
            if let Err(e) = std::fs::write(path, &text) {
                eprintln!("cannot write result: {e}");
                std::process::exit(2);
            }
        }
        None => println!("{text}"),
    }
}
