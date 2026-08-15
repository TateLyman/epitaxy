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
use std::collections::HashSet;
use std::io::{BufRead, Read, Write};

use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::epoch_schedule::EpochSchedule;
use solana_sdk::rent::Rent;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;

/// F7 -- every u64 and i64 on this wire is a DECIMAL STRING.
///
/// JSON has exactly one number type and it is an IEEE double. `rent_epoch` for
/// a rent-exempt account is u64::MAX = 18446744073709551615, which no double
/// can represent: the nearest one is 2^64, so the value returns ONE HIGHER than
/// it went in and prints as 18446744073709552000. Nothing raises. Both ends
/// agree on a number the chain never produced.
///
/// Deserialization accepts a string ONLY. Accepting a number "for
/// compatibility" leaves the defect reachable from every caller that was not
/// updated, which is the same as not fixing it, and this project has shipped
/// that compromise before.
mod u64s {
    use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

    pub fn ser<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn ser_opt<S: Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.serialize_str(&x.to_string()),
            None => s.serialize_none(),
        }
    }
    pub fn de<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<u64>()
            .map_err(|e| D::Error::custom(format!("{s:?} is not a u64 decimal string: {e}")))
    }
    pub fn de_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<i64>()
            .map_err(|e| D::Error::custom(format!("{s:?} is not an i64 decimal string: {e}")))
    }
    pub fn de_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        match Option::<String>::deserialize(d)? {
            None => Ok(None),
            Some(s) => s
                .parse::<u64>()
                .map(Some)
                .map_err(|e| D::Error::custom(format!("{s:?} is not a u64 decimal string: {e}"))),
        }
    }
    pub fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        match Option::<String>::deserialize(d)? {
            None => Ok(None),
            Some(s) => s
                .parse::<i64>()
                .map(Some)
                .map_err(|e| D::Error::custom(format!("{s:?} is not an i64 decimal string: {e}"))),
        }
    }
}

/// The rent epoch of an account the chain considers exempt.
///
/// Defaulting this to 0 -- which is what the previous protocol hardcoded --
/// restores every mainnet account as rent-PAYING. That is a different account.
fn rent_exempt_epoch() -> u64 {
    u64::MAX
}

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
    #[serde(deserialize_with = "u64s::de")]
    lamports: u64,
    #[serde(default)]
    executable: bool,
    #[serde(default = "rent_exempt_epoch", deserialize_with = "u64s::de")]
    rent_epoch: u64,
}

/// F9 -- the sysvars EXACTLY as captured, not re-derived here.
///
/// The previous build computed `epoch = slot / 432_000` and left Rent and
/// EpochSchedule at the runtime default. Epoch division by a constant is wrong
/// across the warmup epochs and wrong whenever the cluster's schedule differs,
/// and a program that reads Rent to size an account it creates gets a different
/// answer than mainnet gave. None of that surfaces as an error: it surfaces as
/// an economic number that is quietly not the chain's.
#[derive(Debug, Deserialize)]
struct ClockInput {
    #[serde(deserialize_with = "u64s::de")]
    slot: u64,
    #[serde(deserialize_with = "u64s::de_i64")]
    epoch_start_timestamp: i64,
    #[serde(deserialize_with = "u64s::de")]
    epoch: u64,
    #[serde(deserialize_with = "u64s::de")]
    leader_schedule_epoch: u64,
    #[serde(deserialize_with = "u64s::de_i64")]
    unix_timestamp: i64,
}

#[derive(Debug, Deserialize)]
struct RentInput {
    #[serde(deserialize_with = "u64s::de")]
    lamports_per_byte_year: u64,
    exemption_threshold: f64,
    burn_percent: u8,
}

#[derive(Debug, Deserialize)]
struct EpochScheduleInput {
    #[serde(deserialize_with = "u64s::de")]
    slots_per_epoch: u64,
    #[serde(deserialize_with = "u64s::de")]
    leader_schedule_slot_offset: u64,
    warmup: bool,
    #[serde(deserialize_with = "u64s::de")]
    first_normal_epoch: u64,
    #[serde(deserialize_with = "u64s::de")]
    first_normal_slot: u64,
}

/// One transaction in the sequence. Each sees the previous one's state.
#[derive(Debug, Deserialize)]
struct Step {
    label: String,
    transaction_base64: String,
    /// Accounts whose state the caller wants before and after THIS step.
    #[serde(default)]
    observe: Vec<String>,
    /// F8 -- which of those the caller needs the actual BYTES of.
    ///
    /// Everything observed still reports owner, lamports, executable, rent
    /// epoch, length and hashes; only the base64 payload is restricted. A
    /// 0.02 SOL size surface emitted ~280 MB of base64 and killed the worker,
    /// and almost none of it was ever read: the host needs pool and vault bytes
    /// to build the next leg, and a lamport balance for everything else.
    ///
    /// Absent means "all of them", which is what the one-shot job path has
    /// always done and what its callers still expect.
    #[serde(default)]
    economic: Option<Vec<String>>,
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
    #[serde(default, deserialize_with = "u64s::de_opt")]
    slot: Option<u64>,
    #[serde(default, deserialize_with = "u64s::de_opt_i64")]
    unix_timestamp: Option<i64>,
    #[serde(default)]
    steps: Vec<Step>,
    #[serde(default, deserialize_with = "u64s::de_opt")]
    max_compute_units: Option<u64>,

    /// F9 -- exact captured sysvars. When present these are restored verbatim
    /// and nothing is derived.
    #[serde(default)]
    clock: Option<ClockInput>,
    #[serde(default)]
    rent: Option<RentInput>,
    #[serde(default)]
    epoch_schedule: Option<EpochScheduleInput>,
    /// Refuse rather than derive. A caller that captured exact state and got a
    /// synthesized Clock anyway has an approximation labelled as a capture.
    #[serde(default)]
    require_exact_sysvars: bool,

    /// P3 -- without these this runtime is not the one the caller asked for.
    ///
    /// Incompleteness on a required account is not a note in a list somebody
    /// might read. It refuses, because a run against a runtime missing an
    /// account the transaction needs fails with an error that reads as a fact
    /// about the token.
    #[serde(default)]
    required_accounts: Vec<String>,
    #[serde(default)]
    required_programs: Vec<String>,

    /// Bytes of response this JOB may produce. Per job, not per process.
    #[serde(default, deserialize_with = "u64s::de_opt")]
    max_job_output_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct ObservedAccount {
    pubkey: String,
    #[serde(serialize_with = "u64s::ser")]
    lamports: u64,
    owner: String,
    executable: bool,
    #[serde(serialize_with = "u64s::ser")]
    rent_epoch: u64,
    #[serde(serialize_with = "u64s::ser")]
    data_len: u64,
    /// Present only when the caller named this account economic. See `Step`.
    #[serde(skip_serializing_if = "Option::is_none")]
    data_base64: Option<String>,
    data_sha256: String,
    /// F10 -- the COMPLETE identity of this account, not just its data.
    ///
    /// The survival check compared `data_sha256`, so a sell could execute
    /// against a state whose owner, lamports, executability or rent epoch had
    /// all changed and the assertion would still pass. Those are the fields a
    /// runtime uses to decide whether an instruction is even legal.
    account_hash: String,
}

#[derive(Debug, Serialize)]
struct StepResult {
    label: String,
    status: String,
    transaction_error: Option<String>,
    #[serde(serialize_with = "u64s::ser_opt")]
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

/// Default response budget for ONE job.
///
/// 64 MiB is well above any legitimate sequence -- a buy, a sell and their
/// observations -- and well below the ~280 MB that killed the worker on a size
/// surface. It is a bound on our own apparatus, not on the experiment.
const DEFAULT_MAX_JOB_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

fn binary_hash() -> String {
    match std::env::current_exe().and_then(std::fs::read) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => "unreadable".to_string(),
    }
}

/// The COMPLETE identity of one account, present or absent.
///
/// Every field a runtime consults before it will execute against the account:
/// who owns it, what it holds, whether it can be called, whether it is exempt,
/// and its bytes. Absence hashes differently from present-and-empty, because
/// those are different facts and an account that vanished between quote and
/// execution must not compare equal to one that was always empty.
fn account_hash(pubkey: &str, acct: Option<&Account>) -> String {
    let mut h = Sha256::new();
    h.update(pubkey.as_bytes());
    match acct {
        None => h.update(b"|absent"),
        Some(a) => {
            h.update(b"|present|");
            h.update(a.owner.to_bytes());
            h.update(a.lamports.to_le_bytes());
            h.update([u8::from(a.executable)]);
            h.update(a.rent_epoch.to_le_bytes());
            h.update((a.data.len() as u64).to_le_bytes());
            h.update(&a.data);
        }
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Read accounts out of the runtime.
///
/// `economic` is F8: everything named is REPORTED, but only accounts the caller
/// declared economic carry their base64 payload. The rest still carry owner,
/// lamports, executability, rent epoch, length and both hashes -- enough to
/// detect any change, and enough to price a wallet -- without shipping a
/// megabyte of program data the host will never read.
fn observe_accounts(
    svm: &LiteSVM,
    names: &[String],
    economic: Option<&HashSet<String>>,
) -> (Vec<ObservedAccount>, Vec<String>) {
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
            Some(a) => {
                let full = match economic {
                    None => true,
                    Some(set) => set.contains(name),
                };
                out.push(ObservedAccount {
                    pubkey: name.clone(),
                    lamports: a.lamports,
                    owner: a.owner.to_string(),
                    executable: a.executable,
                    rent_epoch: a.rent_epoch,
                    data_len: a.data.len() as u64,
                    data_base64: if full { Some(b64_encode(&a.data)) } else { None },
                    data_sha256: sha256_hex(&a.data),
                    account_hash: account_hash(name, Some(&a)),
                });
            }
            None => missing.push(name.clone()),
        }
    }
    (out, missing)
}

/// A runtime that is ALIVE between calls.
///
/// The one-shot path builds this, runs its steps and drops it. Serve mode keeps
/// it, which is the entire point of P3: the sell has to be BUILT from the state
/// the buy committed and then executed in THAT SAME runtime. Two runtime
/// instances that both replay the same buy should agree, but nothing proves
/// they do, and a sell priced against a state it did not execute in is exactly
/// the approximation this eliminates.
struct LiveRuntime {
    svm: LiteSVM,
    programs_loaded: Vec<String>,
    incompleteness: Vec<String>,
}

fn build_runtime(job: &Job) -> LiveRuntime {
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

    // ---- F9: the sysvars, exactly as captured ---------------------------
    //
    // Exact first. Deriving `epoch = slot / 432_000` is wrong across the warmup
    // epochs and wrong on any cluster whose schedule differs, and Rent left at
    // the runtime default gives a program sizing a new account a different
    // answer than mainnet gave it. Neither shows up as an error.
    match &job.clock {
        Some(c) => {
            svm.warp_to_slot(c.slot);
            svm.set_sysvar(&Clock {
                slot: c.slot,
                epoch_start_timestamp: c.epoch_start_timestamp,
                epoch: c.epoch,
                leader_schedule_epoch: c.leader_schedule_epoch,
                unix_timestamp: c.unix_timestamp,
            });
        }
        None => match job.slot {
            Some(slot) => {
                svm.warp_to_slot(slot);
                svm.set_sysvar(&Clock {
                    slot,
                    epoch_start_timestamp: job.unix_timestamp.unwrap_or(0),
                    epoch: slot / 432_000,
                    leader_schedule_epoch: slot / 432_000,
                    unix_timestamp: job.unix_timestamp.unwrap_or(0),
                });
                incompleteness
                    .push("Clock DERIVED from slot; epoch is slot/432000, not the captured epoch".into());
            }
            None => incompleteness.push("no slot supplied; Clock is the runtime default".into()),
        },
    }

    match &job.rent {
        Some(r) => svm.set_sysvar(&Rent {
            lamports_per_byte_year: r.lamports_per_byte_year,
            exemption_threshold: r.exemption_threshold,
            burn_percent: r.burn_percent,
        }),
        None => incompleteness.push("no Rent captured; the runtime default is in use".into()),
    }

    match &job.epoch_schedule {
        Some(e) => svm.set_sysvar(&EpochSchedule {
            slots_per_epoch: e.slots_per_epoch,
            leader_schedule_slot_offset: e.leader_schedule_slot_offset,
            warmup: e.warmup,
            first_normal_epoch: e.first_normal_epoch,
            first_normal_slot: e.first_normal_slot,
        }),
        None => incompleteness.push("no EpochSchedule captured; the runtime default is in use".into()),
    }

    if let Some(limit) = job.max_compute_units {
        let mut c = svm.get_compute_budget().unwrap_or_default();
        c.compute_unit_limit = limit;
        svm = svm.with_compute_budget(c);
    }

    LiveRuntime { svm, programs_loaded, incompleteness }
}

/// Execute ONE step against a live runtime and commit it.
///
/// Shared by both modes so the one-shot and serve paths cannot drift into
/// executing transactions differently -- which would make their results
/// incomparable while looking like the same worker.
fn execute_step(svm: &mut LiteSVM, step: &Step) -> StepResult {
    let economic: Option<HashSet<String>> =
        step.economic.as_ref().map(|e| e.iter().cloned().collect());
    let (pre_accounts, pre_missing) = observe_accounts(svm, &step.observe, economic.as_ref());

    let bytes = match b64_decode(&step.transaction_base64) {
        Ok(b) => b,
        Err(e) => {
            return StepResult {
                label: step.label.clone(),
                status: "REFUSED".into(),
                transaction_error: Some(format!("transaction did not decode: {e}")),
                compute_units_consumed: None,
                logs: vec![],
                pre_accounts,
                post_accounts: vec![],
                unobserved: pre_missing,
            }
        }
    };

    let tx: VersionedTransaction = match bincode::deserialize(&bytes) {
        Ok(t) => t,
        Err(e) => {
            return StepResult {
                label: step.label.clone(),
                status: "REFUSED".into(),
                transaction_error: Some(format!("not a versioned transaction: {e}")),
                compute_units_consumed: None,
                logs: vec![],
                pre_accounts,
                post_accounts: vec![],
                unobserved: pre_missing,
            }
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

    let (post_accounts, post_missing) = observe_accounts(svm, &step.observe, economic.as_ref());
    let mut unobserved = pre_missing;
    for m in post_missing {
        if !unobserved.contains(&m) {
            unobserved.push(m);
        }
    }

    StepResult {
        label: step.label.clone(),
        status,
        transaction_error: err,
        compute_units_consumed: cu,
        logs,
        pre_accounts,
        post_accounts,
        unobserved,
    }
}

fn run(job: Job) -> JobResult {
    let rt = build_runtime(&job);
    let mut svm = rt.svm;
    let programs_loaded = rt.programs_loaded;
    let mut incompleteness = rt.incompleteness;

    // ---- the sequence ----------------------------------------------------
    let mut steps = Vec::new();
    let mut sequential_complete = true;

    for step in &job.steps {
        let result = execute_step(&mut svm, step);
        let failed = result.status != "SIMULATED_OK";
        if failed {
            sequential_complete = false;
        }
        steps.push(result);
        // Everything after a failure would run against a state no trade
        // produced, so the sequence stops rather than continuing.
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


// ===================== P3: the persistent serve mode =====================
//
// The defect this removes is a TWO-PASS proof. Pass one ran the buy in runtime
// instance A to learn what it produced; the sell was built from that; pass two
// then ran buy-then-sell in a FRESH instance B. Two instances replaying the same
// buy ought to agree, but nothing checked that they did, and a sell priced
// against a state it did not execute in is not an exact sequential mechanic --
// it is an approximation that looks exactly like one.
//
// Serve mode keeps ONE runtime alive across commands, so:
//
//   init -> step(buy) -> observe(pool accounts) -> [host builds the sell from
//   THOSE bytes] -> step(sell) in the SAME runtime
//
// and the host can prove the property the directive requires:
//
//   state used to quote sell == state immediately before sell execution
//
// by comparing the account hashes returned by `observe` with the `pre_accounts`
// hashes of the sell step. Equal hashes are a proof; a fresh instance can only
// offer an assumption.
//
// The protocol is newline-delimited JSON on stdin/stdout. One command per line,
// one response per line, in order. No network: this binary opens no sockets.

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    /// Build the runtime. Carries the same payload a one-shot job does, minus
    /// the steps.
    Init(Box<Job>),
    /// Execute one transaction and COMMIT it.
    Step { step: Step },
    /// Read accounts WITHOUT executing anything, so the host can build the next
    /// transaction from the state that actually exists right now.
    Observe {
        observe: Vec<String>,
        /// F8 -- which of them the caller needs the bytes of. See `Step`.
        #[serde(default)]
        economic: Option<Vec<String>>,
    },
    /// Exit.
    Close,
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_identity: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<StepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    accounts: Option<Vec<ObservedAccount>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unobserved: Option<Vec<String>>,
    /// Hash over every account this runtime has been asked about. Lets a host
    /// detect that the runtime moved between two commands it believed adjacent.
    #[serde(skip_serializing_if = "Option::is_none")]
    state_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
}

#[derive(Debug, Serialize)]
struct RuntimeIdentity {
    runtime: String,
    runtime_version: String,
    litesvm_version: String,
    binary_sha256: String,
    programs_loaded: Vec<String>,
}

impl Response {
    fn err(msg: String) -> Self {
        Response {
            ok: false,
            error: Some(msg),
            runtime_identity: None,
            step: None,
            accounts: None,
            unobserved: None,
            state_hash: None,
            incompleteness: vec![],
            instance_id: None,
            job_output_bytes: None,
        }
    }
    fn blank() -> Self {
        Response {
            ok: true,
            error: None,
            runtime_identity: None,
            step: None,
            accounts: None,
            unobserved: None,
            state_hash: None,
            incompleteness: vec![],
            instance_id: None,
            job_output_bytes: None,
        }
    }
}

/// A hash over the accounts named, in a canonical order.
///
/// Sorted, so the caller cannot change the hash by reordering its request. This
/// is what makes "the state did not move between quote and execution" checkable
/// rather than assertable.
fn state_hash(svm: &LiteSVM, names: &[String]) -> String {
    let mut sorted: Vec<String> = names.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut h = Sha256::new();
    for name in &sorted {
        h.update(name.as_bytes());
        match name.parse::<Pubkey>().ok().and_then(|k| svm.get_account(&k)) {
            // F10 -- the whole account, via the same function the per-account
            // hash uses, so the two can never disagree about what "the state"
            // means.
            Some(a) => h.update(account_hash(name, Some(&a)).as_bytes()),
            None => h.update(account_hash(name, None).as_bytes()),
        }
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn serve() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut live: Option<LiveRuntime> = None;
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

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Response::err(format!("stdin: {e}"))).unwrap_or_default());
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Response::err(format!("bad command: {e}"))).unwrap_or_default());
                let _ = stdout.flush();
                continue;
            }
        };

        let response = match cmd {
            Command::Close => {
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Response::blank()).unwrap_or_default());
                let _ = stdout.flush();
                return;
            }
            Command::Init(job) => {
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
            }
            Command::Step { step } => match live.as_mut() {
                None => Response::err("no runtime: init first".into()),
                Some(rt) => {
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
                }
            },
            Command::Observe { observe, economic } => match live.as_ref() {
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

        // F8 -- the budget is per JOB. A process-lifetime total lets job one
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

        let _ = writeln!(stdout, "{text}");
        let _ = stdout.flush();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--serve") {
        // P3. One runtime, alive across commands, so the sell is built from the
        // state the buy committed and executed in that same runtime.
        serve();
        return;
    }
    if args.len() < 2 {
        eprintln!("usage: epitaxy-offline-worker <job.json> [result.json]");
        eprintln!("       epitaxy-offline-worker --serve      (NDJSON on stdin/stdout)");
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
