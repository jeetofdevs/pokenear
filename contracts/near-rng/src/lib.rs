//! Pokenear game contract: NEAR payments + on-chain randomness for card rips.
//!
//! Deployed on the Pokenear interaction wallet (pokenearfun.near).
//!
//! Rip: the Pokenear server issues a one-time 32-byte `seed` and quotes the price from the live NEAR
//! price. The player calls `rip({seed, pack, count})` attaching that amount. If fixed prices are set
//! on chain the amount must equal price x count; otherwise any amount >= MIN_RIP is accepted and the
//! server checks it against its quote before giving cards. The
//! contract mixes NEAR's protocol randomness (`env::random_seed()`) with the seed, the player and
//! the block height, stores the draw under the seed, and forwards the NEAR to the treasury
//! (pokenear.near) in the same transaction. Any check failing panics, so the player's NEAR is
//! returned. Anyone can read a draw back with `get_draw(seed)` and re-derive the cards.
//!
//! Buyback: the owner (or a function-call key on this account limited to `payout`) calls
//! `payout(receiver_id, amount, ref_id)`; it pays NEAR from this account and each `ref_id` pays once.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

/// Most cards one rip can buy.
pub const MAX_PER_RIP: u8 = 5;
/// Smallest rip payment when prices follow the live quote; also covers the draw's storage.
pub const MIN_RIP: NearToken = NearToken::from_millinear(100);
/// NEAR kept on the account on top of its storage stake, so payouts never break the contract.
pub const RESERVE: NearToken = NearToken::from_millinear(500);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Draws,
    Payouts,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    /// Player who paid for the rip.
    pub account: AccountId,
    /// 32 bytes of randomness, hex encoded.
    pub randomness: String,
    pub block_height: u64,
    pub timestamp_ms: u64,
    pub pack: u8,
    pub count: u8,
    /// NEAR paid, in yoctoNEAR.
    pub amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pokenear {
    owner: AccountId,
    /// Where rip payments are forwarded (pokenear.near).
    treasury: AccountId,
    /// Fixed price of one card per pack, in yoctoNEAR. Index = pack. Empty = live quotes.
    prices: Vec<U128>,
    draws: LookupMap<String, Draw>,
    payouts: LookupSet<String>,
    total: u64,
}

fn is_seed(seed: &str) -> bool {
    seed.len() == 64 && seed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[near]
impl Pokenear {
    #[init]
    pub fn new(owner: AccountId, treasury: AccountId, prices: Option<Vec<U128>>) -> Self {
        let mut c = Self {
            owner,
            treasury,
            prices: vec![],
            draws: LookupMap::new(Key::Draws),
            payouts: LookupSet::new(Key::Payouts),
            total: 0,
        };
        if let Some(p) = prices {
            c.check_prices(&p);
            c.prices = p;
        }
        c
    }

    /* ---------- owner ---------- */

    /// Fix the price of one card for each pack, in yoctoNEAR. An empty list goes back to live quotes.
    pub fn set_prices(&mut self, prices: Vec<U128>) {
        self.assert_owner();
        if !prices.is_empty() {
            self.check_prices(&prices);
        }
        self.prices = prices;
    }

    /// Change where rip payments go.
    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.assert_owner();
        self.treasury = treasury;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    /// Pay a buyback in NEAR from this account. `ref_id` (e.g. "sell:<hash>") pays once.
    pub fn payout(&mut self, receiver_id: AccountId, amount: U128, ref_id: String) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        require!(!ref_id.is_empty() && ref_id.len() <= 128, "bad ref_id");
        let locked = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let free = env::account_balance().as_yoctonear().saturating_sub(locked + RESERVE.as_yoctonear());
        require!(amount.0 <= free, "not enough NEAR for this payout");
        require!(self.payouts.insert(ref_id.clone()), "already paid");
        Promise::new(receiver_id)
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_payout(ref_id))
    }

    /// Frees the ref again if the transfer failed, so the payout can be retried.
    #[private]
    pub fn on_payout(&mut self, ref_id: String) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !ok {
            self.payouts.remove(&ref_id);
        }
        ok
    }

    /* ---------- player ---------- */

    /// A rip paid in NEAR. Attach exactly price[pack] x count. Panics (= full refund) on any mismatch.
    #[payable]
    pub fn rip(&mut self, seed: String, pack: u8, count: u8) -> Draw {
        let amount = env::attached_deposit().as_yoctonear();
        require!(is_seed(&seed), "seed must be 64 lowercase hex characters");
        require!(count >= 1 && count <= MAX_PER_RIP, "bad card count");
        if self.prices.is_empty() {
            // Live-quoted prices: the server checks the exact amount; this only blocks dust spam.
            require!(pack < 16, "unknown pack");
            require!(amount >= MIN_RIP.as_yoctonear(), "attach at least 0.1 NEAR");
        } else {
            let price = self.prices.get(pack as usize).unwrap_or_else(|| env::panic_str("unknown pack")).0;
            let due = price.checked_mul(count as u128).unwrap_or_else(|| env::panic_str("price overflow"));
            require!(amount == due, "wrong amount for this pack");
        }
        require!(!self.draws.contains_key(&seed), "seed already drawn");

        let account = env::predecessor_account_id();
        let height = env::block_height();
        let mut input = env::random_seed();
        input.extend_from_slice(seed.as_bytes());
        input.extend_from_slice(account.as_bytes());
        input.extend_from_slice(&height.to_le_bytes());
        let randomness = hex(&env::sha256(&input));

        let draw = Draw { account, randomness, block_height: height, timestamp_ms: env::block_timestamp_ms(), pack, count, amount: U128(amount) };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"pokenear\",\"version\":\"3.0.0\",\"event\":\"rip\",\"data\":[{{\"seed\":\"{}\",\"account\":\"{}\",\"randomness\":\"{}\",\"pack\":{},\"count\":{},\"amount\":\"{}\",\"block_height\":{}}}]}}",
            seed, draw.account, draw.randomness, pack, count, amount, height
        ));
        self.draws.insert(seed, draw.clone());
        self.total += 1;
        // The payment goes straight to the treasury.
        let _ = Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(amount));
        draw
    }

    /* ---------- views ---------- */

    pub fn get_draw(&self, seed: String) -> Option<Draw> {
        self.draws.get(&seed).cloned()
    }

    pub fn get_config(&self) -> serde_json::Value {
        json!({ "owner": self.owner, "treasury": self.treasury, "prices": self.prices, "max_per_rip": MAX_PER_RIP, "currency": "NEAR" })
    }

    pub fn is_paid(&self, ref_id: String) -> bool {
        self.payouts.contains(&ref_id)
    }

    pub fn total_draws(&self) -> u64 {
        self.total
    }
}

impl Pokenear {
    fn assert_owner(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.owner || p == env::current_account_id(), "owner only");
    }

    fn check_prices(&self, prices: &[U128]) {
        require!(!prices.is_empty() && prices.len() <= 16, "1 to 16 packs");
        require!(prices.iter().all(|p| p.0 > 0), "prices must be positive");
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const SEED_A: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
    const SEED_B: &str = "bb00000000000000000000000000000000000000000000000000000000000002";
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn game() -> AccountId { "pokenearfun.near".parse().unwrap() }
    fn treasury() -> AccountId { "pokenear.near".parse().unwrap() }
    fn player() -> AccountId { accounts(1) }

    fn ctx(predecessor: AccountId, deposit: u128, random: u8, height: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(game())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(10))
            .random_seed([random; 32])
            .block_height(height);
        testing_env!(b.build());
    }

    fn setup() -> Pokenear {
        ctx(game(), 0, 7, 100);
        Pokenear::new(game(), treasury(), Some(vec![U128(4 * NEAR), U128(10 * NEAR)]))
    }

    fn rip(c: &mut Pokenear, seed: &str, pack: u8, count: u8, deposit: u128) -> Draw {
        ctx(player(), deposit, 7, 100);
        c.rip(seed.to_string(), pack, count)
    }

    #[test]
    fn paid_rip_stores_a_draw() {
        let mut c = setup();
        let d = rip(&mut c, SEED_A, 1, 5, 50 * NEAR);
        assert_eq!(d.account, player());
        assert_eq!((d.pack, d.count, d.amount), (1, 5, U128(50 * NEAR)));
        assert_eq!(c.get_draw(SEED_A.to_string()), Some(d));
        assert_eq!(c.total_draws(), 1);
        assert!(get_logs()[0].starts_with("EVENT_JSON:"));
        assert_eq!(c.get_draw(SEED_B.to_string()), None);
        assert_eq!(c.get_config()["treasury"], "pokenear.near");
    }

    #[test]
    fn payment_is_forwarded_to_the_treasury() {
        let mut c = setup();
        rip(&mut c, SEED_A, 1, 2, 20 * NEAR);
        let receipts = near_sdk::test_utils::get_created_receipts();
        let to_treasury: Vec<_> = receipts.iter().filter(|r| r.receiver_id == treasury()).collect();
        assert_eq!(to_treasury.len(), 1, "{:?}", receipts);
        let shown = format!("{:?}", to_treasury[0].actions);
        assert!(shown.contains("Transfer") && shown.contains(&(20 * NEAR).to_string()), "{}", shown);
    }

    #[test]
    fn randomness_matches_documented_formula() {
        let mut c = setup();
        let d = rip(&mut c, SEED_A, 0, 1, 4 * NEAR);
        let mut input = vec![7u8; 32];
        input.extend_from_slice(SEED_A.as_bytes());
        input.extend_from_slice(player().as_bytes());
        input.extend_from_slice(&100u64.to_le_bytes());
        assert_eq!(d.randomness, hex(&env::sha256(&input)));
        assert_ne!(d.randomness, rip(&mut c, SEED_B, 0, 1, 4 * NEAR).randomness);
    }

    #[test]
    #[should_panic(expected = "wrong amount for this pack")]
    fn amount_must_match_price() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 1, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "seed already drawn")]
    fn a_seed_can_only_be_drawn_once() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 1, 4 * NEAR);
        rip(&mut c, SEED_A, 0, 1, 4 * NEAR);
    }

    #[test]
    #[should_panic(expected = "unknown pack")]
    fn pack_must_exist() {
        let mut c = setup();
        rip(&mut c, SEED_A, 9, 1, 4 * NEAR);
    }

    #[test]
    #[should_panic(expected = "bad card count")]
    fn count_is_limited() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 6, 24 * NEAR);
    }

    #[test]
    #[should_panic(expected = "seed must be 64 lowercase hex")]
    fn seed_format_is_checked() {
        let mut c = setup();
        rip(&mut c, "ABC", 0, 1, 4 * NEAR);
    }

    #[test]
    fn without_fixed_prices_any_quote_is_accepted() {
        ctx(game(), 0, 7, 100);
        let mut c = Pokenear::new(game(), treasury(), None);
        let d = rip(&mut c, SEED_A, 3, 5, 12_345 * NEAR / 1000);
        assert_eq!(d.amount, U128(12_345 * NEAR / 1000));
    }

    #[test]
    #[should_panic(expected = "attach at least 0.1 NEAR")]
    fn dust_rips_are_refused() {
        ctx(game(), 0, 7, 100);
        let mut c = Pokenear::new(game(), treasury(), None);
        rip(&mut c, SEED_A, 0, 1, NEAR / 100);
    }

    #[test]
    fn prices_can_go_back_to_live_quotes() {
        let mut c = setup();
        ctx(game(), 0, 7, 100);
        c.set_prices(vec![]);
        assert_eq!(rip(&mut c, SEED_A, 0, 1, NEAR / 2).amount, U128(NEAR / 2));
    }

    #[test]
    fn owner_sets_prices_and_treasury() {
        ctx(game(), 0, 7, 100);
        let mut c = Pokenear::new(accounts(0), treasury(), None);
        ctx(accounts(0), 0, 7, 100);
        c.set_prices(vec![U128(5)]);
        c.set_treasury(accounts(2));
        let cfg = c.get_config();
        assert_eq!(cfg["prices"][0], "5");
        assert_eq!(cfg["treasury"], accounts(2).to_string());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn players_cannot_change_the_treasury() {
        let mut c = setup();
        ctx(player(), 0, 7, 100);
        c.set_treasury(player());
    }

    #[test]
    fn payout_pays_each_ref_once() {
        let mut c = setup();
        ctx(game(), 0, 7, 100); // function-call key on pokenearfun.near
        let _ = c.payout(player(), U128(NEAR), "sell:abc".to_string());
        assert!(c.is_paid("sell:abc".to_string()));
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn payout_ref_cannot_repeat() {
        let mut c = setup();
        ctx(game(), 0, 7, 100);
        let _ = c.payout(player(), U128(1), "sell:x".to_string());
        let _ = c.payout(player(), U128(1), "sell:x".to_string());
    }

    #[test]
    #[should_panic(expected = "not enough NEAR for this payout")]
    fn payout_keeps_the_reserve() {
        let mut c = setup();
        ctx(game(), 0, 7, 100); // balance 10 NEAR
        let _ = c.payout(player(), U128(10 * NEAR), "sell:big".to_string());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn players_cannot_pay_themselves() {
        let mut c = setup();
        ctx(player(), 0, 7, 100);
        let _ = c.payout(player(), U128(1), "sell:y".to_string());
    }
}
