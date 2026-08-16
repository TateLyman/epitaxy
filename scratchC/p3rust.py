# -*- coding: utf-8 -*-
import io, sys

p = 'offline-worker/src/main.rs'
s = io.open(p, encoding='utf-8').read()
orig = s


def sub(old, new, n=1):
    global s
    if s.count(old) < 1:
        print('MISS:', old[:90].replace('\n', ' | '))
        sys.exit(1)
    s = s.replace(old, new, n)


# ---------------------------------------------------------------- imports ---
sub(
    "use std::io::{BufRead, Read, Write};",
    "use std::collections::HashSet;\nuse std::io::{BufRead, Read, Write};",
)

sub(
    "use solana_sdk::clock::Clock;",
    "use solana_sdk::clock::Clock;\nuse solana_sdk::epoch_schedule::EpochSchedule;\nuse solana_sdk::rent::Rent;",
)

# ------------------------------------------------------------ u64 as text ---
sub(
    "/// A program, with its ACTUAL executable bytes.",
    '''/// F7 -- every u64 and i64 on this wire is a DECIMAL STRING.
///
/// JSON has exactly one number type and it is an IEEE double. `rent_epoch` for
/// a rent-exempt account is u64::MAX, and through a double that returns as
/// 18446744073709552000 -- a value the chain never produced, differing from the
/// truth by 1615. Nothing raises; both ends agree on a wrong number.
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

/// A program, with its ACTUAL executable bytes.''',
)

# --------------------------------------------------------- SnapshotAccount ---
sub(
    """struct SnapshotAccount {
    pubkey: String,
    data_base64: String,
    owner: String,
    lamports: u64,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    rent_epoch: u64,
}""",
    """struct SnapshotAccount {
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
}""",
)

# -------------------------------------------------------------------- Step ---
sub(
    """struct Step {
    label: String,
    transaction_base64: String,
    /// Accounts whose state the caller wants before and after THIS step.
    #[serde(default)]
    observe: Vec<String>,
}""",
    """struct Step {
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
}""",
)

# --------------------------------------------------------------------- Job ---
sub(
    """struct Job {
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
}""",
    """struct Job {
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
}""",
)

# --------------------------------------------------------- ObservedAccount ---
sub(
    """struct ObservedAccount {
    pubkey: String,
    lamports: u64,
    owner: String,
    data_base64: String,
    data_sha256: String,
}""",
    """struct ObservedAccount {
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
}""",
)

# ------------------------------------------------------------- StepResult ---
sub(
    """    transaction_error: Option<String>,
    compute_units_consumed: Option<u64>,
    logs: Vec<String>,
    pre_accounts: Vec<ObservedAccount>,""",
    """    transaction_error: Option<String>,
    #[serde(serialize_with = "u64s::ser_opt")]
    compute_units_consumed: Option<u64>,
    logs: Vec<String>,
    pre_accounts: Vec<ObservedAccount>,""",
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('rust part 1 ok', len(orig), '->', len(s))
