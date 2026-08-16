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


# ------------------------------------------------------- observe_accounts ---
sub(
    '''fn observe_accounts(svm: &LiteSVM, names: &[String]) -> (Vec<ObservedAccount>, Vec<String>) {
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
}''',
    '''/// The COMPLETE identity of one account, present or absent.
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
}''',
)

# ------------------------------------------------------------- state_hash ---
sub(
    '''            Some(a) => {
                h.update(a.lamports.to_le_bytes());
                h.update(a.owner.to_bytes());
                h.update(&a.data);
            }
            // "absent" must hash differently from "present and empty".
            None => h.update(b"<absent>"),''',
    '''            // F10 -- the whole account, via the same function the per-account
            // hash uses, so the two can never disagree about what "the state"
            // means.
            Some(a) => h.update(account_hash(name, Some(&a)).as_bytes()),
            None => h.update(account_hash(name, None).as_bytes()),''',
)

# ---------------------------------------------------------- build_runtime ---
sub(
    '''    // ---- the clock the snapshot was taken at ----------------------------
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
    }''',
    '''    // ---- F9: the sysvars, exactly as captured ---------------------------
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
    }''',
)

# --------------------------------------------------------- execute_step -----
sub(
    '''fn execute_step(svm: &mut LiteSVM, step: &Step) -> StepResult {
    let (pre_accounts, pre_missing) = observe_accounts(svm, &step.observe);''',
    '''fn execute_step(svm: &mut LiteSVM, step: &Step) -> StepResult {
    let economic: Option<HashSet<String>> =
        step.economic.as_ref().map(|e| e.iter().cloned().collect());
    let (pre_accounts, pre_missing) = observe_accounts(svm, &step.observe, economic.as_ref());''',
)

sub(
    '''    let (post_accounts, post_missing) = observe_accounts(svm, &step.observe);''',
    '''    let (post_accounts, post_missing) = observe_accounts(svm, &step.observe, economic.as_ref());''',
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('rust part 2 ok', len(orig), '->', len(s))
