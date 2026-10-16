//! Pokenear game contract: $POKENEAR payments + on-chain randomness for card rips.
//!
//! Deployed on the Pokenear interaction wallet (pokenearfun.near).
//!
//! Rip: the Pokenear server issues a one-time 32-byte `seed`. The player calls
//! `ft_transfer_call` on the $POKENEAR token with this contract as receiver and
//! `msg = {"seed":"<64 hex>","pack":<index>,"count":<n>}`. The token calls `ft_on_transfer`,
//! which checks the amount equals the on-chain pack price x count, mixes NEAR's protocol
//! randomness (`env::random_seed()`) with the seed, the player and the block height, and
//! stores the draw under the seed. Any check failing panics, so the token refunds the player.
//! Anyone can read a draw back with `get_draw(seed)` and re-derive the cards.
//!
//! Buyback: the owner (or a function-call key on this account limited to `payout`) calls
//! `payout(receiver_id, amount, ref_id)`; each `ref_id` pays at most once.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult,
};

/// Most cards one rip can buy.
pub const MAX_PER_RIP: u8 = 5;
/// Token storage registration for a buyback receiver (refunded by the token if already registered).
const STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1250);
const GAS_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
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
    /// $POKENEAR paid, in the token's smallest unit.
    pub amount: U128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RipMsg {
    seed: String,
    pack: u8,
    count: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pokenear {
    owner: AccountId,
    /// $POKENEAR token contract. Rips are closed until it is set.
    token: Option<AccountId>,
    /// Price of one card per pack, in the token's smallest unit. Index = pack.
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
    pub fn new(owner: AccountId, token: Option<AccountId>, prices: Option<Vec<U128>>) -> Self {
        let mut c = Self {
            owner,
            token,
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

    /// Set the $POKENEAR token contract (CA).
    pub fn set_token(&mut self, token: AccountId) {
        self.assert_owner();
        self.token = Some(token);
    }

    /// Set the price of one card for each pack, in the token's smallest unit.
    pub fn set_prices(&mut self, prices: Vec<U128>) {
        self.assert_owner();
        self.check_prices(&prices);
        self.prices = prices;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    /// Pay a buyback from this account's $POKENEAR. `ref_id` (e.g. "sell:<user>:<card>") pays once.
    pub fn payout(&mut self, receiver_id: AccountId, amount: U128, ref_id: String) -> Promise {
        self.assert_owner();
        let token = self.token.clone().unwrap_or_else(|| env::panic_str("token not set"));
        require!(amount.0 > 0, "amount must be positive");
        require!(!ref_id.is_empty() && ref_id.len() <= 128, "bad ref_id");
        require!(self.payouts.insert(ref_id.clone()), "already paid");
        Promise::new(token.clone())
            .function_call(
                "storage_deposit".to_string(),
                json!({ "account_id": receiver_id, "registration_only": true }).to_string().into_bytes(),
                STORAGE_DEPOSIT,
                GAS_STORAGE,
            )
            .then(Promise::new(token).function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": receiver_id, "amount": amount, "memo": ref_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            ))
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

    /// NEP-141 receiver: a rip paid in $POKENEAR. Panics (= full refund) on any mismatch.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(self.token.as_ref() == Some(&env::predecessor_account_id()), "only $POKENEAR is accepted");
        let m: RipMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad rip message"));
        require!(is_seed(&m.seed), "seed must be 64 lowercase hex characters");
        require!(m.count >= 1 && m.count <= MAX_PER_RIP, "bad card count");
        let price = self.prices.get(m.pack as usize).unwrap_or_else(|| env::panic_str("unknown pack")).0;
        let due = price.checked_mul(m.count as u128).unwrap_or_else(|| env::panic_str("price overflow"));
        require!(amount.0 == due, "wrong amount for this pack");
        require!(!self.draws.contains_key(&m.seed), "seed already drawn");

        let height = env::block_height();
        let mut input = env::random_seed();
        input.extend_from_slice(m.seed.as_bytes());
        input.extend_from_slice(sender_id.as_bytes());
        input.extend_from_slice(&height.to_le_bytes());
        let randomness = hex(&env::sha256(&input));

        let draw = Draw {
            account: sender_id,
            randomness,
            block_height: height,
            timestamp_ms: env::block_timestamp_ms(),
            pack: m.pack,
            count: m.count,
            amount,
        };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"pokenear\",\"version\":\"2.0.0\",\"event\":\"rip\",\"data\":[{{\"seed\":\"{}\",\"account\":\"{}\",\"randomness\":\"{}\",\"pack\":{},\"count\":{},\"amount\":\"{}\",\"block_height\":{}}}]}}",
            m.seed, draw.account, draw.randomness, draw.pack, draw.count, amount.0, height
        ));
        self.draws.insert(m.seed, draw);
        self.total += 1;
        PromiseOrValue::Value(U128(0))
    }

    /* ---------- views ---------- */

    pub fn get_draw(&self, seed: String) -> Option<Draw> {
        self.draws.get(&seed).cloned()
    }

    pub fn get_config(&self) -> serde_json::Value {
        json!({ "owner": self.owner, "token": self.token, "prices": self.prices, "max_per_rip": MAX_PER_RIP })
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
    const UNIT: u128 = 1_000_000_000_000_000_000; // 18 decimals

    fn game() -> AccountId { "pokenearfun.near".parse().unwrap() }
    fn token() -> AccountId { "pokenear.tkn.near".parse().unwrap() }
    fn player() -> AccountId { accounts(1) }

    fn ctx(predecessor: AccountId, random: u8, height: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(game())
            .predecessor_account_id(predecessor)
            .random_seed([random; 32])
            .block_height(height);
        testing_env!(b.build());
    }

    fn setup() -> Pokenear {
        ctx(game(), 7, 100);
        Pokenear::new(game(), Some(token()), Some(vec![U128(1000 * UNIT), U128(2500 * UNIT)]))
    }

    fn msg(seed: &str, pack: u8, count: u8) -> String {
        format!("{{\"seed\":\"{}\",\"pack\":{},\"count\":{}}}", seed, pack, count)
    }

    fn rip(c: &mut Pokenear, seed: &str, pack: u8, count: u8, amount: u128) -> Draw {
        ctx(token(), 7, 100);
        c.ft_on_transfer(player(), U128(amount), msg(seed, pack, count));
        c.get_draw(seed.to_string()).unwrap()
    }

    #[test]
    fn paid_rip_stores_a_draw() {
        let mut c = setup();
        let d = rip(&mut c, SEED_A, 1, 5, 5 * 2500 * UNIT);
        assert_eq!(d.account, player());
        assert_eq!((d.pack, d.count, d.amount), (1, 5, U128(5 * 2500 * UNIT)));
        assert_eq!(d.block_height, 100);
        assert_eq!(c.total_draws(), 1);
        assert!(get_logs()[0].starts_with("EVENT_JSON:"));
        assert_eq!(c.get_draw(SEED_B.to_string()), None);
    }

    #[test]
    fn randomness_matches_documented_formula() {
        let mut c = setup();
        let d = rip(&mut c, SEED_A, 0, 1, 1000 * UNIT);
        let mut input = vec![7u8; 32];
        input.extend_from_slice(SEED_A.as_bytes());
        input.extend_from_slice(player().as_bytes());
        input.extend_from_slice(&100u64.to_le_bytes());
        assert_eq!(d.randomness, hex(&env::sha256(&input)));
        let e = rip(&mut c, SEED_B, 0, 1, 1000 * UNIT);
        assert_ne!(d.randomness, e.randomness);
    }

    #[test]
    #[should_panic(expected = "only $POKENEAR is accepted")]
    fn other_tokens_are_refused() {
        let mut c = setup();
        ctx(accounts(3), 7, 100);
        c.ft_on_transfer(player(), U128(1000 * UNIT), msg(SEED_A, 0, 1));
    }

    #[test]
    #[should_panic(expected = "wrong amount for this pack")]
    fn amount_must_match_price() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 1, 999 * UNIT);
    }

    #[test]
    #[should_panic(expected = "seed already drawn")]
    fn a_seed_can_only_be_drawn_once() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 1, 1000 * UNIT);
        rip(&mut c, SEED_A, 0, 1, 1000 * UNIT);
    }

    #[test]
    #[should_panic(expected = "unknown pack")]
    fn pack_must_exist() {
        let mut c = setup();
        rip(&mut c, SEED_A, 9, 1, 1000 * UNIT);
    }

    #[test]
    #[should_panic(expected = "bad card count")]
    fn count_is_limited() {
        let mut c = setup();
        rip(&mut c, SEED_A, 0, 6, 6000 * UNIT);
    }

    #[test]
    #[should_panic(expected = "seed must be 64 lowercase hex")]
    fn seed_format_is_checked() {
        let mut c = setup();
        rip(&mut c, "ABC", 0, 1, 1000 * UNIT);
    }

    #[test]
    #[should_panic(expected = "only $POKENEAR is accepted")]
    fn rips_are_closed_until_token_is_set() {
        ctx(game(), 7, 100);
        let mut c = Pokenear::new(game(), None, Some(vec![U128(1)]));
        ctx(token(), 7, 100);
        c.ft_on_transfer(player(), U128(1), msg(SEED_A, 0, 1));
    }

    #[test]
    fn owner_sets_token_and_prices() {
        ctx(game(), 7, 100);
        let mut c = Pokenear::new(accounts(0), None, None);
        ctx(accounts(0), 7, 100);
        c.set_token(token());
        c.set_prices(vec![U128(5)]);
        let cfg = c.get_config();
        assert_eq!(cfg["token"], "pokenear.tkn.near");
        assert_eq!(cfg["prices"][0], "5");
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn players_cannot_set_prices() {
        let mut c = setup();
        ctx(player(), 7, 100);
        c.set_prices(vec![U128(1)]);
    }

    #[test]
    fn payout_pays_each_ref_once() {
        let mut c = setup();
        ctx(game(), 7, 100); // function-call key on pokenearfun.near
        let _ = c.payout(player(), U128(900 * UNIT), "sell:near:bob.near:1".to_string());
        assert!(c.is_paid("sell:near:bob.near:1".to_string()));
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn payout_ref_cannot_repeat() {
        let mut c = setup();
        ctx(game(), 7, 100);
        let _ = c.payout(player(), U128(1), "sell:x".to_string());
        let _ = c.payout(player(), U128(1), "sell:x".to_string());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn players_cannot_pay_themselves() {
        let mut c = setup();
        ctx(player(), 7, 100);
        let _ = c.payout(player(), U128(1), "sell:y".to_string());
    }
}
