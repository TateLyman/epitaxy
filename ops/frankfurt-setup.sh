#!/usr/bin/env bash
#
# Stand the bot up on a Frankfurt box.
#
# WHAT THIS ACTUALLY BUYS, measured rather than assumed. From the operator's home machine the
# endpoints we use answer in 33 ms (Jupiter), 42 ms (Helius), 71 ms (publicnode) and 157 ms
# (solanatracker), which says the machine sits close to Jupiter and Helius - almost certainly US
# East. Frankfurt will NOT fix the 571 ms concentration read that MT194 found dominates the entry
# path, because roughly 390 ms of that is server-side processing on a free endpoint and no amount
# of moving closer changes it.
#
# What Frankfurt does buy is the write path and the tail. Glassnode's probe network puts Frankfurt
# at 25.9% of leader slots, Amsterdam 21.0% and London 12.4% - about two thirds of all blocks are
# produced in Europe - so a transaction submitted from Frankfurt reaches the leader far sooner than
# one crossing the Atlantic first. And an independent measurement of real JSON-RPC round trips from
# an Amsterdam box shows jitter of 18 to 103 ms against regional differences of only 7 ms, which is
# the real argument: a datacentre removes residential jitter, Wi-Fi drops and ISP reroutes, and p95
# is what decides whether a transaction lands.
#
# THE DECISION THIS SCRIPT DOES NOT MAKE FOR YOU. Running here means the trading keypair lives on a
# cloud VM. That is a genuine change in risk posture from a machine you physically control: anyone
# with the instance, a snapshot of its disk, or the project's IAM can sign with that key. It is a
# reasonable trade for a wallet holding a fraction of a SOL and an unreasonable one for a wallet
# holding real money. Decide deliberately, and keep the balance to what you would accept losing.
#
# Sizing: an e2-medium is 1 shared vCPU and 4 GB, which is fine for the bot - it is a websocket
# listener with a few RPC calls per position - but NOT enough for the backtests, which need 12 to
# 14 GB. Keep research on the home machine.
#
# Usage on the box:  bash frankfurt-setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-analysis/low-capital-profit-path}"
DIR="${DIR:-$HOME/tradseee}"

echo "== 1. verify we are actually where we think we are =="
# The whole point is location, so confirm it rather than trusting the console.
curl -s --max-time 10 https://ipinfo.io/json | grep -E '"(city|region|country|org)"' || echo "  (ipinfo unreachable; check manually)"

echo
echo "== 2. round trip to every endpoint the bot uses =="
# This is the measurement that justifies the move. Compare it against the home numbers:
#   jupiter 33ms   helius 42ms   publicnode 71ms   solanatracker 157ms
for host in api.jup.ag mainnet.helius-rpc.com solana-rpc.publicnode.com rpc.solanatracker.io; do
  t=$( { curl -s -o /dev/null -w '%{time_connect}' --max-time 10 "https://$host" || echo "0"; } )
  printf '  %-32s %s ms (tcp connect)\n' "$host" "$(awk -v x="$t" 'BEGIN{printf "%.0f", x*1000}')"
done

echo
echo "== 3. node and pnpm =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version
command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm
pnpm --version

echo
echo "== 4. the repository =="
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --all --quiet && git -C "$DIR" checkout "$BRANCH" --quiet && git -C "$DIR" pull --quiet
else
  if [ -z "$REPO_URL" ]; then
    echo "  set REPO_URL=<git remote> and re-run, or copy the working tree across yourself"
    exit 1
  fi
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"
pnpm install --frozen-lockfile

echo
echo "== 5. what you still have to supply by hand =="
# Deliberately not automated. Secrets do not belong in a script that lives in the repository, and
# the keypair in particular should be a conscious act rather than a side effect of running setup.
cat <<'NOTE'
  .env needs, at minimum:
    HELIUS_API_KEY=...            (or RPC_HTTP / RPC_HTTP_FALLBACK)
    JUPITER_API_KEY=...
    TRADING_KEYPAIR_PATH=/home/<user>/.config/solana/trading.json

  The keypair file must be copied across separately, over SSH, and chmod 600.
  Nothing in this repository will read it except the signer.

  Then confirm the box agrees with the home machine before trading:
    npx tsx scripts/entry-timing.ts --mode=observe
    npx tsx scripts/auto-trade.ts --mode=observe --max-positions=2 --sol=0.05

  The dry run must show a feed connecting and candidates being judged. Only then:
    npx tsx scripts/auto-trade.ts --mode=canary --max-positions=25 --sol=0.05 --apply
NOTE

echo
echo "== 6. keep it running after you disconnect =="
cat <<'NOTE'
  A plain ssh session dies with the terminal and takes an open position with it. Use tmux:
    tmux new -s bot
    npx tsx scripts/auto-trade.ts --mode=canary --max-positions=25 --sol=0.05 --apply
    # detach with ctrl-b then d, reattach with: tmux attach -t bot

  To stop it safely from anywhere, without finding the process:
    touch data/STOP
  That halts at the next safe point rather than mid-position, so it cannot strand a bag.
NOTE
