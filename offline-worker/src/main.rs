//! P20 — the offline replay worker.
//!
//! Surfpool's `surfnet_writeProgram` drops its RPC on the 10.5 MB Pump program,
//! and the `.so`-path theory was already falsified. Stable-pair offline replay
//! works; Pump offline replay does not, so no Pump fingerprint can be
//! confirmatory. That is the blocker this exists to remove.
//!
//! The contract is deliberately narrow and file-based:
//!
//!   immutable job file in  -> immutable result file out
//!
//! One process per job, no network, no shared state. A worker that can be
//! influenced between jobs is a worker whose parity result describes something
//! other than the job.
//!
//! Every result carries the runtime identity and the binary's own hash. The
//! directive is explicit that there is no global parity boolean: a result is
//! comparable only to another result produced by the same named runtime.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;

use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;

/// One account of frozen state, exactly as the snapshot recorded it.
#[derive(Debug, Deserialize)]
struct SnapshotAccount {
    pubkey: String,
    /// Base64. Bytes, never a decoded interpretation — the worker restores
    /// what was captured rather than what we think it meant.
    data_base64: String,
    owner: String,
    lamports: u64,
    executable: bool,
    rent_epoch: u64,
}

#[derive(Debug, Deserialize)]
struct Job {
    job_id: String,
    /// Base64 of the exact unsigned transaction. Not rebuilt here.
    transaction_base64: String,
    snapshot_accounts: Vec<SnapshotAccount>,
    /// Accounts whose post-state the caller wants back, by name.
    observe_accounts: Vec<String>,
    /// Compute unit ceiling, so a runaway job cannot hold the slot.
    max_compute_units: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ObservedAccount {
    pubkey: String,
    lamports: u64,
    owner: String,
    data_base64: String,
    /// Present so a caller can compare state without decoding it.
    data_sha256: String,
}

#[derive(Debug, Serialize)]
struct JobResult {
    job_id: String,
    /// The runtime that produced this. A result is comparable only to another
    /// from the same named runtime — there is no global parity boolean.
    runtime: String,
    runtime_version: String,
    binary_sha256: String,
    status: String,
    transaction_error: Option<String>,
    compute_units_consumed: Option<u64>,
    logs: Vec<String>,
    pre_accounts: Vec<ObservedAccount>,
    post_accounts: Vec<ObservedAccount>,
    /// What the worker could NOT do. Never empty-means-fine: a caller reads
    /// this before it reads anything else.
    incompleteness: Vec<String>,
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    // Minimal base64, so the worker has no decoder dependency to drift.
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
            // ABSENT is a fact, recorded as one. A zeroed placeholder would be
            // indistinguishable from an account that exists and holds nothing.
            None => missing.push(format!("{name} has no account after the run")),
        }
    }
    (out, missing)
}

fn run(job: Job) -> JobResult {
    let mut incompleteness: Vec<String> = Vec::new();
    let mut svm = LiteSVM::new();

    // Restore the frozen state, byte for byte.
    for a in &job.snapshot_accounts {
        let key = match a.pubkey.parse::<Pubkey>() {
            Ok(k) => k,
            Err(_) => {
                incompleteness.push(format!("snapshot account {} is not a pubkey", a.pubkey));
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
        // `executable` is set here, which is exactly what Surfpool's setAccount
        // could NOT do — a program restored non-executable fails every route
        // through it, and that error looks like a fact about the token.
        let acct = Account { lamports: a.lamports, data, owner, executable: a.executable, rent_epoch: a.rent_epoch };
        if let Err(e) = svm.set_account(key, acct) {
            incompleteness.push(format!("set_account({}) failed: {e:?}", a.pubkey));
        }
    }

    let (pre_accounts, pre_missing) = observe(&svm, &job.observe_accounts);
    for m in pre_missing {
        incompleteness.push(format!("pre: {m}"));
    }

    let bytes = match b64_decode(&job.transaction_base64) {
        Ok(b) => b,
        Err(e) => {
            return JobResult {
                job_id: job.job_id,
                runtime: "litesvm".into(),
                runtime_version: env!("CARGO_PKG_VERSION").into(),
                binary_sha256: binary_hash(),
                status: "REFUSED".into(),
                transaction_error: Some(format!("transaction did not decode: {e}")),
                compute_units_consumed: None,
                logs: vec![],
                pre_accounts,
                post_accounts: vec![],
                incompleteness,
            };
        }
    };

    let tx: VersionedTransaction = match bincode_deserialize(&bytes) {
        Ok(t) => t,
        Err(e) => {
            return JobResult {
                job_id: job.job_id,
                runtime: "litesvm".into(),
                runtime_version: env!("CARGO_PKG_VERSION").into(),
                binary_sha256: binary_hash(),
                status: "REFUSED".into(),
                transaction_error: Some(e),
                compute_units_consumed: None,
                logs: vec![],
                pre_accounts,
                post_accounts: vec![],
                incompleteness,
            };
        }
    };

    if let Some(limit) = job.max_compute_units {
        let mut c = svm.get_compute_budget().unwrap_or_default();
        c.compute_unit_limit = limit;
        svm = svm.with_compute_budget(c);
    }

    let (status, transaction_error, logs, cu) = match svm.send_transaction(tx) {
        Ok(meta) => ("SIMULATED_OK".to_string(), None, meta.logs, Some(meta.compute_units_consumed)),
        Err(failed) => (
            "SIMULATION_FAILED".to_string(),
            Some(format!("{:?}", failed.err)),
            failed.meta.logs,
            Some(failed.meta.compute_units_consumed),
        ),
    };

    let (post_accounts, post_missing) = observe(&svm, &job.observe_accounts);
    for m in post_missing {
        incompleteness.push(format!("post: {m}"));
    }

    JobResult {
        job_id: job.job_id,
        runtime: "litesvm".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        binary_sha256: binary_hash(),
        status,
        transaction_error,
        compute_units_consumed: cu,
        logs,
        pre_accounts,
        post_accounts,
        incompleteness,
    }
}

/// Deserialize a versioned transaction from its wire bytes.
fn bincode_deserialize(bytes: &[u8]) -> Result<VersionedTransaction, String> {
    bincode::deserialize::<VersionedTransaction>(bytes).map_err(|e| format!("not a versioned transaction: {e}"))
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

// Kept for the type name only; the map is unused but documents the shape a
// caller may add later without changing the contract.
#[allow(dead_code)]
type AccountMap = HashMap<String, Account>;
